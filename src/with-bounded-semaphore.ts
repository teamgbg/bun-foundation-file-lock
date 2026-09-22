/**
 * @system file-lock
 * @status handwritten
 * @edit edit directly
 *
 * Host-wide bounded-concurrency gate (a counting semaphore over K lockfile
 * "slots"), built on withFileLock. At most `concurrency` holders run the
 * critical section concurrently ACROSS THE WHOLE HOST — the thundering-herd
 * gate for frequent-but-heavy work (e.g. publish-time tsgo/smoke builds) where
 * a full mutex (K=1) would over-serialise and violate iteration-speed-budget,
 * yet N concurrent lane pushes stacking the heavy step saturates the host
 * (the 2026-07-18 load-42 publish-build storm).
 *
 * Mechanism: K slot lockfiles (`<basePath>.0.lock` ... `<basePath>.K-1.lock`),
 * each a standard PID-lockfile (stale-PID reclaim built into withFileLock, so a
 * crashed holder's slot is reclaimed by the next sweeper — no permanent slot
 * leak). Acquire sweeps the slots with non-blocking tries (withFileLock
 * `timeoutMs:0` = one try, throws immediately if held); the first free slot
 * runs `fn` and releases in finally. If every slot is busy, the sweeper sleeps
 * `pollIntervalMs` and retries until `timeoutMs`, then FAIL-OPENs (runs `fn`
 * without a slot, logging) — this is a thundering-herd OPTIMISATION, never a
 * correctness gate: a waiter is delayed, never blocked/503'd. Fail-open is the
 * load-shedding escape so a stuck/dead slot can never permanently stall a publish.
 *
 * Why slots not a counter file: each slot is a PID-lockfile, so withFileLock's
 * dead-PID + PID-less stale reclaim handles holder crashes for FREE — a counter
 * file would need its own crash-consistent decrement/reclaim logic (the
 * "incremented then crashed → count permanently inflated → semaphore drained"
 * class). Slots trade K lockfiles for crash-safety-by-reuse-of-withFileLock.
 *
 * Sibling of withFileLock (the K=1 case is exactly withFileLock); pairs with
 * restart-drivers-serialize-via-lock + client-asset-builds-serialize-via-lock
 * (both K=1 mutexes) as the bounded-K generalisation for the build-storm arm of
 * no-uncontrolled-repetition-or-cascade.
 */
import { getAppLogger } from "@teamscala/logger/app-loggers";
import { withFileLock } from "./with-lock.ts";
import type { LockOptions } from "./types.ts";

export interface BoundedSemaphoreOptions {
	/** Max concurrent holders host-wide (K). <1 disables gating (fn runs free). */
	concurrency: number;
	/** Total budget to wait for a free slot before fail-open. */
	timeoutMs: number;
	/** Poll interval between full slot sweeps when all slots are busy. */
	pollIntervalMs?: number;
	/** If true (default), run fn WITHOUT a slot once the budget is exceeded
	 * (thundering-herd optimisation, never a correctness gate). If false, throw. */
	failOpen?: boolean;
	/** Forwarded to each slot's withFileLock (stale-reclaim control). */
	stalePidCheck?: boolean;
}

/**
 * Run `fn` under a host-wide bounded-concurrency gate. At most `concurrency`
 * callers run fn concurrently across the whole host; the rest wait (polled) up
 * to `timeoutMs`, then fail-open (or throw if `failOpen:false`).
 */
export async function withBoundedSemaphore<T>(
	basePath: string,
	opts: BoundedSemaphoreOptions,
	fn: () => Promise<T>,
): Promise<T> {
	const {
		concurrency,
		timeoutMs,
		pollIntervalMs = 50,
		failOpen = true,
		stalePidCheck = true,
	} = opts;
	if (concurrency < 1) return fn();
	const deadline = Date.now() + timeoutMs;
	const slotOpts: LockOptions = { timeoutMs: 0, pollIntervalMs, stalePidCheck };
	for (;;) {
		for (let slot = 0; slot < concurrency; slot++) {
			const slotPath = `${basePath}.${slot}.lock`;
			try {
				// timeoutMs:0 = one non-blocking try. If the slot is FREE,
				// withFileLock acquires it, runs fn, releases in finally, returns.
				// If BUSY, withFileLock throws "timed out acquiring" immediately.
				return await withFileLock(slotPath, slotOpts, fn);
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				if (!msg.includes("timed out acquiring")) throw err;
				// slot busy → try the next slot
			}
		}
		if (Date.now() >= deadline) {
			if (failOpen) {
				getAppLogger().warn(
					`@teamscala/file-lock: withBoundedSemaphore("${basePath}") all ${concurrency} slot(s) busy after ${timeoutMs}ms — fail-open (thundering-herd optimisation, not a correctness gate)`,
				);
				return fn();
			}
			throw new Error(
				`@teamscala/file-lock: withBoundedSemaphore("${basePath}") timed out acquiring a slot after ${timeoutMs}ms (${concurrency} slot(s) busy)`,
			);
		}
		await Bun.sleep(pollIntervalMs);
	}
}
