import {describe, expect, it} from "vitest";

import type {ScannerOutput, SkillScanner} from "../../contract/scanner.js";
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

function makeApp(scanners: SkillScanner[] = [fakeScanner]) {
	const store = new InMemoryJobStore();
	const executor = new JobExecutor({store, scanners, scannerTimeoutMs: 5000, maxConcurrent: 2});
	const app = buildApp({store, executor});
	return {app, store, executor};
}

const sampleBody = {
	textFiles: {"SKILL.md": "# Skill"},
	allPaths: ["SKILL.md"],
};

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
	it("responds 400 for invalid JSON (Fastify parse error)", async () => {
		const {app} = makeApp();
		const res = await app.inject({
			method: "POST",
			url: "/scans",
			payload: "not json",
			headers: {"content-type": "application/json"},
		});
		expect(res.statusCode).toBe(400);
		// Fastify parses application/json natively — invalid JSON is a 400
		// from the framework before our handler ever sees the body.
		const body = res.json() as {message?: string; statusCode?: number};
		expect(body.statusCode).toBe(400);
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
