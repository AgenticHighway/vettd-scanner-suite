import {describe, expect, it, vi} from "vitest";

import type {ScannerInput, ScannerOutput, SkillScanner} from "../../../contract/scanner.js";
import {logger} from "../../../logger.js";
import {JobExecutor} from "../executor.js";
import {InMemoryJobStore, type JobStore} from "../store.js";

const input: ScannerInput = {textFiles: new Map(), allPaths: []};

function successOutput(id: string): ScannerOutput {
	return {
		findings: [],
		run: {
			source: id,
			status: "success",
			findingCount: 0,
			criticalCount: 0,
			highCount: 0,
			scannedAt: new Date(),
		},
	};
}

function makeScanner(id: string, scan: () => Promise<ScannerOutput>): SkillScanner {
	return {id, available: async () => true, scan};
}

describe("JobExecutor", () => {
	it("submit returns a queued job synchronously", () => {
		const store = new InMemoryJobStore();
		const executor = new JobExecutor({
			store,
			scanners: [makeScanner("alpha", async () => successOutput("alpha"))],
			scannerTimeoutMs: 5000,
			maxConcurrent: 2,
		});
		const job = executor.submit(input);
		expect(job.id).toBeTruthy();
		expect(store.get(job.id)).toBeDefined();
	});

	it("runs a submitted job to completion with results attached", async () => {
		const store = new InMemoryJobStore();
		const executor = new JobExecutor({
			store,
			scanners: [makeScanner("alpha", async () => successOutput("alpha"))],
			scannerTimeoutMs: 5000,
			maxConcurrent: 2,
		});
		const job = executor.submit(input);
		await executor.idle();
		const done = store.get(job.id)!;
		expect(done.status).toBe("completed");
		expect(done.results).toHaveLength(1);
		expect(done.results![0].run.source).toBe("alpha");
		expect(done.startedAt).toBeInstanceOf(Date);
		expect(done.finishedAt).toBeInstanceOf(Date);
	});

	// maxConcurrent is the OOM guard for the whole service — a second job
	// starting while the first still runs would defeat it.
	it("maxConcurrent=1 serializes jobs", async () => {
		const events: string[] = [];
		let releaseFirst!: () => void;
		const firstGate = new Promise<void>((resolve) => {
			releaseFirst = resolve;
		});
		let call = 0;
		const scanner = makeScanner("slow", async () => {
			const n = ++call;
			events.push(`start${n}`);
			if (n === 1) await firstGate;
			events.push(`end${n}`);
			return successOutput("slow");
		});
		const store = new InMemoryJobStore();
		const executor = new JobExecutor({store, scanners: [scanner], scannerTimeoutMs: 5000, maxConcurrent: 1});

		executor.submit(input);
		executor.submit(input);

		await vi.waitFor(() => expect(events).toContain("start1"));
		expect(events).not.toContain("start2");

		releaseFirst();
		await executor.idle();
		expect(events).toEqual(["start1", "end1", "start2", "end2"]);
	});

	// runScanners never throws, so "failed" is reserved for infrastructure
	// surprises — those must land as a failed job, not an unhandled rejection.
	it("marks the job failed when infrastructure throws", async () => {
		const logSpy = vi.spyOn(logger, "error").mockImplementation(() => {});
		const real = new InMemoryJobStore();
		const throwingStore: JobStore = {
			create: () => real.create(),
			get: (id) => real.get(id),
			transition: (id, status, opts) => real.transition(id, status, opts),
			attachResults: () => {
				throw new Error("disk full");
			},
		};
		const executor = new JobExecutor({
			store: throwingStore,
			scanners: [makeScanner("alpha", async () => successOutput("alpha"))],
			scannerTimeoutMs: 5000,
			maxConcurrent: 1,
		});
		const job = executor.submit(input);
		await executor.idle();
		expect(real.get(job.id)!.status).toBe("failed");
		expect(real.get(job.id)!.error).toBe("disk full");
		expect(logSpy).toHaveBeenCalled();
		logSpy.mockRestore();
	});
});
