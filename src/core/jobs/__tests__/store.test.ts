import {afterEach, describe, expect, it, vi} from "vitest";

import type {ScannerOutput} from "../../../contract/scanner.js";
import {InMemoryJobStore, JobStoreFullError} from "../store.js";

const output: ScannerOutput = {
	findings: [],
	run: {
		source: "vettd",
		status: "success",
		findingCount: 0,
		criticalCount: 0,
		highCount: 0,
		scannedAt: new Date(),
	},
};

describe("InMemoryJobStore", () => {
	afterEach(() => vi.useRealTimers());

	it("create/get round-trip: job starts queued with a submission time", () => {
		const store = new InMemoryJobStore();
		const job = store.create();
		expect(job.status).toBe("queued");
		expect(job.submittedAt).toBeInstanceOf(Date);
		expect(store.get(job.id)).toBe(job);
	});

	it("get returns undefined for unknown ids", () => {
		expect(new InMemoryJobStore().get("nope")).toBeUndefined();
	});

	it("legal transitions stamp startedAt/finishedAt", () => {
		const store = new InMemoryJobStore();
		const job = store.create();
		store.transition(job.id, "running");
		expect(job.startedAt).toBeInstanceOf(Date);
		store.attachResults(job.id, [output]);
		store.transition(job.id, "completed");
		expect(job.finishedAt).toBeInstanceOf(Date);
		expect(job.results).toEqual([output]);
	});

	it("failed transition records the error", () => {
		const store = new InMemoryJobStore();
		const job = store.create();
		store.transition(job.id, "running");
		store.transition(job.id, "failed", {error: "boom"});
		expect(job.status).toBe("failed");
		expect(job.error).toBe("boom");
	});

	// Illegal transitions are executor bugs — they must crash the operation,
	// not silently corrupt job state.
	it("throws on illegal transitions", () => {
		const store = new InMemoryJobStore();
		const job = store.create();
		expect(() => store.transition(job.id, "completed")).toThrow(/illegal/);
		store.transition(job.id, "running");
		store.transition(job.id, "completed");
		expect(() => store.transition(job.id, "running")).toThrow(/illegal/);
	});

	it("throws when transitioning an unknown job", () => {
		expect(() => new InMemoryJobStore().transition("nope", "running")).toThrow(/unknown job/);
	});

	it("attachResults requires a running job", () => {
		const store = new InMemoryJobStore();
		const job = store.create();
		expect(() => store.attachResults(job.id, [output])).toThrow(/queued/);
	});

	// The store is in-memory — without eviction it grows until OOM. Finished
	// jobs must disappear after the TTL; polling one then 404s and callers
	// resubmit (same story as a restart).
	it("evicts finished jobs after the TTL on the next create", () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-07-07T00:00:00Z"));
		const store = new InMemoryJobStore();
		const job = store.create();
		store.transition(job.id, "running");
		store.transition(job.id, "completed");
		vi.setSystemTime(new Date("2026-07-07T01:00:01Z"));
		store.create();
		expect(store.get(job.id)).toBeUndefined();
	});

	// An in-flight scan must never vanish out from under the executor.
	it("never evicts queued or running jobs", () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-07-07T00:00:00Z"));
		const store = new InMemoryJobStore();
		const queued = store.create();
		const running = store.create();
		store.transition(running.id, "running");
		vi.setSystemTime(new Date("2026-07-07T05:00:00Z"));
		store.create();
		expect(store.get(queued.id)).toBeDefined();
		expect(store.get(running.id)).toBeDefined();
	});

	it("throws JobStoreFullError at the absolute cap", () => {
		const store = new InMemoryJobStore();
		for (let i = 0; i < 1000; i++) store.create();
		expect(() => store.create()).toThrow(JobStoreFullError);
	});
});
