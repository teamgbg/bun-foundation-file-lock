/**
 * @system file-lock
 * @status handwritten
 * @edit edit directly
 *
 * The single sanctioned file-locking surface (constitution
 * `file-lock-is-the-only-file-lock`). A lock is an atomic lockfile holding the
 * holder PID (not flock(2) — see doctrine). Acquire writes the PID to a
 * process-unique temp file, then atomically `link()`s it into place — so the
 * lockfile NEVER exists in a PID-less state. Stale-reclaim breaks both a
 * dead-PID lockfile and a PID-less/empty one.
 *
 * Why link-from-temp (incident 2026-07-02): the prior acquire was
 * `open(path, "wx")` [creates an EMPTY file] then `writeFile(pid)` in a second
 * step. A holder killed in the window between those syscalls orphaned an EMPTY
 * lockfile, and stale-reclaim was dead-PID-only (gated on `holder !== null`) —
 * `readHolderPid` parses the empty contents as NaN → returns null → reclaim
 * never fires → every subsequent caller polled 180s then timed out. One such
 * orphan starved the whole fleet's restart lock for ~50min. link-from-temp
 * makes the lockfile appear atomically WITH the PID already inside (link is the
 * atomic test-and-create-with-content), so a PID-less lockfile is now
 * structurally impossible; the broadened reclaim also clears any pre-existing
 * PID-less orphan left by an old-version holder during rollout.
 *
 * Released in a finally and on graceful process exit; unexpected deaths are
 * reclaimed by the next caller's stale check.
 */

import { linkSync } from "node:fs";
import { rm, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileLockRegistry } from "./registry.ts";
import type { LockOptions } from "./types.ts";

function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		// ESRCH = no such process (dead). EPERM = exists but not signalable (alive).
		return (err as NodeJS.ErrnoException).code === "EPERM";
	}
}

async function readHolderPid(lockPath: string): Promise<number | null> {
	try {
		const raw = await Bun.file(lockPath).text();
		const pid = Number.parseInt(raw.trim(), 10);
		return Number.isFinite(pid) && pid > 0 ? pid : null;
	} catch {
		return null;
	}
}

export async function withFileLock<T>(
	path: string,
	opts: LockOptions,
	fn: () => Promise<T>,
): Promise<T> {
	const { timeoutMs, pollIntervalMs = 50, stalePidCheck = true } = opts;

	// Disabled locks (registry/config override) run the critical section without
	// serialising — transparent fall-through, mirroring cache/spawn disable.
	if (fileLockRegistry.isDisabled(path)) return fn();

	// Temp lives in the lock's own dir so link()'s source and target share one
	// filesystem (hardlinks cannot cross mount boundaries). Name is unique per
	// invocation (pid + nanos + random), so concurrent acquirers never collide.
	const temp = join(
		dirname(path),
		`.scala-lock-tmp.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}`,
	);

	const deadline = Date.now() + timeoutMs;
	try {
		for (;;) {
			// Write the PID to the temp file FIRST (exclusively), then atomically
			// link it into place. On success the lockfile appears with the PID
			// already inside; on EEXIST it is held and we fall through to the
			// stale check.
			await writeFile(temp, String(process.pid), { flag: "wx" });
			let acquired = false;
			try {
				linkSync(temp, path); // atomic: EEXIST iff path already exists
				acquired = true;
			} catch (err) {
				if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
			} finally {
				// path (if linked) is an independent hardlink now; removing temp
				// never disturbs a linked lockfile's contents.
				await unlink(temp).catch(() => {});
			}
			if (acquired) break;

			// Lock is held. Break it if the holder is dead OR PID-less. Under
			// link-from-temp a live holder ALWAYS links a PID in, so a PID-less
			// (empty/unreadable) lockfile is definitively a stale orphan — the
			// prior bug class that starved the fleet when a holder died
			// mid-acquire and left an empty file the dead-PID check couldn't break.
			if (stalePidCheck) {
				const holder = await readHolderPid(path);
				if (holder === null || !isAlive(holder)) {
					await unlink(path).catch(() => {});
					continue; // retry immediately
				}
			}
			if (Date.now() >= deadline) {
				throw new Error(
					`@teamscala/file-lock: timed out acquiring "${path}" after ${timeoutMs}ms`,
				);
			}
			await Bun.sleep(pollIntervalMs);
		}
	} catch (err) {
		// Never leak a temp across a throw (e.g. write/link failure).
		await unlink(temp).catch(() => {});
		throw err;
	}

	fileLockRegistry.register(path, process.pid);
	// Release on graceful exit. SIGKILL/crash leaves the file → reclaimed by the
	// next caller's stale check. (No signal-shutdown phase: sibling-primitive
	// horizontal dep is forbidden.)
	const onExit = async (): Promise<void> => {
		try {
			await rm(path);
		} catch {
			/* already gone */
		}
	};
	process.once("exit", onExit);
	try {
		return await fn();
	} finally {
		process.removeListener("exit", onExit);
		await unlink(path).catch(() => {});
		fileLockRegistry.unregister(path);
	}
}
