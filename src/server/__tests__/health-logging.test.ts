// Issue #25: GET /health is hit every ~10s (Docker HEALTHCHECK, adapter
// availability polls). Fastify's automatic request/response logs for it must
// not land at info level — they flood operator logs with entries that carry
// no operational value. Non-health routes must KEEP their info-level request
// logs, or an "everything quiet" regression would silently strip the logs
// operators actually rely on.
//
// The shared logger module is swapped for a capture-destination pino so each
// emitted line (level included) is inspectable. Level formatter mirrors
// src/logger.ts so captured entries read like production output.

import {beforeEach, describe, expect, it, vi} from "vitest";

const capture = vi.hoisted(() => ({
	entries: [] as {level: string; msg?: string; url?: string}[],
}));

vi.mock("../../logger.js", async () => {
	const pino = (await import("pino")).default;
	const logger = pino(
		{
			level: "debug",
			formatters: {level: (label: string) => ({level: label})},
		},
		{
			write: (line: string) => {
				const entry = JSON.parse(line) as {level: string; msg?: string; url?: string};
				capture.entries.push(entry);
			},
		},
	);
	return {logger};
});

import type {ScannerOutput, SkillScanner} from "../../contract/scanner.js";
import {BatchIndex} from "../../core/jobs/batch-index.js";
import {JobExecutor} from "../../core/jobs/executor.js";
import {InMemoryJobStore} from "../../core/jobs/store.js";
import {buildApp} from "../app.js";

const fakeScanner: SkillScanner = {
	id: "fake",
	available: async () => true,
	scan: async (): Promise<ScannerOutput> => ({
		findings: [],
		run: {
			source: "fake",
			status: "success",
			findingCount: 0,
			criticalCount: 0,
			highCount: 0,
			scannedAt: new Date(),
		},
	}),
};

function makeApp() {
	const store = new InMemoryJobStore();
	const batches = new BatchIndex();
	const executor = new JobExecutor({store, scanners: [fakeScanner], scannerTimeoutMs: 5000, maxConcurrent: 2});
	return buildApp({store, executor, batches, maxBatchItems: 50});
}

function infoEntries() {
	return capture.entries.filter((e) => e.level === "info");
}

beforeEach(() => {
	capture.entries.length = 0;
});

describe("health check request logging (#25)", () => {
	// The flood this issue reports: ~6 health hits/minute each emitting
	// "incoming request" + "request completed" at info. A regression back to
	// default logging (or to route logLevel, which only lowers the child
	// logger's threshold and does NOT downgrade these .info() calls) re-adds
	// them and fails here.
	it("emits no info-level log entries for GET /health", async () => {
		const app = makeApp();
		const res = await app.inject({method: "GET", url: "/health"});
		expect(res.statusCode).toBe(200);
		expect(infoEntries()).toEqual([]);
	});

	// Acceptance criterion 2: muting health checks must not mute the rest.
	// If disableRequestLogging were flipped to a blanket `true`, these
	// assertions fail.
	it("still logs non-health requests at info level", async () => {
		const app = makeApp();
		const res = await app.inject({
			method: "POST",
			url: "/scans",
			payload: JSON.stringify({textFiles: {"SKILL.md": "# Skill"}, allPaths: ["SKILL.md"]}),
			headers: {"content-type": "application/json"},
		});
		expect(res.statusCode).toBe(202);

		const msgs = infoEntries().map((e) => e.msg);
		expect(msgs).toContain("incoming request");
		expect(msgs).toContain("request completed");
	});

	// Job polling is chatty too but is NOT health traffic — it stays visible.
	it("keeps GET /scans/:id polling visible at info level", async () => {
		const app = makeApp();
		const res = await app.inject({method: "GET", url: "/scans/does-not-exist"});
		expect(res.statusCode).toBe(404);
		expect(infoEntries().map((e) => e.msg)).toContain("request completed");
	});
});
