import {describe, expect, it, vi} from "vitest";

import type {ScannerOutput, SkillScanner} from "../../contract/scanner.js";
import {BatchIndex} from "../../core/jobs/batch-index.js";
import {JobExecutor} from "../../core/jobs/executor.js";
import {InMemoryJobStore} from "../../core/jobs/store.js";
import {buildApp} from "../app.js";

function fakeOutput(id: string): ScannerOutput {
	return {
		findings: [{category: "security", label: "l", detail: "d", severity: "low", source: id}],
		run: {
			source: id,
			status: "success",
			findingCount: 1,
			criticalCount: 0,
			highCount: 0,
			scannedAt: new Date(),
		},
	};
}

const fakeScanner: SkillScanner = {
	id: "fake",
	available: async () => true,
	scan: async () => fakeOutput("fake"),
};

function makeApp(opts: {scanners?: SkillScanner[]; maxConcurrent?: number; maxBatchItems?: number} = {}) {
	const {scanners = [fakeScanner], maxConcurrent = 2, maxBatchItems = 50} = opts;
	const store = new InMemoryJobStore();
	const batches = new BatchIndex();
	const executor = new JobExecutor({store, scanners, scannerTimeoutMs: 5000, maxConcurrent});
	const app = buildApp({store, executor, batches, maxBatchItems});
	return {app, store, executor, batches};
}

const sampleBody = {
	textFiles: {"SKILL.md": "# Skill"},
	allPaths: ["SKILL.md"],
};

// A distinct, valid item for batch tests — index-suffixed so tests can
// correlate which item a scanner run or a rejection belongs to.
function item(n: number) {
	return {textFiles: {[`item-${n}.md`]: `# item ${n}`}, allPaths: [`item-${n}.md`]};
}

// Builds one item whose total text is `byteSize` bytes, spread across files
// that each stay under MAX_TEXT_FILE_BYTES (4 MB) so only the total-text
// guard (not the per-file guard) can reject it.
function itemWithTotalTextBytes(byteSize: number, prefix: string) {
	const perFile = 3_100_000;
	const textFiles: Record<string, string> = {};
	const allPaths: string[] = [];
	let remaining = byteSize;
	let i = 0;
	while (remaining > 0) {
		const size = Math.min(perFile, remaining);
		const path = `${prefix}-${i}.txt`;
		textFiles[path] = "x".repeat(size);
		allPaths.push(path);
		remaining -= size;
		i++;
	}
	return {textFiles, allPaths};
}

// A scanner whose scan() blocks until released, so concurrency tests can
// assert exactly how many jobs are in-flight without racing real timers.
// Mirrors the gated idiom in core/jobs/__tests__/executor.test.ts.
function makeGatedScanner() {
	const started: string[] = [];
	const releases = new Map<string, () => void>();
	const scanner: SkillScanner = {
		id: "gated",
		available: async () => true,
		scan: async (input) => {
			const key = input.allPaths[0];
			started.push(key);
			await new Promise<void>((resolve) => releases.set(key, resolve));
			return fakeOutput(key);
		},
	};
	return {
		scanner,
		started,
		release: (key: string) => {
			releases.get(key)?.();
		},
	};
}

describe("GET /health", () => {
	it("responds 200 ok", async () => {
		const {app} = makeApp();
		const res = await app.inject({method: "GET", url: "/health"});
		expect(res.statusCode).toBe(200);
		expect(res.json()).toEqual({ok: true});
	});
});

