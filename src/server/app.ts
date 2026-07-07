import Fastify, {type FastifyBaseLogger, type FastifyInstance} from "fastify";

import {MAX_ZIP_SIZE} from "../consts.js";
import type {ScannerInput} from "../contract/scanner.js";
import type {JobExecutor} from "../core/jobs/executor.js";
import {JobStoreFullError, type JobStore} from "../core/jobs/store.js";
import {extractZipFiles, ZipValidationError} from "../intake/zip.js";
import {logger} from "../logger.js";

export interface AppDeps {
	store: JobStore;
	executor: JobExecutor;
}

// App-level errors respond {error: string}; framework-generated errors
// (413 oversize, 415 unknown content type, 500) keep fastify's default
// {statusCode, error, message} shape — documented in docs/design.md.
export function buildApp(deps: AppDeps): FastifyInstance {
	// Widen to FastifyBaseLogger so the instance type stays the default
	// FastifyInstance (fastify parameterizes its generics by the logger type).
	const app = Fastify({loggerInstance: logger as FastifyBaseLogger, bodyLimit: MAX_ZIP_SIZE});

	// Raw zip bodies — the submit route never sees parsed JSON.
	app.addContentTypeParser(
		["application/zip", "application/octet-stream"],
		{parseAs: "buffer"},
		(_req, body, done) => {
			done(null, body);
		},
	);

	app.get("/health", async () => ({ok: true}));

	app.post("/scans", async (request, reply) => {
		const body = request.body;
		if (!Buffer.isBuffer(body) || body.length === 0) {
			return reply.code(400).send({error: "empty body — POST a zip archive as application/zip"});
		}

		// Extraction happens inline at intake: a bad zip fails the request
		// immediately (callers never poll to discover it), and the raw buffer
		// is released instead of being stored on the job.
		let input: ScannerInput;
		try {
			const {textFiles, allPaths} = await extractZipFiles(body);
			input = {textFiles, allPaths};
		} catch (err) {
			if (err instanceof ZipValidationError) {
				return reply.code(400).send({error: err.message});
			}
			throw err;
		}

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
