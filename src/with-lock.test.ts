// @system codegen
// @status generated
// @edit change the suite in the owned-suites band, then re-run codegen. Hand-edits are overwritten.
//
// This suite's assertions are OWNED by the codegen band: the band module
// carries them verbatim, this file is the emission, and hand edits here are
// overwritten on the next run. The rationale each assertion carries moved
// with it into the band.

import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { withFileLock } from "./with-lock.ts";

const dir = await mkdtemp(join(tmpdir(), "filelock-"));
let n = 0;
const lockPath = (): string => join(dir, `t${n++}.lock`);

describe("@teamscala/file-lock", () => {
	test("acquires, runs fn, releases", async () => {
		const p = lockPath();
		const r = await withFileLock(p, { timeoutMs: 1000 }, async () => 42);
		expect(r).toBe(42);
		expect((await Bun.file(p).exists())).toBe(false);
	});

	test("serialises: a second acquire times out while the first is held", async () => {
		const p = lockPath();
		let release!: () => void;
		const held = new Promise<void>((res) => {
			release = res;
		});
		const first = withFileLock(p, { timeoutMs: 2000 }, async () => {
			await held;
		});
		await new Promise((r) => setTimeout(r, 50)); // let first acquire
		await expect(
			withFileLock(p, { timeoutMs: 150, pollIntervalMs: 20 }, async () => "x"),
		).rejects.toThrow(/timed out/);
		release();
		await first;
		expect((await Bun.file(p).exists())).toBe(false);
	});

	test("breaks a stale lock (dead holder PID)", async () => {
		const p = lockPath();
		await Bun.file(p).write("2000000000"); // nonexistent pid
		const r = await withFileLock(
			p,
			{ timeoutMs: 1000 },
			async () => "over-stale",
		);
		expect(r).toBe("over-stale");
	});

	test("breaks a PID-less (empty) stale lock — the 2026-07-02 orphan class", async () => {
		// An empty lockfile is what a holder killed between `open(wx)` and
		// `writeFile(pid)` left under the prior acquire. dead-PID-only reclaim
		// could not break it (readHolderPid parsed "" as NaN → null), starving
		// the fleet. link-from-temp makes it unwritable; the broadened reclaim
		// also clears any pre-existing empty orphan.
		const p = lockPath();
		await Bun.file(p).write("");
		const r = await withFileLock(
			p,
			{ timeoutMs: 1000 },
			async () => "over-empty-stale",
		);
		expect(r).toBe("over-empty-stale");
		expect((await Bun.file(p).exists())).toBe(false);
	});

	test("breaks a corrupt (non-PID) stale lock", async () => {
		const p = lockPath();
		await Bun.file(p).write("not-a-pid");
		const r = await withFileLock(
			p,
			{ timeoutMs: 1000 },
			async () => "over-corrupt",
		);
		expect(r).toBe("over-corrupt");
		expect((await Bun.file(p).exists())).toBe(false);
	});

	test("releases on throw", async () => {
		const p = lockPath();
		await expect(
			withFileLock(p, { timeoutMs: 1000 }, async () => {
				throw new Error("boom");
			}),
		).rejects.toThrow("boom");
		expect((await Bun.file(p).exists())).toBe(false);
	});
});
