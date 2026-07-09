import Fastify, {type FastifyBaseLogger, type FastifyInstance} from "fastify";

import {MAX_BODY_BYTES, MAX_FILES, MAX_TEXT_FILE_BYTES, MAX_TOTAL_TEXT_BYTES} from "../consts.js";
import type {ScannerInput} from "../contract/scanner.js";
import type {JobExecutor} from "../core/jobs/executor.js";
import {JobStoreFullError, type JobStore} from "../core/jobs/store.js";
import {logger} from "../logger.js";

export interface AppDeps {
	store: JobStore;
	executor: JobExecutor;
}

// Body shape: matches ScannerInput with JSON-serializable textFiles (Record
// instead of Map). Validated inline — oversized or malformed bodies fail the
// request with a 400 so callers never have to poll to find out.
interface SubmitBody {
	textFiles: Record<string, string>;
	allPaths: string[];
}

// App-level errors respond {error: string}; framework-generated errors
// (413 oversize, 415 unknown content type, 500) keep fastify's default
// {statusCode, error, message} shape — documented in docs/design.md.
export function buildApp(deps: AppDeps): FastifyInstance {
	// Widen to FastifyBaseLogger so the instance type stays the default
	// FastifyInstance (fastify parameterizes its generics by the logger type).
	const app = Fastify({loggerInstance: logger as FastifyBaseLogger, bodyLimit: MAX_BODY_BYTES});

	app.get("/health", async () => ({ok: true}));

	app.post("/scans", async (request, reply) => {
		const raw = request.body;

		// Fastify parses application/json by default. Anything that failed to
		// parse (bad JSON, unsupported content-type) arrives as the parsed
		// default or the raw buffer — both rejected below.
		if (raw === undefined || raw === null || (typeof raw === "object" && Object.keys(raw).length === 0)) {
			return reply.code(400).send({error: "empty or missing body — POST a JSON object {textFiles, allPaths}"});
		}

		let body: SubmitBody;
		try {
			body = raw as SubmitBody;
		} catch {
			return reply.code(400).send({error: "malformed body — expected {textFiles: Record<string,string>, allPaths: string[]}"});
		}

		// Structural validation before size checks — cheap failure paths.
		if (body === null || typeof body !== "object") {
			return reply.code(400).send({error: "malformed body — expected {textFiles, allPaths}"});
		}
		if (!Array.isArray(body.allPaths)) {
			return reply.code(400).send({error: "malformed body — 'allPaths' must be an array of strings"});
		}
		if (body.allPaths.length !== new Set(body.allPaths).size) {
			return reply.code(400).send({error: "malformed body — 'allPaths' must have unique entries"});
		}
		for (const p of body.allPaths) {
			if (typeof p !== "string") {
				return reply.code(400).send({error: "malformed body — 'allPaths' entries must be strings"});
			}
		}
		if (body.textFiles === null || typeof body.textFiles !== "object" || Array.isArray(body.textFiles)) {
			return reply.code(400).send({error: "malformed body — 'textFiles' must be a Record<string,string>"});
		}
		for (const [k, v] of Object.entries(body.textFiles)) {
			if (typeof k !== "string") {
				return reply.code(400).send({error: "malformed body — 'textFiles' keys must be strings"});
			}
			if (typeof v !== "string") {
				return reply.code(400).send({error: "malformed body — 'textFiles' values must be strings"});
			}
		}

		// Size guards. Fail the request immediately — the executor never sees
		// oversized input, and callers don't poll to find out.
		if (body.allPaths.length > MAX_FILES) {
			return reply.code(400).send({
				error: `body too large: ${body.allPaths.length} paths (limit: ${MAX_FILES})`,
			});
		}

		let totalTextBytes = 0;
		for (const [path, content] of Object.entries(body.textFiles)) {
			const len = Buffer.byteLength(content, "utf8");
			if (len > MAX_TEXT_FILE_BYTES) {
				return reply.code(400).send({
					error: `text file ${path} exceeds ${(MAX_TEXT_FILE_BYTES / 1024 / 1024).toFixed(0)} MB limit (${(len / 1024 / 1024).toFixed(2)} MB)`,
				});
			}
			totalTextBytes += len;
			if (totalTextBytes > MAX_TOTAL_TEXT_BYTES) {
				return reply.code(400).send({
					error: `extracted text exceeds ${(MAX_TOTAL_TEXT_BYTES / 1024 / 1024).toFixed(0)} MB limit (${(totalTextBytes / 1024 / 1024).toFixed(2)} MB)`,
				});
			}
		}

		// Build ScannerInput from validated JSON. Map is non-serializable, so
		// the executor is the only consumer that needs it.
		const textFiles = new Map(Object.entries(body.textFiles));
		const input: ScannerInput = {textFiles, allPaths: body.allPaths};

		try {
			const job = deps.executor.submit(input);
			return await reply.code(202).send({jobId: job.id, status: job.status});
		} catch (err) {
			if (err instanceof JobStoreFullError) {
				return reply.code(429).send({error: err.message});
			}
			throw err;
		}
	});

	// NOTE(polling): clients poll this endpoint for job completion. This is
	// the designated replacement point for a push mechanism (SQS/webhook)
	// once the job store goes durable — see docs/design.md "Job lifecycle".
	app.get("/scans/:id", async (request, reply) => {
		const {id} = request.params as {id: string};
		const job = deps.store.get(id);
		if (!job) {
			return reply.code(404).send({error: "job not found"});
		}
		return {
			id: job.id,
			status: job.status,
			submittedAt: job.submittedAt,
			...(job.startedAt !== undefined ? {startedAt: job.startedAt} : {}),
			...(job.finishedAt !== undefined ? {finishedAt: job.finishedAt} : {}),
			...(job.status === "completed" ? {results: job.results} : {}),
			...(job.status === "failed" && job.error !== undefined ? {error: job.error} : {}),
		};
	});

	return app;
}
