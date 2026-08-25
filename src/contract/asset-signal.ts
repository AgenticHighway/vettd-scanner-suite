/**
 * Canonical signal type produced by the first-party vettd skill scanner.
 * Represents a single non-finding observation (license, declared capability,
 * measurement, etc.) emitted by the engine in the `signals` array, travelling
 * separately from `findings`.
 *
 * Mirrors the vettd web repo's `AssetSignal` wire contract (packages/db
 * schema.prisma + packages/api suite-contract.json). Wire-required:
 * `dataCategory`, `sourceClass`, `ruleId`, `observedAt`. Everything else is
 * optional; all values are open strings (never closed unions), and subject
 * identity is stamped downstream (vettd #932), not here.
 */
export interface AssetSignal {
	dataCategory: string;
	sourceClass: string;
	ruleId: string;
	/** Caller-supplied observation time (ISO-8601 string), NOT write time. Surfaced unmodified. */
	observedAt: string;
	source?: string;
	subjectType?: string;
	subjectId?: string;
	relatedType?: string;
	relatedId?: string;
	/** Open string — deliberately NOT the AssetFinding severity union. */
	severity?: string | null;
	label?: string | null;
	detail?: string | null;
	valueNum?: number | null;
	valueText?: string | null;
	unit?: string | null;
	method?: string | null;
	derivation?: string | null;
	confidence?: number | null;
	/**
	 * Sample count the signal is based on. The wire contract allows an integer
	 * or explicit null; TS cannot express "integer-only", so integer-ness must
	 * be enforced at runtime on the suite side before this value is trusted.
	 */
	sampleSize?: number | null;
	synthetic?: boolean;
	payload?: Record<string, unknown> | null;
}