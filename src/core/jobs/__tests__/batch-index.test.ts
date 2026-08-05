import {afterEach, describe, expect, it, vi} from "vitest";

import {BatchIndex, BatchIndexFullError} from "../batch-index.js";

describe("BatchIndex", () => {
	afterEach(() => vi.useRealTimers());

	it("create/get round-trip: starts with empty accepted/rejected and a submission time", () => {
		const index = new BatchIndex();
		const batch = index.create();
		expect(batch.submittedAt).toBeInstanceOf(Date);
		expect(batch.accepted).toEqual([]);
		expect(batch.rejected).toEqual([]);
		expect(index.get(batch.id)).toBe(batch);
	});

	it("get returns undefined for unknown ids", () => {
		expect(new BatchIndex().get("nope")).toBeUndefined();
	});

	// The index must not sort, dedupe, or renumber — index fidelity to the
	// caller's original array is the whole contract a batch poll depends on.
	it("attach preserves the given order and contents", () => {
		const index = new BatchIndex();
		const batch = index.create();
		const accepted = [
			{index: 0, jobId: "a"},
			{index: 2, jobId: "c"},
		];
		const rejected = [{index: 1, error: "bad item"}];
		index.attach(batch.id, accepted, rejected);
		const stored = index.get(batch.id);
		expect(stored?.accepted).toEqual(accepted);
		expect(stored?.rejected).toEqual(rejected);
	});

	// A lost batch is a bug in the route (attach must always follow a create
	// for the same id) — fail loud, mirroring JobStore.mustGet.
	it("attach on an unknown id throws", () => {
		expect(() => new BatchIndex().attach("nope", [], [])).toThrow(/unknown batch/);
	});

	// The index is in-memory — without eviction it grows until OOM. TTL runs
	// from submittedAt on a fixed clock, not from any notion of completion.
	it("evicts batches past the TTL on the next create", () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-07-07T00:00:00Z"));
		const index = new BatchIndex();
		const batch = index.create();
		vi.setSystemTime(new Date("2026-07-07T01:00:01Z"));
		index.create();
		expect(index.get(batch.id)).toBeUndefined();
	});

	// Sweep must run before the cap check, mirroring JobStore.create — the
	// reverse order would deadlock the service at the cap even once entries
	// are stale and could have been reclaimed.
	it("sweeps before the cap check, so a full-but-stale index self-heals", () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-07-07T00:00:00Z"));
		const index = new BatchIndex();
		for (let i = 0; i < 1000; i++) index.create();
		vi.setSystemTime(new Date("2026-07-07T01:00:01Z"));
		expect(() => index.create()).not.toThrow();
	});

	it("throws BatchIndexFullError at the absolute cap", () => {
		const index = new BatchIndex();
		for (let i = 0; i < 1000; i++) index.create();
		expect(() => index.create()).toThrow(BatchIndexFullError);
	});
});
