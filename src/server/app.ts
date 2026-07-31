import Fastify, {type FastifyBaseLogger, type FastifyInstance, type FastifyRequest} from "fastify";

import {MAX_BODY_BYTES, MAX_FILES, MAX_TEXT_FILE_BYTES, MAX_TOTAL_TEXT_BYTES} from "../consts.js";
import type {ScannerInput} from "../contract/scanner.js";
import {BatchIndexFullError, type BatchAcceptedItem, type BatchIndex, type BatchRejectedItem, type ScanBatch} from "../core/jobs/batch-index.js";
import type {JobExecutor} from "../core/jobs/executor.js";
import {JobStoreFullError, type JobStatus, type JobStore} from "../core/jobs/store.js";
import {logger} from "../logger.js";

export interface AppDeps {
	store: JobStore;
	executor: JobExecutor;
	batches: BatchIndex;
	/** Items allowed in one POST /scans/batch submission ([jobs].max_batch_items). */
	maxBatchItems: number;
}

// Body shape: matches ScannerInput with JSON-serializable textFiles (Record
// instead of Map). Validated inline — oversized or malformed bodies fail the
// request with a 400 so callers never have to poll to find out.
interface SubmitBody {
	textFiles: Record<string, string>;
	allPaths: string[];
}

// Custom content-type parser for application/json. Captures the raw body as a
// string instead of letting Fastify parse it — so our handler can distinguish
// "invalid JSON" from "valid JSON with bad shape" and return its own 400
// message instead of Fastify's generic "Body is not valid JSON" response.
function jsonBodyParser(
	_req: FastifyRequest,
	payload: NodeJS.ReadableStream,
	done: (err: Error | null, body: string) => void,
) {
	const chunks: Buffer[] = [];
	payload.on("data", (chunk: Buffer) => chunks.push(chunk));
	payload.on("end", () => {
		const raw = Buffer.concat(chunks).toString("utf8");
		done(null, raw);
	});
	payload.on("error", (err: Error) => done(err, ""));
}

type ItemValidation = {ok: true; input: ScannerInput} | {ok: false; error: string};

// Shared by POST /scans and POST /scans/batch. Takes an already-JSON.parse'd
// value: the two routes parse different envelopes and need different parse-
// failure messages, so JSON.parse stays in the handlers.
//
// Messages say "malformed body" even when validating one item of a batch —
// inside a rejected batch entry the sibling `index` supplies the "which
// item" context. Changing the wording would churn the single-scan wire
// contract for no caller benefit.
function validateScanItem(parsed: unknown): ItemValidation {
	const body = parsed as SubmitBody;

	// Structural validation before size checks — cheap failure paths.
	if (body === null || typeof body !== "object") {
		return {ok: false, error: "malformed body — expected {textFiles, allPaths}"};
	}
	if (!Array.isArray(body.allPaths)) {
		return {ok: false, error: "malformed body — 'allPaths' must be an array of strings"};
	}
	if (body.allPaths.length !== new Set(body.allPaths).size) {
		return {ok: false, error: "malformed body — 'allPaths' must have unique entries"};
	}
	for (const p of body.allPaths) {
		if (typeof p !== "string") {
			return {ok: false, error: "malformed body — 'allPaths' entries must be strings"};
		}
	}
	if (body.textFiles === null || typeof body.textFiles !== "object" || Array.isArray(body.textFiles)) {
		return {ok: false, error: "malformed body — 'textFiles' must be a Record<string,string>"};
	}
	for (const [k, v] of Object.entries(body.textFiles)) {
		if (typeof k !== "string") {
			return {ok: false, error: "malformed body — 'textFiles' keys must be strings"};
		}
		if (typeof v !== "string") {
			return {ok: false, error: "malformed body — 'textFiles' values must be strings"};
		}
	}

	// Size guards. Fail the request immediately — the executor never sees
	// oversized input, and callers don't poll to find out.
	if (body.allPaths.length > MAX_FILES) {
		return {ok: false, error: `body too large: ${body.allPaths.length} paths (limit: ${MAX_FILES})`};
	}

	let totalTextBytes = 0;
	for (const [path, content] of Object.entries(body.textFiles)) {
		const len = Buffer.byteLength(content, "utf8");
		if (len > MAX_TEXT_FILE_BYTES) {
			return {
				ok: false,
				error: `text file ${path} exceeds ${(MAX_TEXT_FILE_BYTES / 1024 / 1024).toFixed(0)} MB limit (${(len / 1024 / 1024).toFixed(2)} MB)`,
			};
		}
		totalTextBytes += len;
		if (totalTextBytes > MAX_TOTAL_TEXT_BYTES) {
			return {
				ok: false,
				error: `extracted text exceeds ${(MAX_TOTAL_TEXT_BYTES / 1024 / 1024).toFixed(0)} MB limit (${(totalTextBytes / 1024 / 1024).toFixed(2)} MB)`,
			};
		}
	}

	// Build ScannerInput from validated JSON. Map is non-serializable, so
	// the executor is the only consumer that needs it.
	const textFiles = new Map(Object.entries(body.textFiles));
	return {ok: true, input: {textFiles, allPaths: body.allPaths}};
}

// Body shape for POST /scans/batch: an ordered list of single-scan bodies.
// Wrapped in `items`, not a bare top-level array, so the "body must be a
// JSON object" structural check stays uniform with POST /scans.
interface BatchSubmitBody {
	items: unknown[];
}

type BatchItemStatus = JobStatus | "expired";

