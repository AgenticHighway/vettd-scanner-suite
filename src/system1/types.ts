// Connector-neutral shapes for a typed-question decision model. The only implementation today is
// the OpenRouter Decisions API (../adapters/jev.ts); System 1 itself knows nothing about its wire.

import type {System1Rule} from "./rules.js";

/** Persisted on every finding, signal and run this scanner produces. */
export const SYSTEM1_SOURCE_ID = "system1";

export interface DecisionAnswer {
	type?: string;
	/** Choice questions. Score questions carry `score` + `legend` instead; see normalizeAnswer. */
	choice?: string;
	/** Score questions: the probability-weighted expected level (a fraction, NOT an index). */
	score?: number;
	legend?: Record<string, string>;
	/** Keyed by option name for choice questions, by legend index for score questions. */
	probabilities: Record<string, number>;
	confidence: number;
}

export interface DecisionUsage {
	input_tokens?: number;
	output_tokens?: number;
	cost?: number;
}

export interface DecisionResponse {
	/** The pinned model version that actually answered. */
	model?: string;
	answers: Record<string, DecisionAnswer>;
	usage?: DecisionUsage;
}

export const AGGREGATE_VERDICTS = ["SAFE", "LOW", "MEDIUM", "HIGH", "CRITICAL"] as const;
export type AggregateVerdict = (typeof AGGREGATE_VERDICTS)[number];

/** One confirmed safety finding handed to the aggregate question. */
export interface AggregateEvidence {
	rule: string;
	section: string;
	finding: string;
}

export interface AggregateResult {
	verdict: AggregateVerdict | null;
	/** Raw answer and usage, kept for rawReport. */
	answer: DecisionAnswer | null;
	usage: DecisionUsage | null;
	cost: number;
}

/** Controlled failure codes: the only error detail persisted or logged, never upstream text. */
export type DecisionErrorCode = "no_key" | "timeout" | "network" | "http_error" | "protocol";

export class DecisionError extends Error {
	constructor(
		readonly code: DecisionErrorCode,
		readonly status?: number,
	) {
		super(status ? `${code} ${status}` : code);
		this.name = "DecisionError";
	}
}

export function errorCode(err: unknown): string {
	return err instanceof DecisionError ? err.message : "unexpected";
}

export interface DecisionConnector {
	/** The model the connector is configured for (before any version pinning). */
	readonly model: string;
	available(): boolean;
	/** One call, one typed question per rule. Throws on transport or protocol failure. */
	askRules(skillName: string, payload: string, rules: readonly System1Rule[]): Promise<DecisionResponse>;
	/** One call: overall severity over only the confirmed safety findings. */
	aggregate(skillName: string, evidence: AggregateEvidence[], rulesChecked: number): Promise<AggregateResult>;
}