describe("POST /scans", () => {
	it("accepts a JSON body and responds 202 with a job id", async () => {
		const {app, store} = makeApp();
		const res = await app.inject({
			method: "POST",
			url: "/scans",
			payload: JSON.stringify(sampleBody),
			headers: {"content-type": "application/json"},
		});
		expect(res.statusCode).toBe(202);
		const body = res.json() as {jobId: string; status: string};
		expect(body.status).toBe("queued");
		expect(store.get(body.jobId)).toBeDefined();
	});

	// Malformed bodies must fail the submit itself — the caller should never
	// have to poll to find out their JSON was rejected.
	it("responds 400 for invalid JSON", async () => {
		const {app} = makeApp();
		const res = await app.inject({
			method: "POST",
			url: "/scans",
			payload: "not json",
			headers: {"content-type": "application/json"},
		});
		expect(res.statusCode).toBe(400);
		expect((res.json() as {error: string}).error).toContain("malformed");
	});

	it("responds 400 for an empty body", async () => {
		const {app} = makeApp();
		const res = await app.inject({
			method: "POST",
			url: "/scans",
			payload: "",
			headers: {"content-type": "application/json"},
		});
		expect(res.statusCode).toBe(400);
	});

	it("responds 415 for an unregistered content type", async () => {
		const {app} = makeApp();
		const res = await app.inject({
			method: "POST",
			url: "/scans",
			payload: "<zip/>",
			headers: {"content-type": "application/xml"},
		});
		expect(res.statusCode).toBe(415);
	});

	it("responds 400 for a JSON body missing textFiles", async () => {
		const {app} = makeApp();
		const res = await app.inject({
			method: "POST",
			url: "/scans",
			payload: JSON.stringify({allPaths: ["SKILL.md"]}),
			headers: {"content-type": "application/json"},
		});
		expect(res.statusCode).toBe(400);
		expect((res.json() as {error: string}).error).toContain("textFiles");
	});

	it("responds 400 when allPaths exceeds MAX_FILES", async () => {
		const {app} = makeApp();
		const excess = Array.from({length: 501}, (_, i) => `file-${i}.txt`);
		const textFiles: Record<string, string> = {};
		for (const f of excess) textFiles[f] = "x";
		const res = await app.inject({
			method: "POST",
			url: "/scans",
			payload: JSON.stringify({textFiles, allPaths: excess}),
			headers: {"content-type": "application/json"},
		});
		expect(res.statusCode).toBe(400);
		expect((res.json() as {error: string}).error).toContain("500");
	});

	it("responds 400 when a text file exceeds MAX_TEXT_FILE_BYTES", async () => {
		const {app} = makeApp();
		const big = "x".repeat(4 * 1024 * 1024 + 1);
		const res = await app.inject({
			method: "POST",
			url: "/scans",
			payload: JSON.stringify({textFiles: {"big.txt": big}, allPaths: ["big.txt"]}),
			headers: {"content-type": "application/json"},
		});
		expect(res.statusCode).toBe(400);
		expect((res.json() as {error: string}).error).toContain("exceeds");
	});

	it("responds 400 when total text exceeds MAX_TOTAL_TEXT_BYTES", async () => {
		const {app} = makeApp();
		// Stay under MAX_FILES (500) with 499 files of ~34 KB each -> ~16.9 MB
		// total, over MAX_TOTAL_TEXT_BYTES (16 MB). Each file is well under the
		// 4 MB per-file limit so the per-file guard does not trigger first.
		const chunks: Record<string, string> = {};
		const chunkSize = 34_000;
		for (let i = 0; i < 499; i++) {
			chunks[`part-${i}.txt`] = "x".repeat(chunkSize);
		}
		const allPaths = Object.keys(chunks);
		const res = await app.inject({
			method: "POST",
			url: "/scans",
			payload: JSON.stringify({textFiles: chunks, allPaths}),
			headers: {"content-type": "application/json"},
		});
		expect(res.statusCode).toBe(400);
		expect((res.json() as {error: string}).error).toContain("exceeds");
	});
});

describe("GET /scans/:id", () => {
	it("responds 404 for unknown ids", async () => {
		const {app} = makeApp();
		const res = await app.inject({method: "GET", url: "/scans/does-not-exist"});
		expect(res.statusCode).toBe(404);
		expect((res.json() as {error: string}).error).toBe("job not found");
	});

	it("returns the completed-job envelope with results and ISO timestamps", async () => {
		const {app, executor} = makeApp();
		const submit = await app.inject({
			method: "POST",
			url: "/scans",
			payload: JSON.stringify(sampleBody),
			headers: {"content-type": "application/json"},
		});
		const {jobId} = submit.json() as {jobId: string};
		await executor.idle();

		const res = await app.inject({method: "GET", url: `/scans/${jobId}`});
		expect(res.statusCode).toBe(200);
		const body = res.json() as {
			id: string;
			status: string;
			submittedAt: string;
			startedAt: string;
			finishedAt: string;
			results: ScannerOutput[];
			error?: string;
		};
		expect(body.id).toBe(jobId);
		expect(body.status).toBe("completed");
		expect(body.results).toHaveLength(1);
		expect(body.results[0].run.source).toBe("fake");
		// Dates serialize as ISO-8601 strings over HTTP (documented contract).
		for (const field of [body.submittedAt, body.startedAt, body.finishedAt]) {
			expect(field).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
		}
		expect(body.error).toBeUndefined();
	});
});

