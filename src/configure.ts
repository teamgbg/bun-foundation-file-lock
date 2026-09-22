/**
 * @system file-lock
 * @status handwritten
 * @edit edit directly
 */

import { fileLockRegistry } from "./registry.ts";
import type { LockConfig } from "./types.ts";

let defaultTimeoutMs = 60_000;

export function configure(opts: LockConfig): void {
	if (typeof opts.defaultTimeoutMs === "number") {
		defaultTimeoutMs = opts.defaultTimeoutMs;
	}
	if (opts.overrides) {
		for (const [path, override] of Object.entries(opts.overrides)) {
			if (override.enabled === false) {
				fileLockRegistry.disable(path);
			} else if (override.enabled === true) {
				fileLockRegistry.enable(path);
			}
		}
	}
}

export function getDefaultTimeoutMs(): number {
	return defaultTimeoutMs;
}
