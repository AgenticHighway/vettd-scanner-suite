// Secrets never leave for the model provider: each match becomes a typed placeholder. The type is
// kept so System 1 can still judge that a credential is hardcoded (its hardcoded-key rule) without
// seeing the value. Patterns follow the Rust engine's secret checks (vettd-skill-scanner
// checks/sensitive.rs) plus common provider key shapes.

interface SecretPattern {
	type: string;
	re: RegExp;
	/** Capture group holding the secret; 0 replaces the whole match. */
	group: number;
}

const PATTERNS: readonly SecretPattern[] = [
	{type: "private-key", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, group: 0},
	{type: "github-token", re: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,})/g, group: 0},
	{type: "anthropic-key", re: /\bsk-ant-[A-Za-z0-9_-]{20,}/g, group: 0},
	{type: "openai-key", re: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}/g, group: 0},
	{type: "aws-key", re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, group: 0},
	{type: "slack-token", re: /\bxox[abposr]-[A-Za-z0-9-]{10,}/g, group: 0},
	{type: "google-key", re: /\bAIza[0-9A-Za-z_-]{35}\b/g, group: 0},
	{type: "stripe-key", re: /\b(?:sk|rk)_live_[A-Za-z0-9]{16,}/g, group: 0},
	{type: "jwt", re: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, group: 0},
	// `api_key = "…"`, `"password": "…"`, `SECRET_TOKEN='…'`: only the quoted value is replaced.
	{
		type: "secret-value",
		re: /\b[A-Za-z0-9_.-]*(?:api[_-]?key|access[_-]?token|auth[_-]?token|secret|password|passwd|client[_-]?secret|bearer)[A-Za-z0-9_.-]*["']?\s*[:=]\s*["']([^"'\s]{8,})["']/gi,
		group: 1,
	},
];

export interface Redaction {
	text: string;
	/** Count per placeholder type; never the values. */
	counts: Record<string, number>;
}

export function redactSecrets(text: string, counts: Record<string, number> = {}): Redaction {
	let out = text;
	for (const {type, re, group} of PATTERNS) {
		out = out.replace(re, (match: string, ...groups: unknown[]) => {
			const placeholder = `[REDACTED:${type}]`;
			const secret = group === 0 ? match : groups[group - 1];
			// Already-redacted text (an earlier, more specific pattern) is left alone.
			if (typeof secret !== "string" || secret.startsWith("[REDACTED:")) return match;
			counts[type] = (counts[type] ?? 0) + 1;
			return group === 0 ? placeholder : match.replace(secret, placeholder);
		});
	}
	return {text: out, counts};
}
