import {randomUUID} from "node:crypto";

// Batch entries are correlation records only — they never hold job state.
// TTL is measured from submittedAt (the index has no notion of completion),
// which puts a batch's expiry at or before its jobs' own 1h post-finish TTL
// in the common case. Eviction is sweep-on-write, same as JobStore.
const BATCH_TTL_MS = 60 * 60 * 1000;
// Matches MAX_JOBS in store.ts on purpose: the batch index must never be the
// constraint that binds first. A 1-item batch is legal, so 1000 batches is
// the worst case that 1000 jobs can produce.
const MAX_BATCHES = 1000;

export interface BatchAcceptedItem {
	index: number;
	jobId: string;
}

export interface BatchRejectedItem {
	index: number;
	error: string;
}

export interface ScanBatch {
	id: string;
	submittedAt: Date;
	accepted: BatchAcceptedItem[];
	rejected: BatchRejectedItem[];
}

export class BatchIndexFullError extends Error {
	constructor() {
		super(`batch index is full (max ${MAX_BATCHES} batches)`);
	}
}

/**
 * Correlates a batch submission to the jobIds it created. Deliberately
 * separate from JobStore, which is the seam for a future durable store — a
 * batch is HTTP-layer bookkeeping, not job state. In-memory; a restart loses
 * every batch and callers see a 404 and resubmit, same contract as JobStore.
 */
export class BatchIndex {
	private readonly batches = new Map<string, ScanBatch>();

	/**
	 * Reserves a batch id before any items are submitted, so a full index is
	 * discovered before real scan work is queued rather than after.
	 */
	create(): ScanBatch {
		this.sweep();
		if (this.batches.size >= MAX_BATCHES) {
			throw new BatchIndexFullError();
		}
		const batch: ScanBatch = {
			id: randomUUID(),
			submittedAt: new Date(),
			accepted: [],
			rejected: [],
		};
		this.batches.set(batch.id, batch);
		return batch;
	}

	/** Records the outcome of every item in the batch. Call once, after create(). */
	attach(id: string, accepted: BatchAcceptedItem[], rejected: BatchRejectedItem[]): void {
		const batch = this.mustGet(id);
		batch.accepted = accepted;
		batch.rejected = rejected;
	}

	get(id: string): ScanBatch | undefined {
		return this.batches.get(id);
	}

	private mustGet(id: string): ScanBatch {
		const batch = this.batches.get(id);
		if (!batch) throw new Error(`unknown batch ${id}`);
		return batch;
	}

	private sweep(): void {
		const cutoff = Date.now() - BATCH_TTL_MS;
		for (const [id, batch] of this.batches) {
			if (batch.submittedAt.getTime() <= cutoff) {
				this.batches.delete(id);
			}
		}
	}
}