describe("POST /scans/batch", () => {
	it("accepts N items and returns N index-aligned, distinct jobIds", async () => {
		const {app, store} = makeApp();
		const res = await app.inject({
			method: "POST",
			url: "/scans/batch",
			payload: JSON.stringify({items: [item(0), item(1), item(2)]}),
			headers: {"content-type": "application/json"},
		});
		expect(res.statusCode).toBe(202);
		const body = res.json() as {accepted: {index: number; jobId: string}[]; rejected: unknown[]};
		expect(body.rejected).toEqual([]);
		expect(body.accepted.map((a) => a.index)).toEqual([0, 1, 2]);
		const jobIds = body.accepted.map((a) => a.jobId);
		expect(new Set(jobIds).size).toBe(3);
		for (const jobId of jobIds) expect(store.get(jobId)).toBeDefined();
	});

	// Decision: one bad item must not sink its siblings. The completion
	// assertion is what fails if a regression short-circuits the loop on the
	// first rejection instead of continuing past it.
	it("rejects a malformed item by index while siblings queue and complete", async () => {
		const {app, store, executor} = makeApp();
		const res = await app.inject({
			method: "POST",
			url: "/scans/batch",
			payload: JSON.stringify({items: [item(0), {allPaths: "nope"}, item(2)]}),
			headers: {"content-type": "application/json"},
		});
		expect(res.statusCode).toBe(202);
		const body = res.json() as {
			accepted: {index: number; jobId: string}[];
			rejected: {index: number; error: string}[];
		};
		expect(body.accepted.map((a) => a.index)).toEqual([0, 2]);
		expect(body.rejected).toEqual([{index: 1, error: expect.stringContaining("allPaths")}]);

		await executor.idle();
		for (const {jobId} of body.accepted) {
			expect(store.get(jobId)?.status).toBe("completed");
		}
	});

	// Every index in [0, n) must appear exactly once across accepted+rejected
	// — a client with neither a jobId nor an error for index k has no way to
	// learn item k was dropped.
	it("covers every submitted index exactly once across accepted and rejected", async () => {
		const {app} = makeApp();
		const res = await app.inject({
			method: "POST",
			url: "/scans/batch",
			payload: JSON.stringify({items: [item(0), {allPaths: "nope"}, item(2), {textFiles: 1}]}),
			headers: {"content-type": "application/json"},
		});
		const body = res.json() as {
			accepted: {index: number}[];
			rejected: {index: number}[];
		};
		const seen = [...body.accepted, ...body.rejected].map((x) => x.index).sort((a, b) => a - b);
		expect(seen).toEqual([0, 1, 2, 3]);
	});

	// Structural errors must not leave partial work behind — a bad envelope
	// queues nothing.
	it.each([
		["non-object body", "null"],
		["missing items", "{}"],
		["items not an array", '{"items": "nope"}'],
		["items empty", '{"items": []}'],
	])("responds 400 and queues nothing for %s", async (_label, payload) => {
		const {app, store} = makeApp();
		const res = await app.inject({
			method: "POST",
			url: "/scans/batch",
			payload,
			headers: {"content-type": "application/json"},
		});
		expect(res.statusCode).toBe(400);
		expect((res.json() as {error: string}).error).toContain("malformed body");
		expect(store.get("anything")).toBeUndefined();
	});

	it("responds 400 for a batch over maxBatchItems, using the configured cap", async () => {
		const {app} = makeApp({maxBatchItems: 2});
		const res = await app.inject({
			method: "POST",
			url: "/scans/batch",
			payload: JSON.stringify({items: [item(0), item(1), item(2)]}),
			headers: {"content-type": "application/json"},
		});
		expect(res.statusCode).toBe(400);
		expect((res.json() as {error: string}).error).toContain("limit: 2");
	});

	it("responds 400 for an empty body and unparseable JSON, 415 for the wrong content type", async () => {
		const {app} = makeApp();

		const empty = await app.inject({method: "POST", url: "/scans/batch", payload: "", headers: {"content-type": "application/json"}});
		expect(empty.statusCode).toBe(400);

		const malformed = await app.inject({
			method: "POST",
			url: "/scans/batch",
			payload: "not json",
			headers: {"content-type": "application/json"},
		});
		expect(malformed.statusCode).toBe(400);
		expect((malformed.json() as {error: string}).error).toContain("malformed");

		const wrongType = await app.inject({method: "POST", url: "/scans/batch", payload: "<zip/>", headers: {"content-type": "application/xml"}});
		expect(wrongType.statusCode).toBe(415);
	});

	// A full job store must reject only the items it cannot take — the loop
	// must continue past the first JobStoreFullError, not abort the batch.
	// 999 (not 1000) is what lets this test fail if that regresses.
	it("rejects only the items a nearly-full job store cannot take", async () => {
		const {app, store} = makeApp();
		for (let i = 0; i < 999; i++) store.create();

		const res = await app.inject({
			method: "POST",
			url: "/scans/batch",
			payload: JSON.stringify({items: [item(0), item(1), item(2)]}),
			headers: {"content-type": "application/json"},
		});
		expect(res.statusCode).toBe(202);
		const body = res.json() as {
			accepted: {index: number}[];
			rejected: {index: number; error: string}[];
		};
		expect(body.accepted).toHaveLength(1);
		expect(body.rejected).toHaveLength(2);
		for (const r of body.rejected) expect(r.error).toMatch(/job store is full/);
	});

	// The 16 MB total-text cap is per item, not per batch.
	it("rejects one item over the per-item text-size cap while its small sibling queues", async () => {
		const {app} = makeApp();
		const res = await app.inject({
			method: "POST",
			url: "/scans/batch",
			payload: JSON.stringify({items: [itemWithTotalTextBytes(16_900_000, "big"), item(0)]}),
			headers: {"content-type": "application/json"},
		});
		expect(res.statusCode).toBe(202);
		const body = res.json() as {
			accepted: {index: number}[];
			rejected: {index: number; error: string}[];
		};
		expect(body.rejected).toEqual([{index: 0, error: expect.stringContaining("exceeds")}]);
		expect(body.accepted).toEqual([{index: 1, jobId: expect.any(String), status: expect.any(String)}]);
	});

	// Encodes the decision that MAX_TOTAL_TEXT_BYTES bounds one job's input
	// and the 20 MB bodyLimit bounds the whole batch — two items that each
	// individually stay under 16 MB, but sum past it, must both be accepted.
	it("accepts two items whose combined text exceeds one item's total-text cap", async () => {
		const {app} = makeApp();
		const res = await app.inject({
			method: "POST",
			url: "/scans/batch",
			payload: JSON.stringify({
				items: [itemWithTotalTextBytes(9_300_000, "a"), itemWithTotalTextBytes(9_300_000, "b")],
			}),
			headers: {"content-type": "application/json"},
		});
		expect(res.statusCode).toBe(202);
		const body = res.json() as {accepted: unknown[]; rejected: unknown[]};
		expect(body.rejected).toEqual([]);
		expect(body.accepted).toHaveLength(2);
	});
});

