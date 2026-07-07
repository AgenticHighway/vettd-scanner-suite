import JSZip from "jszip";
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

async function zipBody(files: Record<string, string>): Promise<Buffer> {
	const zip = new JSZip();
	for (const [path, content] of Object.entries(files)) zip.file(path, content);
	return zip.generateAsync({type: "nodebuffer"});
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
	it("accepts a zip and responds 202 with a job id", async () => {
		const {app, store} = makeApp();
		const res = await app.inject({
			method: "POST",
			url: "/scans",
			payload: await zipBody({"SKILL.md": "# Skill"}),
			headers: {"content-type": "application/zip"},
		});
		expect(res.statusCode).toBe(202);
		const body = res.json() as {jobId: string; status: string};
		expect(body.status).toBe("queued");
		expect(store.get(body.jobId)).toBeDefined();
	});

	// Bad archives must fail the submit itself — the caller should never
	// have to poll to find out their upload was unreadable.
	it("responds 400 for a body that is not a zip", async () => {
		const {app} = makeApp();
		const res = await app.inject({
			method: "POST",
			url: "/scans",
			payload: Buffer.from("not a zip"),
			headers: {"content-type": "application/zip"},
		});
		expect(res.statusCode).toBe(400);
		expect((res.json() as {error: string}).error).toContain("zip");
	});

	it("responds 400 for an empty body", async () => {
		const {app} = makeApp();
		const res = await app.inject({
			method: "POST",
			url: "/scans",
			payload: Buffer.alloc(0),
			headers: {"content-type": "application/zip"},
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

	// fastify parses text/plain natively (string body) — that lands in the
	// same not-a-buffer 400 as JSON, not a 415.
	it("responds 400 for a text/plain body", async () => {
		const {app} = makeApp();
		const res = await app.inject({
			method: "POST",
			url: "/scans",
			payload: "hello",
			headers: {"content-type": "text/plain"},
		});
		expect(res.statusCode).toBe(400);
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
			payload: await zipBody({"SKILL.md": "# Skill"}),
			headers: {"content-type": "application/zip"},
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
