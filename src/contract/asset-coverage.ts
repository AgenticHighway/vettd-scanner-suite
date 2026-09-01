/**
 * Canonical coverage/attestation fact produced by the first-party vettd skill
 * scanner, kept on a channel separate from `findings` and `signals`
 * (vettd#941). A coverage entry says something about the ANALYSIS, not the
 * asset: "the scan checked and found nothing" (an attestation) or "the scan
 * was bounded/degraded" (a coverage notice) — so it is stored on the audit
 * record (`SkillAudit.coverage`) rather than persisted as a finding or signal.
 *
 * Mirrors the Rust engine's `CoverageEntry`
 * (crates/vettd-skill-scanner/src/coverage.rs) and vettd web's open
 * `SkillCoverageEntry` wire contract (packages/types/src/skill-coverage.ts).
 * Wire-required: `kind`, `ruleId`, `label`, `detail`. `category` is optional
 * and omitted when absent. Every value is an open string — `kind` is an
 * open string on purpose (#937's degrade-not-fail): the two known values
 * are "attestation" and "coverage", but a future producer must be able to
 * emit an unrecognized value and have the read degrade rather than hard-fail.
 *
 * The Rust shim serializes this under the `coverage` key and OMITS the key
 * entirely when the array is empty (`skip_serializing_if = "Vec::is_empty"`),
 * so a zero-coverage run emits no `coverage` key at all — the adapter must
 * preserve that: `body.coverage` is `undefined`, never `[]`.
 *
 * Suite-local name (`AssetCoverageEntry`); the wire shape is byte-identical to
 * vettd web's `SkillCoverageEntry`. Only the type *name* is suite-local — the
 * field names (`kind`, `ruleId`, `label`, `detail`, `category`) are the
 * cross-repo contract.
 */
export interface AssetCoverageEntry {
	/** Open string: "attestation" | "coverage" today. Not a closed union. */
	kind: string;
	/** Rule identifier — VTD-#### for vettd-native coverage/attestation checks. */
	ruleId: string;
	label: string;
	detail: string;
	/** Source category the check belongs to (security | structure | reliability | ...). Optional; omitted when unset. */
	category?: string | null;
}