// POST /scans/batch's 202 and GET /scans/batch/:id's 200 render through this
// one function so the two bodies cannot drift. Status is always joined live
// from the store — the batch index stores no job state, or a cached
// "queued" would strand a poller forever.
function renderBatch(store: JobStore, batch: ScanBatch) {
	return {
		batchId: batch.id,
		submittedAt: batch.submittedAt,
		accepted: batch.accepted.map(({index, jobId}) => {
			// Swept by the store's 1h TTL while the batch entry is still live.
			// Same meaning as the 404 GET /scans/:id gives for an evicted job:
			// unrecoverable, resubmit. Reported, never rendered as "queued".
			const status: BatchItemStatus = store.get(jobId)?.status ?? "expired";
			return {index, jobId, status};
		}),
		rejected: batch.rejected,
	};
}

// App-level errors respond {error: string}; framework-generated errors
// (413 oversize, 415 unknown content type, 500) keep fastify's default
// {statusCode, error, message} shape — documented in docs/design.md.
export function buildApp(deps: AppDeps): FastifyInstance {
	// Widen to FastifyBaseLogger so the instance type stays the default
	// FastifyInstance (fastify parameterizes its generics by the logger type).
	const app = Fastify({loggerInstance: logger as FastifyBaseLogger, bodyLimit: MAX_BODY_BYTES});

	// Override Fastify's default JSON parser so our handler sees the raw
	// body string and can return its own 400 for malformed JSON.
	app.addContentTypeParser("application/json", {}, jsonBodyParser);

	// logLevel: "debug" — this route is hit every 10s by Docker HEALTHCHECK
	// (and polled before every scan by adapters' available() checks), so its
	// automatic request/response logs would otherwise flood info-level output.
	app.get("/health", {logLevel: "debug"}, async () => ({ok: true}));

	app.post("/scans", async (request, reply) => {
		const raw = request.body as string | undefined;

		if (raw === undefined || raw === null || raw.length === 0) {
			return reply.code(400).send({error: "empty or missing body — POST a JSON object {textFiles, allPaths}"});
		}

		let parsed: unknown;
		try {
			parsed = JSON.parse(raw);
		} catch {
			return reply.code(400).send({error: "malformed body — expected {textFiles: Record<string,string>, allPaths: string[]}"});
		}

		const validation = validateScanItem(parsed);
		if (!validation.ok) {
			return reply.code(400).send({error: validation.error});
		}

		try {
			const job = deps.executor.submit(validation.input);
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

	app.post("/scans/batch", async (request, reply) => {
		const raw = request.body as string | undefined;

		if (raw === undefined || raw === null || raw.length === 0) {
			return reply.code(400).send({error: "empty or missing body — POST a JSON object {items: [{textFiles, allPaths}]}"});
		}

		let parsed: unknown;
		try {
			parsed = JSON.parse(raw);
		} catch {
			return reply.code(400).send({error: "malformed body — expected {items: [{textFiles, allPaths}]}"});
		}

		if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
			return reply.code(400).send({error: "malformed body — expected {items: [{textFiles, allPaths}]}"});
		}
		const {items} = parsed as Partial<BatchSubmitBody>;
		if (!Array.isArray(items)) {
			return reply.code(400).send({error: "malformed body — 'items' must be an array"});
		}
		if (items.length === 0) {
			return reply.code(400).send({error: "malformed body — 'items' must not be empty"});
		}
		if (items.length > deps.maxBatchItems) {
			return reply.code(400).send({
				error: `batch too large: ${items.length} items (limit: ${deps.maxBatchItems})`,
			});
		}

		// Reserve before submitting: a full index must never strand jobs the
		// caller has no id for.
		let batch: ScanBatch;
		try {
			batch = deps.batches.create();
		} catch (err) {
			if (err instanceof BatchIndexFullError) {
				return reply.code(429).send({error: err.message});
			}
			throw err;
		}

		// No await between create() and attach() — executor.submit() is
		// synchronous, so no GET can observe a half-built batch.
		const accepted: BatchAcceptedItem[] = [];
		const rejected: BatchRejectedItem[] = [];
		for (const [index, item] of items.entries()) {
			const validation = validateScanItem(item);
			if (!validation.ok) {
				rejected.push({index, error: validation.error});
				continue;
			}
			try {
				accepted.push({index, jobId: deps.executor.submit(validation.input).id});
			} catch (err) {
				// A full job store rejects THIS item only. Siblings already
				// queued keep running; the caller resubmits just this index.
				if (err instanceof JobStoreFullError) {
					rejected.push({index, error: err.message});
					continue;
				}
				throw err;
			}
		}
		deps.batches.attach(batch.id, accepted, rejected);

		// A 202 with partial rejections is invisible in fastify's automatic
		// request log, which just says 202 — an operator could not otherwise
		// tell a clean batch from one where most items bounced off a full store.
		const logFields = {
			module: "server",
			batchId: batch.id,
			submitted: items.length,
			accepted: accepted.length,
			rejected: rejected.length,
		};
		if (rejected.length > 0) {
			request.log.warn(logFields, "scan batch partially rejected");
		} else {
			request.log.info(logFields, "scan batch accepted");
		}

		return await reply.code(202).send(renderBatch(deps.store, batch));
	});

	// Same polling caveat as GET /scans/:id — see the NOTE above.
	app.get("/scans/batch/:id", async (request, reply) => {
		const {id} = request.params as {id: string};
		const batch = deps.batches.get(id);
		if (!batch) {
			return reply.code(404).send({error: "batch not found"});
		}
		return renderBatch(deps.store, batch);
	});

	return app;
}
