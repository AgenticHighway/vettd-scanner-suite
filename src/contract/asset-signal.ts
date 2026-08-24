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
	userId?: string;
	/** Open string — deliberately NOT the AssetFinding severity union. */
	severity?: string;
	label?: string;
	detail?: string;
	valueNum?: number;
	valueText?: string;
	unit?: string;
	method?: string;
	derivation?: string;
	confidence?: number;
	sampleSize?: number;
	synthetic?: boolean;
	payload?: unknown;
}