// @system codegen
// @status generated
// @edit change the suite in the owned-suites band, then re-run codegen. Hand-edits are overwritten.
//
// This suite's assertions are OWNED by the codegen band: the band module
// carries them verbatim, this file is the emission, and hand edits here are
// overwritten on the next run. The rationale each assertion carries moved
// with it into the band.

import { withBoundedSemaphore } from "./with-bounded-semaphore.ts";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

async function freshBase(): Promise<string> {
	return join(await mkdtemp(join(tmpdir(), "sem-")), "gate");
}

describe("withBoundedSemaphore", () => {
	test("concurrency<1 disables gating (fn runs free)", async () => {
		let ran = false;
		await withBoundedSemaphore(freshBase(), { concurrency: 0, timeoutMs: 100 }, async () => {
			ran = true;
		});
		expect(ran).toBe(true);
	});

	test("K=1 serialises (mutex behaviour — max 1 concurrent)", async () => {
		const base = await freshBase();
		let inFlight = 0;
		let maxSeen = 0;
		const fn = async (): Promise<void> => {
			inFlight++;
			maxSeen = Math.max(maxSeen, inFlight);
			await Bun.sleep(30);
			inFlight--;
		};
		await Promise.all(
			Array.from({ length: 4 }, () => withBoundedSemaphore(base, { concurrency: 1, timeoutMs: 10_000 }, fn)),
		);
		expect(maxSeen).toBe(1);
	});

	test("K=2 allows 2 concurrent, never more", async () => {
		const base = await freshBase();
		let inFlight = 0;
		let maxSeen = 0;
		const fn = async (): Promise<void> => {
			inFlight++;
			maxSeen = Math.max(maxSeen, inFlight);
			await Bun.sleep(40);
			inFlight--;
		};
		await Promise.all(
			Array.from({ length: 6 }, () => withBoundedSemaphore(base, { concurrency: 2, timeoutMs: 10_000 }, fn)),
		);
		expect(maxSeen).toBe(2);
	});

	test("failOpen: a caller whose budget exceeds the hold runs UNGATED (never blocks)", async () => {
		const base = await freshBase();
		// Hold the single slot for 150ms.
		const slow = withBoundedSemaphore(base, { concurrency: 1, timeoutMs: 10_000 }, async () => {
			await Bun.sleep(150);
		});
		await Bun.sleep(15); // let `slow` acquire the slot
		let ranUngated = false;
		// Second caller: 40ms budget < 150ms hold → must fail-open + run fn.
		const result = await withBoundedSemaphore(
			base,
			{ concurrency: 1, timeoutMs: 40, pollIntervalMs: 10 },
			async () => {
				ranUngated = true;
				return "ok";
			},
		);
		expect(result).toBe("ok");
		expect(ranUngated).toBe(true);
		await slow;
	});

	test("failOpen:false THROWS on budget exceeded (correctness mode)", async () => {
		const base = await freshBase();
		const slow = withBoundedSemaphore(base, { concurrency: 1, timeoutMs: 10_000 }, async () => {
			await Bun.sleep(150);
		});
		await Bun.sleep(15);
		await expect(
			withBoundedSemaphore(
				base,
				{ concurrency: 1, timeoutMs: 40, pollIntervalMs: 10, failOpen: false },
				async () => "should-not-run",
			),
		).rejects.toThrow(/timed out acquiring a slot/);
		await slow;
	});
});
