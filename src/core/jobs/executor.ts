import type {ScannerInput, SkillScanner} from "../../contract/scanner.js";
import {logger} from "../../logger.js";
import {runScanners} from "../runner.js";
import {runReviewers, DEFAULT_REVIEW_OPTS, type ReviewStageOpts} from "../../review/stage.js";
import type {FindingReviewer} from "../../review/types.js";
import type {JobStore, ScanJob} from "./store.js";

export interface JobExecutorDeps {
	store: JobStore;
	scanners: SkillScanner[];
	/** Per-scanner hard timeout ([jobs].scanner_timeout_ms). */
	scannerTimeoutMs: number;
	/** Jobs running simultaneously ([jobs].max_concurrent). */
	maxConcurrent: number;
	/** Post-scan reviewers ([review] config); empty list disables the stage. */
	reviewers?: FindingReviewer[];
	/** Eligibility and caps for the review stage; required when reviewers exist. */
	reviewOpts?: ReviewStageOpts;
}

/**
 * Runs scan jobs with a bounded concurrency. Same acquire/release shape as
 * the cisco adapter's queue — a counter plus FIFO thunks; no library needed.
 */
export class JobExecutor {
	private running = 0;
	private readonly pending: Array<() => void> = [];
	private readonly idleWaiters: Array<() => void> = [];

	constructor(private readonly deps: JobExecutorDeps) {}

	/**
	 * Creates a job, schedules the scan, returns immediately. `excludeScanners` names scanner ids
	 * that must not run for this job at all (not run and hidden): the caller decides, e.g. no
	 * consent to send content to a model provider. Omitted behaves as before.
	 */
	submit(input: ScannerInput, excludeScanners: readonly string[] = []): ScanJob {
		const job = this.deps.store.create();
		void this.runWhenSlotFree(job.id, input, excludeScanners);
		return job;
	}

	/** Resolves once no jobs are running or pending — tests and shutdown. */
	idle(): Promise<void> {
		if (this.running === 0 && this.pending.length === 0) return Promise.resolve();
		return new Promise((resolve) => {
			this.idleWaiters.push(resolve);
		});
	}

	private async runWhenSlotFree(jobId: string, input: ScannerInput, excludeScanners: readonly string[]): Promise<void> {
		await this.acquire();
		try {
			await this.runJob(jobId, input, excludeScanners);
		} finally {
			this.release();
		}
	}

	private acquire(): Promise<void> {
		if (this.running < this.deps.maxConcurrent) {
			this.running++; // synchronous increment — atomic in single-threaded JS
			return Promise.resolve();
		}
		return new Promise<void>((resolve) => {
			this.pending.push(resolve);
		});
	}

	private release(): void {
		const next = this.pending.shift();
		if (next) {
			// Transfer the slot directly — do not decrement, or a fresh submit()
			// could grab the slot before the woken waiter resumes and overrun
			// maxConcurrent.
			next();
			return;
		}
		this.running--;
		if (this.running === 0) {
			for (const waiter of this.idleWaiters.splice(0)) waiter();
		}
	}

	private async runJob(jobId: string, input: ScannerInput, excludeScanners: readonly string[]): Promise<void> {
		const {store, scannerTimeoutMs} = this.deps;
		const scanners = this.deps.scanners.filter((s) => !excludeScanners.includes(s.id));
		store.transition(jobId, "running");
		try {
			// runScanners never throws by design — per-scanner failures land as
			// errored/timeout/skipped run records. A throw here is infrastructure.
			const results = await runScanners(scanners, input, {timeoutMs: scannerTimeoutMs});
			// The review stage asks a model about deterministic findings; it stamps
			// payload.reviews and never throws. Reviewers in excludeScanners do not run
			// (the consent gate reuses the same id-space as scanners).
			if (this.deps.reviewers?.length) {
				await runReviewers(this.deps.reviewers, input, results, this.deps.reviewOpts ?? DEFAULT_REVIEW_OPTS, excludeScanners);
			}
			store.attachResults(jobId, results);
			store.transition(jobId, "completed");
		} catch (err) {
			logger.error({module: "core.jobs.executor", jobId, err}, "scan job failed");
			store.transition(jobId, "failed", {error: err instanceof Error ? err.message : String(err)});
		}
	}
}