describe("GET /scans/batch/:id", () => {
	it("responds 404 with a batch-specific message for an unknown id", async () => {
		const {app} = makeApp();
		const res = await app.inject({method: "GET", url: "/scans/batch/does-not-exist"});
		expect(res.statusCode).toBe(404);
		expect((res.json() as {error: string}).error).toBe("batch not found");
	});

	// Decision: the batch poll never inlines results — Cisco's rawReport is
	// multi-MB and this route is hit on an interval. The exact-keys assertion
	// fails loudly if anyone adds a field.
	it("never includes results — status-only entries", async () => {
		const {app, executor} = makeApp();
		const submit = await app.inject({
			method: "POST",
			url: "/scans/batch",
			payload: JSON.stringify({items: [item(0)]}),
			headers: {"content-type": "application/json"},
		});
		const {batchId} = submit.json() as {batchId: string};
		await executor.idle();

		const res = await app.inject({method: "GET", url: `/scans/batch/${batchId}`});
		const body = res.json() as {accepted: Record<string, unknown>[]};
		expect(Object.keys(body.accepted[0]).sort()).toEqual(["index", "jobId", "status"]);
	});

	// A cached status would strand a poller on "queued" forever — status must
	// be joined live from the store on every GET, not snapshotted at attach.
	it("joins status live: queued/running before idle, completed after", async () => {
		const {app, executor} = makeApp();
		const submit = await app.inject({
			method: "POST",
			url: "/scans/batch",
			payload: JSON.stringify({items: [item(0)]}),
			headers: {"content-type": "application/json"},
		});
		const {batchId} = submit.json() as {batchId: string};

		const before = await app.inject({method: "GET", url: `/scans/batch/${batchId}` });
		const beforeBody = before.json() as {accepted: {status: string}[]};
		expect(["queued", "running"]).toContain(beforeBody.accepted[0].status);

		await executor.idle();
		const after = await app.inject({method: "GET", url: `/scans/batch/${batchId}` });
		const afterBody = after.json() as {accepted: {status: string}[]};
		expect(afterBody.accepted[0].status).toBe("completed");
	});

	it("returns rejected entries unchanged from the submit response", async () => {
		const {app} = makeApp();
		const submit = await app.inject({
			method: "POST",
			url: "/scans/batch",
			payload: JSON.stringify({items: [item(0), {allPaths: "nope"}]}),
			headers: {"content-type": "application/json"},
		});
		const submitBody = submit.json() as {batchId: string; rejected: unknown[]};

		const res = await app.inject({method: "GET", url: `/scans/batch/${submitBody.batchId}` });
		const body = res.json() as {rejected: unknown[]};
		expect(body.rejected).toEqual(submitBody.rejected);
	});

	// A job swept by the store's TTL must render as "expired", not "queued" —
	// rendering it as "queued" would spin a poller forever. Built directly
	// against the batch index because forcing a real 1h sweep isn't practical
	// here (see core/jobs/__tests__/batch-index.test.ts for that).
	it("renders a job the store no longer knows about as expired", async () => {
		const {app, batches} = makeApp();
		const batch = batches.create();
		batches.attach(batch.id, [{index: 0, jobId: "not-in-store"}], []);

		const res = await app.inject({method: "GET", url: `/scans/batch/${batch.id}` });
		const body = res.json() as {accepted: {status: string}[]};
		expect(body.accepted[0].status).toBe("expired");
	});

	// Known, benign path overlap: GET /scans/batch (no id) has 2 segments,
	// same as GET /scans/:id, and falls through to the job route's 404.
	it("GET /scans/batch with no id falls through to the job route's 404", async () => {
		const {app} = makeApp();
		const res = await app.inject({method: "GET", url: "/scans/batch"});
		expect(res.statusCode).toBe(404);
		expect((res.json() as {error: string}).error).toBe("job not found");
	});
});

