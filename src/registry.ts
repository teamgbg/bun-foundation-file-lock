/**
 * @system file-lock
 * @status handwritten
 * @edit edit directly
 */

import type { ActiveLockInfo } from "./types.ts";

class FileLockRegistryImpl {
	private readonly active = new Map<
		string,
		{ pid: number; heldSinceMs: number }
	>();
	private readonly disabled = new Set<string>();

	register(path: string, pid: number): void {
		this.active.set(path, { pid, heldSinceMs: Date.now() });
	}

	unregister(path: string): void {
		this.active.delete(path);
	}

	getAll(): ActiveLockInfo[] {
		const now = Date.now();
		return Array.from(this.active.entries()).map(
			([path, { pid, heldSinceMs }]) => ({
				path,
				pid,
				heldSinceMs,
				ageMs: now - heldSinceMs,
			}),
		);
	}

	disable(path: string): void {
		this.disabled.add(path);
	}

	enable(path: string): void {
		this.disabled.delete(path);
	}

	isDisabled(path: string): boolean {
		return this.disabled.has(path);
	}
}

export const fileLockRegistry = new FileLockRegistryImpl();
