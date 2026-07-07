import {randomUUID} from "node:crypto";

import type {ScannerOutput} from "../../contract/scanner.js";

// Finished (completed/failed) jobs are evicted after this TTL; running or
// queued jobs are never evicted.
const COMPLETED_JOB_TTL_MS = 60 * 60 * 1000;
// Absolute cap on stored jobs. When hit with nothing evictable, create()
// throws JobStoreFullError and the HTTP layer answers 429.
const MAX_JOBS = 1000;

export type JobStatus = "queued" | "running" | "completed" | "failed";

export interface ScanJob {
	id: string;
	status: JobStatus;
	submittedAt: Date;
	startedAt?: Date;
	finishedAt?: Date;
	results?: ScannerOutput[];
	error?: string;
}

export class JobStoreFullError extends Error {
	constructor() {
		super(`job store is full (max ${MAX_JOBS} jobs)`);
	}
}

/**
 * Narrow on purpose: this is the seam for a future durable store (SQS/DB).
 * Callers may assume only these four operations.
 */
export interface JobStore {
	create(): ScanJob;
	get(id: string): ScanJob | undefined;
	transition(id: string, status: JobStatus, opts?: {error?: string}): void;
	attachResults(id: string, results: ScannerOutput[]): void;
}

const LEGAL_TRANSITIONS: Record<JobStatus, JobStatus[]> = {
	queued: ["running"],
	running: ["completed", "failed"],
	completed: [],
	failed: [],
};

/**
 * In-memory job store. A restart loses every job by design — callers detect
 * the resulting 404 on poll and resubmit. Eviction is sweep-on-write (inside
 * create()) so there is no timer to manage on shutdown.
 */
export class InMemoryJobStore implements JobStore {
	private readonly jobs = new Map<string, ScanJob>();

	create(): ScanJob {
		this.sweep();
		if (this.jobs.size >= MAX_JOBS) {
			throw new JobStoreFullError();
		}
		const job: ScanJob = {
			id: randomUUID(),
			status: "queued",
			submittedAt: new Date(),
		};
		this.jobs.set(job.id, job);
		return job;
	}

	get(id: string): ScanJob | undefined {
		return this.jobs.get(id);
	}

	transition(id: string, status: JobStatus, opts?: {error?: string}): void {
		const job = this.mustGet(id);
		if (!LEGAL_TRANSITIONS[job.status].includes(status)) {
			// Illegal transitions are bugs in the executor — fail loud.
			throw new Error(`illegal job transition ${job.status} -> ${status} (job ${id})`);
		}
		job.status = status;
		if (status === "running") job.startedAt = new Date();
		if (status === "completed" || status === "failed") job.finishedAt = new Date();
		if (status === "failed" && opts?.error !== undefined) job.error = opts.error;
	}

	attachResults(id: string, results: ScannerOutput[]): void {
		const job = this.mustGet(id);
		if (job.status !== "running") {
			throw new Error(`cannot attach results to ${job.status} job ${id}`);
		}
		job.results = results;
	}

	private mustGet(id: string): ScanJob {
		const job = this.jobs.get(id);
		if (!job) throw new Error(`unknown job ${id}`);
		return job;
	}

	private sweep(): void {
		const cutoff = Date.now() - COMPLETED_JOB_TTL_MS;
		for (const [id, job] of this.jobs) {
			const finished = job.status === "completed" || job.status === "failed";
			if (finished && job.finishedAt !== undefined && job.finishedAt.getTime() <= cutoff) {
				this.jobs.delete(id);
			}
		}
	}
}