describe("batch concurrency", () => {
	// Issue #21's core acceptance criterion: batch intake must not get its own
	// concurrency lane. A Promise.all-style regression starts all 4 at once
	// and fails the second assertion; a regression that starts 0 hangs the
	// first vi.waitFor.
	it("drains a batch through the same maxConcurrent as single submissions", async () => {
		const gated = makeGatedScanner();
		const {app} = makeApp({scanners: [gated.scanner], maxConcurrent: 2});

		const submitPromise = app.inject({
			method: "POST",
			url: "/scans/batch",
			payload: JSON.stringify({items: [item(0), item(1), item(2), item(3)]}),
			headers: {"content-type": "application/json"},
		});

		await vi.waitFor(() => expect(gated.started.length).toBe(2));
		expect(gated.started.length).toBe(2);

		gated.release("item-0.md");
		await vi.waitFor(() => expect(gated.started.length).toBe(3));

		gated.release("item-1.md");
		gated.release("item-2.md");
		gated.release("item-3.md");
		await submitPromise;
	});

	// FIFO submission order is what lets a client reason about progress —
	// items must enter the executor's queue in the order they were submitted.
	it("submits items to the executor in item order", async () => {
		const gated = makeGatedScanner();
		const {app} = makeApp({scanners: [gated.scanner], maxConcurrent: 1});

		const submitPromise = app.inject({
			method: "POST",
			url: "/scans/batch",
			payload: JSON.stringify({items: [item(0), item(1), item(2)]}),
			headers: {"content-type": "application/json"},
		});

		await vi.waitFor(() => expect(gated.started).toEqual(["item-0.md"]));
		gated.release("item-0.md");
		await vi.waitFor(() => expect(gated.started).toEqual(["item-0.md", "item-1.md"]));
		gated.release("item-1.md");
		await vi.waitFor(() => expect(gated.started).toEqual(["item-0.md", "item-1.md", "item-2.md"]));
		gated.release("item-2.md");
		await submitPromise;
	});
});
