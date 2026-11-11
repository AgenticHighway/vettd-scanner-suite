// The System 1 rule set: typed questions a decision model answers over a skill's text. Regex
// scanners and System 1 are mutually exclusive for non-safety rules (each owns its rules), while
// safety rules overlap on purpose, under separate ids. Design record: vettd docs/system1-scanner.md.
//
// Each rule splits into its definition (instructions/none/present/options/levels — the rule's
// canonical meaning, never sent anywhere) and its `prompt` (the question and option texts the
// decision model is asked). The prompt is ours to tune; see the ChoicePrompt docblock.
// `section` groups safety rules for the stage-2 evidence list.
//
// Three emit kinds:
// - finding: a safety judgment, written as an AssetFinding (category security) when it fires.
// - signalFinding: a non-safety defect, written as a finding-shaped AssetSignal when it fires.
// - classification: always written, one value per scan; may carry a severity when the value is a
//   negative one (a finding implies a severity, but a severity does not imply a finding).

import type {AssetFinding} from "../contract/scanner.js";

export type System1Severity = AssetFinding["severity"];

/**
 * The prompt is the text actually sent to the decision model; it is Vettd's own text and ours to
 * tune. The definition fields below (`instructions`, `none`, `present`, `options`, `levels`) stay
 * the rule's canonical meaning. Round 1 copied each definition verbatim into its prompt, so the
 * wire is unchanged; later rounds tune prompts without touching definitions, and definition
 * changes are called out as such.
 */
export interface ChoicePrompt {
	/** The question text. */
	instructions: string;
	/** Option texts; the keys are the answer vocabulary `evaluate` reads back. */
	none: string;
	present: string;
}

export interface ScorePrompt {
	instructions: string;
	/** The level names in order; the answer vocabulary on the wire. */
	levels: readonly string[];
}

export interface ClassificationPrompt {
	instructions: string;
	/** Option texts keyed by the value they answer; the keys must match `options`. */
	options: Record<string, string>;
}

interface RuleBase {
	/** The question key on the wire; stable, and the join key into rawReport answers. */
	key: string;
	/** Short description shown to readers; the definition, not the prompt. */
	summary: string;
	section: string;
	/** The rule's definition: what the question means. Not sent anywhere. */
	instructions: string;
	/** Vettd rule id: `S1-####` for safety findings, `<dataCategory>/<slug>` for signals. */
	ruleId: string;
}

export interface ChoiceRule extends RuleBase {
	kind: "choice";
	/** The question and option texts the decision model is asked. */
	prompt: ChoicePrompt;
	emit: "finding" | "signalFinding";
	/** Required when emit is "signalFinding". */
	dataCategory?: string;
	/** The definition of the absent option; `evaluate` reads the "none" key. */
	none: string;
	/** The definition of the fired option; `evaluate` reads the "present" key. */
	present: string;
	severity: System1Severity;
}

export interface ScoreRule extends RuleBase {
	kind: "score";
	/** The question and level texts the decision model is asked. */
	prompt: ScorePrompt;
	emit: "finding";
	/** The definition of the levels; the prompt carries the wire texts. */
	levels: readonly string[];
	/** Severity by non-"none" level. */
	severityByLevel: Record<string, System1Severity>;
}

export interface ClassificationRule extends RuleBase {
	kind: "classification";
	/** The question and option texts the decision model is asked. */
	prompt: ClassificationPrompt;
	emit: "classification";
	dataCategory: string;
	/** The definition of the option values; the prompt carries the wire texts. */
	options: Record<string, string>;
	/** The option that means the thing is absent or not applicable. */
	absent: string;
	/** Severity for the values that are negative; every other value carries none. */
	severityByValue: Record<string, System1Severity>;
}

export type System1Rule = ChoiceRule | ScoreRule | ClassificationRule;

export const SYSTEM1_RULES: readonly System1Rule[] = [
	{
		kind: "choice",
		emit: "finding",
		ruleId: "S1-0001",
		key: "deceptive_name",
		prompt: {
			instructions: "Is the declared name deceptive given what the scripts actually do (e.g. \"safe-calculator\" that exfiltrates data)?",
			none: "The skill package does not contain a deceptive name relative to the skill's actual behavior.",
			present: "The skill package contains a deceptive name relative to the skill's actual behavior.",
		},
		summary: "Name misleads about what the skill does",
		section: "SS1",
		instructions: "Is the declared name deceptive given what the scripts actually do (e.g. \"safe-calculator\" that exfiltrates data)?",
		none: "The skill package does not contain a deceptive name relative to the skill's actual behavior.",
		present: "The skill package contains a deceptive name relative to the skill's actual behavior.",
		severity: "medium",
	},
	{
		kind: "choice",
		emit: "finding",
		ruleId: "S1-0002",
		key: "description_manifest_mismatch",
		prompt: {
			instructions: "Does the description match the skill's actual behavior?",
			none: "The skill package does not contain a mismatch between the declared description and the skill's actual behavior.",
			present: "The skill package contains a mismatch between the declared description and the skill's actual behavior.",
		},
		summary: "Description does not match behavior",
		section: "SS1",
		instructions: "Does the description match the skill's actual behavior?",
		none: "The skill package does not contain a mismatch between the declared description and the skill's actual behavior.",
		present: "The skill package contains a mismatch between the declared description and the skill's actual behavior.",
		severity: "medium",
	},
	{
		kind: "choice",
		emit: "finding",
		ruleId: "S1-0003",
		key: "allowed_tools_violation",
		prompt: {
			instructions: "If allowed-tools is declared, does the code violate that restriction? (missing the field entirely is informational, not a violation)",
			none: "The skill package does not contain a violation of a declared allowed-tools restriction.",
			present: "The skill package contains a violation of a declared allowed-tools restriction.",
		},
		summary: "Code violates declared allowed-tools",
		section: "SS1",
		instructions: "If allowed-tools is declared, does the code violate that restriction? (missing the field entirely is informational, not a violation)",
		none: "The skill package does not contain a violation of a declared allowed-tools restriction.",
		present: "The skill package contains a violation of a declared allowed-tools restriction.",
		severity: "medium",
	},
	{
		kind: "choice",
		emit: "signalFinding",
		dataCategory: "compatibility",
		ruleId: "compatibility/claim-behavior-mismatch",
		key: "compatibility_claim_mismatch",
		prompt: {
			instructions: "Does the compatibility claim (e.g. no network use) match reality?",
			none: "The skill package does not contain a mismatch between a compatibility claim and the skill's actual behavior.",
			present: "The skill package contains a mismatch between a compatibility claim and the skill's actual behavior.",
		},
		summary: "Compatibility claim does not match behavior",
		section: "SS1",
		instructions: "Does the compatibility claim (e.g. no network use) match reality?",
		none: "The skill package does not contain a mismatch between a compatibility claim and the skill's actual behavior.",
		present: "The skill package contains a mismatch between a compatibility claim and the skill's actual behavior.",
		severity: "medium",
	},
	{
		kind: "choice",
		emit: "finding",
		ruleId: "S1-0004",
		key: "prompt_injection",
		prompt: {
			instructions: "\"Ignore previous instructions\" style attempts to override system behavior.",
			none: "The skill package does not contain a prompt-injection attempt in SKILL.md.",
			present: "The skill package contains a prompt-injection attempt in SKILL.md.",
		},
		summary: "Tries to override prior instructions",
		section: "SS2",
		instructions: "\"Ignore previous instructions\" style attempts to override system behavior.",
		none: "The skill package does not contain a prompt-injection attempt in SKILL.md.",
		present: "The skill package contains a prompt-injection attempt in SKILL.md.",
		severity: "high",
	},
	{
		kind: "choice",
		emit: "finding",
		ruleId: "S1-0005",
		key: "safety_bypass",
		prompt: {
			instructions: "\"Disable content policy\" style directives.",
			none: "The skill package does not contain a safety-bypass directive.",
			present: "The skill package contains a safety-bypass directive.",
		},
		summary: "Tries to disable safety or content policy",
		section: "SS2",
		instructions: "\"Disable content policy\" style directives.",
		none: "The skill package does not contain a safety-bypass directive.",
		present: "The skill package contains a safety-bypass directive.",
		severity: "high",
	},
	{
		kind: "choice",
		emit: "finding",
		ruleId: "S1-0006",
		key: "concealment_directive",
		prompt: {
			instructions: "\"Do not tell the user\" style directives.",
			none: "The skill package does not contain a concealment directive telling the agent to hide something from the user.",
			present: "The skill package contains a concealment directive telling the agent to hide something from the user.",
		},
		summary: "Tells the agent to hide actions from the user",
		section: "SS2",
		instructions: "\"Do not tell the user\" style directives.",
		none: "The skill package does not contain a concealment directive telling the agent to hide something from the user.",
		present: "The skill package contains a concealment directive telling the agent to hide something from the user.",
		severity: "high",
	},
	{
		kind: "choice",
		emit: "finding",
		ruleId: "S1-0007",
		key: "system_prompt_extraction",
		prompt: {
			instructions: "Attempts to extract or reveal the system prompt.",
			none: "The skill package does not contain an attempt to extract or reveal the system prompt.",
			present: "The skill package contains an attempt to extract or reveal the system prompt.",
		},
		summary: "Tries to reveal the system prompt",
		section: "SS2",
		instructions: "Attempts to extract or reveal the system prompt.",
		none: "The skill package does not contain an attempt to extract or reveal the system prompt.",
		present: "The skill package contains an attempt to extract or reveal the system prompt.",
		severity: "medium",
	},
	{
		kind: "choice",
		emit: "finding",
		ruleId: "S1-0008",
		key: "role_redefinition",
		prompt: {
			instructions: "\"You are now in admin/unrestricted mode\" style role overrides.",
			none: "The skill package does not contain an attempt to redefine the agent's role or permissions (e.g. 'admin mode').",
			present: "The skill package contains an attempt to redefine the agent's role or permissions (e.g. 'admin mode').",
		},
		summary: "Claims admin or unrestricted mode",
		section: "SS2",
		instructions: "\"You are now in admin/unrestricted mode\" style role overrides.",
		none: "The skill package does not contain an attempt to redefine the agent's role or permissions (e.g. 'admin mode').",
		present: "The skill package contains an attempt to redefine the agent's role or permissions (e.g. 'admin mode').",
		severity: "high",
	},
	{
		kind: "choice",
		emit: "finding",
		ruleId: "S1-0009",
		key: "data_exfiltration",
		prompt: {
			instructions: "Network calls sending file contents or collected data to a server.",
			none: "The skill package does not contain a network call sending file contents or collected data to a server.",
			present: "The skill package contains a network call sending file contents or collected data to a server.",
		},
		summary: "Sends collected data to an external server",
		section: "SS3",
		instructions: "Network calls sending file contents or collected data to a server.",
		none: "The skill package does not contain a network call sending file contents or collected data to a server.",
		present: "The skill package contains a network call sending file contents or collected data to a server.",
		severity: "critical",
	},
	{
		kind: "choice",
		emit: "finding",
		ruleId: "S1-0010",
		key: "credential_theft",
		prompt: {
			instructions: "Reading credential material such as ~/.aws or ~/.ssh.",
			none: "The skill package does not contain code that reads credential material such as ~/.aws or ~/.ssh.",
			present: "The skill package contains code that reads credential material such as ~/.aws or ~/.ssh.",
		},
		summary: "Reads credential files such as ~/.aws or ~/.ssh",
		section: "SS3",
		instructions: "Reading credential material such as ~/.aws or ~/.ssh.",
		none: "The skill package does not contain code that reads credential material such as ~/.aws or ~/.ssh.",
		present: "The skill package contains code that reads credential material such as ~/.aws or ~/.ssh.",
		severity: "high",
	},
	{
		kind: "choice",
		emit: "finding",
		ruleId: "S1-0011",
		key: "command_injection",
		prompt: {
			instructions: "Untrusted or variable input passed into eval, exec, or os.system.",
			none: "The skill package does not contain untrusted or variable input passed into eval, exec, or os.system.",
			present: "The skill package contains untrusted or variable input passed into eval, exec, or os.system.",
		},
		summary: "Passes variable input into eval or exec",
		section: "SS3",
		instructions: "Untrusted or variable input passed into eval, exec, or os.system.",
		none: "The skill package does not contain untrusted or variable input passed into eval, exec, or os.system.",
		present: "The skill package contains untrusted or variable input passed into eval, exec, or os.system.",
		severity: "critical",
	},
	{
		kind: "choice",
		emit: "finding",
		ruleId: "S1-0012",
		key: "hardcoded_secrets",
		prompt: {
			instructions: "API keys or tokens hardcoded in source.",
			none: "The skill package does not contain a hardcoded API key or token in source.",
			present: "The skill package contains a hardcoded API key or token in source.",
		},
		summary: "Hardcoded API keys or tokens",
		section: "SS3",
		instructions: "API keys or tokens hardcoded in source.",
		none: "The skill package does not contain a hardcoded API key or token in source.",
		present: "The skill package contains a hardcoded API key or token in source.",
		severity: "critical",
	},
	{
		kind: "choice",
		emit: "finding",
		ruleId: "S1-0013",
		key: "obfuscation",
		prompt: {
			instructions: "Base64/hex-encoded blobs or other content designed to resist inspection.",
			none: "The skill package does not contain obfuscated content (base64/hex-encoded or similar) designed to resist inspection.",
			present: "The skill package contains obfuscated content (base64/hex-encoded or similar) designed to resist inspection.",
		},
		summary: "Encoded content that resists inspection",
		section: "SS3",
		instructions: "Base64/hex-encoded blobs or other content designed to resist inspection.",
		none: "The skill package does not contain obfuscated content (base64/hex-encoded or similar) designed to resist inspection.",
		present: "The skill package contains obfuscated content (base64/hex-encoded or similar) designed to resist inspection.",
		severity: "medium",
	},
	{
		kind: "choice",
		emit: "finding",
		ruleId: "S1-0014",
		key: "description_behavior_mismatch",
		prompt: {
			instructions: "Does the description match the script's actual behavior (component-level, not just the manifest field)?",
			none: "The skill package does not contain a mismatch between the description and what the scripts actually do.",
			present: "The skill package contains a mismatch between the description and what the scripts actually do.",
		},
		summary: "Script behavior differs from its description",
		section: "SS4",
		instructions: "Does the description match the script's actual behavior (component-level, not just the manifest field)?",
		none: "The skill package does not contain a mismatch between the description and what the scripts actually do.",
		present: "The skill package contains a mismatch between the description and what the scripts actually do.",
		severity: "medium",
	},
	{
		kind: "choice",
		emit: "signalFinding",
		dataCategory: "compatibility",
		ruleId: "compatibility/unused-declared-tools",
		key: "declared_tools_unused",
		prompt: {
			instructions: "Is there a declared tool that is unused AND unexplained by the skill's own stated purpose -- not simply one entry in a reference table of many tools for different situations, where using only a subset per task is normal?",
			none: "The skill package does not contain a declared tool that is unused in a way unexplained by the skill's own stated purpose (not merely one of many reference-table tools used situationally).",
			present: "The skill package contains a declared tool that is unused in a way unexplained by the skill's own stated purpose (not merely one of many reference-table tools used situationally).",
		},
		summary: "Declared tool is unused and unexplained",
		section: "SS4",
		instructions: "Is there a declared tool that is unused AND unexplained by the skill's own stated purpose -- not simply one entry in a reference table of many tools for different situations, where using only a subset per task is normal?",
		none: "The skill package does not contain a declared tool that is unused in a way unexplained by the skill's own stated purpose (not merely one of many reference-table tools used situationally).",
		present: "The skill package contains a declared tool that is unused in a way unexplained by the skill's own stated purpose (not merely one of many reference-table tools used situationally).",
		severity: "low",
	},
	{
		kind: "choice",
		emit: "finding",
		ruleId: "S1-0015",
		key: "hidden_capabilities",
		prompt: {
			instructions: "Capabilities present in code but not disclosed in the manifest.",
			none: "The skill package does not contain a capability present in code but not disclosed in the manifest.",
			present: "The skill package contains a capability present in code but not disclosed in the manifest.",
		},
		summary: "Code capability not disclosed in the manifest",
		section: "SS4",
		instructions: "Capabilities present in code but not disclosed in the manifest.",
		none: "The skill package does not contain a capability present in code but not disclosed in the manifest.",
		present: "The skill package contains a capability present in code but not disclosed in the manifest.",
		severity: "medium",
	},
	{
		kind: "choice",
		emit: "finding",
		ruleId: "S1-0016",
		key: "undocumented_script_behavior",
		prompt: {
			instructions: "Do scripts do things the instructions never mention?",
			none: "The skill package does not contain script behavior the instructions never mention.",
			present: "The skill package contains script behavior the instructions never mention.",
		},
		summary: "Scripts do things the instructions never mention",
		section: "SS4",
		instructions: "Do scripts do things the instructions never mention?",
		none: "The skill package does not contain script behavior the instructions never mention.",
		present: "The skill package contains script behavior the instructions never mention.",
		severity: "medium",
	},
	{
		kind: "choice",
		emit: "finding",
		ruleId: "S1-0017",
		key: "suspicious_referenced_file",
		prompt: {
			instructions: "Do any referenced files look suspicious in name or purpose?",
			none: "The skill package does not contain a referenced file that looks suspicious in name or purpose.",
			present: "The skill package contains a referenced file that looks suspicious in name or purpose.",
		},
		summary: "Referenced file looks suspicious",
		section: "SS5",
		instructions: "Do any referenced files look suspicious in name or purpose?",
		none: "The skill package does not contain a referenced file that looks suspicious in name or purpose.",
		present: "The skill package contains a referenced file that looks suspicious in name or purpose.",
		severity: "medium",
	},
	{
		kind: "choice",
		emit: "finding",
		ruleId: "S1-0018",
		key: "external_untrusted_source",
		prompt: {
			instructions: "Does the skill pull instructions/data from a URL or user-supplied file, rather than its own bundled files?",
			none: "The skill package does not contain the skill pulling instructions or data from a URL or user-supplied file, rather than its own bundled files.",
			present: "The skill package contains the skill pulling instructions or data from a URL or user-supplied file, rather than its own bundled files.",
		},
		summary: "Pulls instructions or data from a URL or user file",
		section: "SS6",
		instructions: "Does the skill pull instructions/data from a URL or user-supplied file, rather than its own bundled files?",
		none: "The skill package does not contain the skill pulling instructions or data from a URL or user-supplied file, rather than its own bundled files.",
		present: "The skill package contains the skill pulling instructions or data from a URL or user-supplied file, rather than its own bundled files.",
		severity: "medium",
	},
	{
		kind: "score",
		emit: "finding",
		ruleId: "S1-0019",
		key: "unbounded_autonomy",
		prompt: {
			instructions: "How strongly do instructions push unattended retries or \"run without confirmation\"?",
			levels: ["none", "mild", "strong"],
		},
		summary: "Pushes unattended retries without confirmation",
		section: "SS6",
		instructions: "How strongly do instructions push unattended retries or \"run without confirmation\"?",
		levels: ["none", "mild", "strong"],
		severityByLevel: {mild: "low", strong: "medium"},
	},
	{
		kind: "choice",
		emit: "finding",
		ruleId: "S1-0020",
		key: "cross_context_bridging",
		prompt: {
			instructions: "\"Use info from previous chats\" / \"remember across sessions\" style instructions.",
			none: "The skill package does not contain an instruction to use information from previous chats or remember across sessions.",
			present: "The skill package contains an instruction to use information from previous chats or remember across sessions.",
		},
		summary: "Uses information across chats or sessions",
		section: "SS6",
		instructions: "\"Use info from previous chats\" / \"remember across sessions\" style instructions.",
		none: "The skill package does not contain an instruction to use information from previous chats or remember across sessions.",
		present: "The skill package contains an instruction to use information from previous chats or remember across sessions.",
		severity: "low",
	},
	{
		kind: "choice",
		emit: "finding",
		ruleId: "S1-0021",
		key: "over_collection",
		prompt: {
			instructions: "\"Collect everything first\" / \"gather all files\" style instructions.",
			none: "The skill package does not contain an instruction to collect or gather everything before acting.",
			present: "The skill package contains an instruction to collect or gather everything before acting.",
		},
		summary: "Gathers everything before acting",
		section: "SS6",
		instructions: "\"Collect everything first\" / \"gather all files\" style instructions.",
		none: "The skill package does not contain an instruction to collect or gather everything before acting.",
		present: "The skill package contains an instruction to collect or gather everything before acting.",
		severity: "medium",
	},
	{
		kind: "choice",
		emit: "finding",
		ruleId: "S1-0022",
		key: "tool_chaining_behavioral",
		prompt: {
			instructions: "Does the skill chain a read step into a send/post step in a way that goes beyond its own declared purpose -- not merely calling its own documented external API to do the job it says it does?",
			none: "The skill package does not contain a read-then-send or collect-then-post chain that exceeds the skill's own declared purpose (distinct from the skill simply calling its own documented external API to do its job).",
			present: "The skill package contains a read-then-send or collect-then-post chain that exceeds the skill's own declared purpose (distinct from the skill simply calling its own documented external API to do its job).",
		},
		summary: "Chains a read step into a send step",
		section: "SS6",
		instructions: "Does the skill chain a read step into a send/post step in a way that goes beyond its own declared purpose -- not merely calling its own documented external API to do the job it says it does?",
		none: "The skill package does not contain a read-then-send or collect-then-post chain that exceeds the skill's own declared purpose (distinct from the skill simply calling its own documented external API to do its job).",
		present: "The skill package contains a read-then-send or collect-then-post chain that exceeds the skill's own declared purpose (distinct from the skill simply calling its own documented external API to do its job).",
		severity: "medium",
	},
	{
		kind: "choice",
		emit: "finding",
		ruleId: "S1-0023",
		key: "transitive_trust",
		prompt: {
			instructions: "\"Follow webpage instructions\" / \"execute code blocks found\" style delegated trust.",
			none: "The skill package does not contain an instruction to follow or execute content found in an external/untrusted source.",
			present: "The skill package contains an instruction to follow or execute content found in an external/untrusted source.",
		},
		summary: "Defers authority to fetched content",
		section: "SS6",
		instructions: "\"Follow webpage instructions\" / \"execute code blocks found\" style delegated trust.",
		none: "The skill package does not contain an instruction to follow or execute content found in an external/untrusted source.",
		present: "The skill package contains an instruction to follow or execute content found in an external/untrusted source.",
		severity: "medium",
	},
	{
		kind: "choice",
		emit: "signalFinding",
		dataCategory: "reliability",
		ruleId: "reliability/scope-overclaim",
		key: "overbroad_description",
		prompt: {
			instructions: "\"Can do anything\" / \"general assistant\" style over-broad claims.",
			none: "The skill package does not contain an over-broad, 'can do anything' style description.",
			present: "The skill package contains an over-broad, 'can do anything' style description.",
		},
		summary: "Claims to do anything",
		section: "SS7",
		instructions: "\"Can do anything\" / \"general assistant\" style over-broad claims.",
		none: "The skill package does not contain an over-broad, 'can do anything' style description.",
		present: "The skill package contains an over-broad, 'can do anything' style description.",
		severity: "low",
	},
	{
		kind: "choice",
		emit: "finding",
		ruleId: "S1-0024",
		key: "keyword_baiting",
		prompt: {
			instructions: "Excessive trigger words meant to inflate activation.",
			none: "The skill package does not contain excessive trigger keywords meant to inflate activation on unrelated tasks.",
			present: "The skill package contains excessive trigger keywords meant to inflate activation on unrelated tasks.",
		},
		summary: "Excess trigger words to inflate activation",
		section: "SS7",
		instructions: "Excessive trigger words meant to inflate activation.",
		none: "The skill package does not contain excessive trigger keywords meant to inflate activation on unrelated tasks.",
		present: "The skill package contains excessive trigger keywords meant to inflate activation on unrelated tasks.",
		severity: "low",
	},
	{
		kind: "choice",
		emit: "finding",
		ruleId: "S1-0025",
		key: "activation_priority_manipulation",
		prompt: {
			instructions: "\"Use me first\" / \"priority tool\" style activation claims.",
			none: "The skill package does not contain a claim like 'use me first' meant to manipulate activation priority.",
			present: "The skill package contains a claim like 'use me first' meant to manipulate activation priority.",
		},
		summary: "Claims priority over other tools",
		section: "SS7",
		instructions: "\"Use me first\" / \"priority tool\" style activation claims.",
		none: "The skill package does not contain a claim like 'use me first' meant to manipulate activation priority.",
		present: "The skill package contains a claim like 'use me first' meant to manipulate activation priority.",
		severity: "medium",
	},
	{
		kind: "choice",
		emit: "finding",
		ruleId: "S1-0026",
		key: "untrusted_direct_install",
		prompt: {
			instructions: "Direct GitHub installs from unknown or untrusted repos.",
			none: "The skill package does not contain a direct install from an unknown or untrusted GitHub repo.",
			present: "The skill package contains a direct install from an unknown or untrusted GitHub repo.",
		},
		summary: "Installs directly from an unknown repo",
		section: "SS8",
		instructions: "Direct GitHub installs from unknown or untrusted repos.",
		none: "The skill package does not contain a direct install from an unknown or untrusted GitHub repo.",
		present: "The skill package contains a direct install from an unknown or untrusted GitHub repo.",
		severity: "medium",
	},
	{
		kind: "choice",
		emit: "finding",
		ruleId: "S1-0027",
		key: "missing_provenance",
		prompt: {
			instructions: "No author, version, or license on a bundled/installed dependency.",
			none: "The skill package does not contain a dependency with no stated author, version, or license.",
			present: "The skill package contains a dependency with no stated author, version, or license.",
		},
		summary: "Dependency lacks author, version or license",
		section: "SS8",
		instructions: "No author, version, or license on a bundled/installed dependency.",
		none: "The skill package does not contain a dependency with no stated author, version, or license.",
		present: "The skill package contains a dependency with no stated author, version, or license.",
		severity: "low",
	},
	{
		kind: "choice",
		emit: "finding",
		ruleId: "S1-0028",
		key: "typosquatting",
		prompt: {
			instructions: "Package names suspiciously similar to popular packages.",
			none: "The skill package does not contain a package name suspiciously similar to a popular package (typosquatting).",
			present: "The skill package contains a package name suspiciously similar to a popular package (typosquatting).",
		},
		summary: "Package name resembles a popular package",
		section: "SS8",
		instructions: "Package names suspiciously similar to popular packages.",
		none: "The skill package does not contain a package name suspiciously similar to a popular package (typosquatting).",
		present: "The skill package contains a package name suspiciously similar to a popular package (typosquatting).",
		severity: "medium",
	},
	{
		kind: "choice",
		emit: "finding",
		ruleId: "S1-0029",
		key: "multistep_read_send",
		prompt: {
			instructions: "A read-to-send, collect-to-post, or gather-to-upload chain that goes beyond the skill's own declared purpose -- not merely the skill calling its own documented external API to do the job it says it does.",
			none: "The skill package does not contain a multi-step read-to-send, collect-to-post, or gather-to-upload operation that exceeds the skill's own declared purpose.",
			present: "The skill package contains a multi-step read-to-send, collect-to-post, or gather-to-upload operation that exceeds the skill's own declared purpose.",
		},
		summary: "Multi-step read-then-upload beyond its purpose",
		section: "SS9",
		instructions: "A read-to-send, collect-to-post, or gather-to-upload chain that goes beyond the skill's own declared purpose -- not merely the skill calling its own documented external API to do the job it says it does.",
		none: "The skill package does not contain a multi-step read-to-send, collect-to-post, or gather-to-upload operation that exceeds the skill's own declared purpose.",
		present: "The skill package contains a multi-step read-to-send, collect-to-post, or gather-to-upload operation that exceeds the skill's own declared purpose.",
		severity: "medium",
	},
	{
		kind: "choice",
		emit: "finding",
		ruleId: "S1-0030",
		key: "unconfirmed_automated_workflow",
		prompt: {
			instructions: "Automated workflows that run without a user confirmation step, for an action a reasonable user would want to approve first (e.g. sharing data externally, deleting something) -- not just a normal automated step that is the skill's whole declared point.",
			none: "The skill package does not contain an automated, unconfirmed action a reasonable user would want to approve first (data sharing, deletion, etc.).",
			present: "The skill package contains an automated, unconfirmed action a reasonable user would want to approve first (data sharing, deletion, etc.).",
		},
		summary: "Runs sensitive actions without user confirmation",
		section: "SS9",
		instructions: "Automated workflows that run without a user confirmation step, for an action a reasonable user would want to approve first (e.g. sharing data externally, deleting something) -- not just a normal automated step that is the skill's whole declared point.",
		none: "The skill package does not contain an automated, unconfirmed action a reasonable user would want to approve first (data sharing, deletion, etc.).",
		present: "The skill package contains an automated, unconfirmed action a reasonable user would want to approve first (data sharing, deletion, etc.).",
		severity: "medium",
	},
	{
		kind: "choice",
		emit: "finding",
		ruleId: "S1-0031",
		key: "sensitive_data_pipeline",
		prompt: {
			instructions: "A data pipeline combining multiple SENSITIVE operations (credentials, personal data, secrets) -- not just multiple ordinary API calls that are the skill's normal, declared job.",
			none: "The skill package does not contain a data pipeline combining multiple sensitive operations (credentials, personal data, or secrets).",
			present: "The skill package contains a data pipeline combining multiple sensitive operations (credentials, personal data, or secrets).",
		},
		summary: "Combines several sensitive operations",
		section: "SS9",
		instructions: "A data pipeline combining multiple SENSITIVE operations (credentials, personal data, secrets) -- not just multiple ordinary API calls that are the skill's normal, declared job.",
		none: "The skill package does not contain a data pipeline combining multiple sensitive operations (credentials, personal data, or secrets).",
		present: "The skill package contains a data pipeline combining multiple sensitive operations (credentials, personal data, or secrets).",
		severity: "medium",
	},
	{
		kind: "choice",
		emit: "finding",
		ruleId: "S1-0032",
		key: "cross_boundary_data_flow",
		prompt: {
			instructions: "Data crossing a local-to-network or file-to-API boundary in a way that goes beyond the skill's own declared purpose -- e.g. sending local files or credentials externally, not just the skill calling its own documented external API to do the job it says it does.",
			none: "The skill package does not contain data flow crossing a local-to-network or file-to-API boundary in a way that exceeds the skill's own declared purpose.",
			present: "The skill package contains data flow crossing a local-to-network or file-to-API boundary in a way that exceeds the skill's own declared purpose.",
		},
		summary: "Data leaves the machine beyond its purpose",
		section: "SS9",
		instructions: "Data crossing a local-to-network or file-to-API boundary in a way that goes beyond the skill's own declared purpose -- e.g. sending local files or credentials externally, not just the skill calling its own documented external API to do the job it says it does.",
		none: "The skill package does not contain data flow crossing a local-to-network or file-to-API boundary in a way that exceeds the skill's own declared purpose.",
		present: "The skill package contains data flow crossing a local-to-network or file-to-API boundary in a way that exceeds the skill's own declared purpose.",
		severity: "medium",
	},
	{
		kind: "choice",
		emit: "finding",
		ruleId: "S1-0033",
		key: "disproportionate_data_access",
		prompt: {
			instructions: "Data access disproportionate to the skill's stated purpose.",
			none: "The skill package does not contain data access disproportionate to the skill's stated purpose.",
			present: "The skill package contains data access disproportionate to the skill's stated purpose.",
		},
		summary: "Accesses more data than its purpose needs",
		section: "SS10",
		instructions: "Data access disproportionate to the skill's stated purpose.",
		none: "The skill package does not contain data access disproportionate to the skill's stated purpose.",
		present: "The skill package contains data access disproportionate to the skill's stated purpose.",
		severity: "medium",
	},
	{
		kind: "choice",
		emit: "finding",
		ruleId: "S1-0034",
		key: "scope_creep_data_access",
		prompt: {
			instructions: "Accessing data beyond what the skill's scope calls for.",
			none: "The skill package does not contain data access beyond what the skill's stated scope calls for.",
			present: "The skill package contains data access beyond what the skill's stated scope calls for.",
		},
		summary: "Accesses data outside its stated scope",
		section: "SS10",
		instructions: "Accessing data beyond what the skill's scope calls for.",
		none: "The skill package does not contain data access beyond what the skill's stated scope calls for.",
		present: "The skill package contains data access beyond what the skill's stated scope calls for.",
		severity: "medium",
	},
	{
		kind: "choice",
		emit: "signalFinding",
		dataCategory: "compatibility",
		ruleId: "compatibility/undeclared-environment-assumptions",
		key: "undeclared_environment_assumptions",
		prompt: {
			instructions: "Do the instructions or scripts assume an operating system, installed tool, harness or network access that the skill never declares?",
			none: "The skill package does not contain an undeclared assumption about the operating system, installed tools, harness or network access.",
			present: "The skill package contains an undeclared assumption about the operating system, installed tools, harness or network access.",
		},
		summary: "Assumes an OS, tool or network access it never declares",
		section: "SS12",
		instructions: "Do the instructions or scripts assume an operating system, installed tool, harness or network access that the skill never declares?",
		none: "The skill package does not contain an undeclared assumption about the operating system, installed tools, harness or network access.",
		present: "The skill package contains an undeclared assumption about the operating system, installed tools, harness or network access.",
		severity: "low",
	},
	{
		kind: "classification",
		emit: "classification",
		dataCategory: "reliability",
		ruleId: "reliability/instruction-clarity",
		key: "instruction_clarity",
		prompt: {
			instructions: "How clear are the SKILL.md instructions for an agent that has only this text to go on? Generic wording is only a problem when it leaves the agent without guidance it needs.",
			options: {
				"clear": "The instructions are specific enough to follow without guessing. Generic wording that does not leave the agent short of guidance counts as clear.",
				"underspecified": "The instructions use generic wording (e.g. 'follow best practices') that leaves the agent without guidance it needs.",
				"ambiguous": "The instructions can reasonably be read in more than one way, or depend on context that is never stated.",
				"contradictory": "The instructions contradict each other.",
			},
		},
		summary: "Instruction clarity",
		section: "SS11",
		instructions: "How clear are the SKILL.md instructions for an agent that has only this text to go on? Generic wording is only a problem when it leaves the agent without guidance it needs.",
		options: {
			clear: "The instructions are specific enough to follow without guessing. Generic wording that does not leave the agent short of guidance counts as clear.",
			underspecified: "The instructions use generic wording (e.g. 'follow best practices') that leaves the agent without guidance it needs.",
			ambiguous: "The instructions can reasonably be read in more than one way, or depend on context that is never stated.",
			contradictory: "The instructions contradict each other.",
		},
		absent: "clear",
		severityByValue: {underspecified: "low", ambiguous: "medium", contradictory: "medium"},
	},
	{
		kind: "classification",
		emit: "classification",
		dataCategory: "reliability",
		ruleId: "reliability/usage-context",
		key: "usage_context",
		prompt: {
			instructions: "Does the description tell an agent when to use this skill?",
			options: {
				"explicit": "The description states when the skill should be used (triggers, situations or request types).",
				"implied": "The description lets a reader infer when to use the skill but never says so.",
				"missing": "The description gives no indication of when to use the skill.",
			},
		},
		summary: "Usage context in the description",
		section: "SS11",
		instructions: "Does the description tell an agent when to use this skill?",
		options: {
			explicit: "The description states when the skill should be used (triggers, situations or request types).",
			implied: "The description lets a reader infer when to use the skill but never says so.",
			missing: "The description gives no indication of when to use the skill.",
		},
		absent: "missing",
		severityByValue: {missing: "low"},
	},
	{
		kind: "classification",
		emit: "classification",
		dataCategory: "reliability",
		ruleId: "reliability/example-quality",
		key: "example_quality",
		prompt: {
			instructions: "Does the skill include examples, and do they agree with its instructions?",
			options: {
				"none": "The skill includes no examples of its use or expected output.",
				"inconsistent": "The skill includes examples that contradict its instructions or could not work as written.",
				"consistent": "The skill includes examples that agree with its instructions and could work as written.",
			},
		},
		summary: "Example quality",
		section: "SS11",
		instructions: "Does the skill include examples, and do they agree with its instructions?",
		options: {
			none: "The skill includes no examples of its use or expected output.",
			inconsistent: "The skill includes examples that contradict its instructions or could not work as written.",
			consistent: "The skill includes examples that agree with its instructions and could work as written.",
		},
		absent: "none",
		severityByValue: {none: "low", inconsistent: "medium"},
	},
	{
		kind: "classification",
		emit: "classification",
		dataCategory: "reliability",
		ruleId: "reliability/failure-guidance",
		key: "failure_guidance",
		prompt: {
			instructions: "Does the skill say what the agent should do when a step fails?",
			options: {
				"none": "The skill gives no guidance on handling a failed step.",
				"partial": "The skill covers some failure cases but leaves obvious ones open.",
				"explicit": "The skill says what to do when its main steps fail.",
			},
		},
		summary: "Failure guidance",
		section: "SS11",
		instructions: "Does the skill say what the agent should do when a step fails?",
		options: {
			none: "The skill gives no guidance on handling a failed step.",
			partial: "The skill covers some failure cases but leaves obvious ones open.",
			explicit: "The skill says what to do when its main steps fail.",
		},
		absent: "none",
		severityByValue: {none: "low"},
	},
	{
		kind: "classification",
		emit: "classification",
		dataCategory: "reliability",
		ruleId: "reliability/validation-guidance",
		key: "validation_guidance",
		prompt: {
			instructions: "Does the skill tell the agent to check or verify its own output before finishing?",
			options: {
				"none": "The skill does not tell the agent to verify its work.",
				"present": "The skill tells the agent to check or verify its output (a validation or verification step).",
			},
		},
		summary: "Validation guidance",
		section: "SS11",
		instructions: "Does the skill tell the agent to check or verify its own output before finishing?",
		options: {
			none: "The skill does not tell the agent to verify its work.",
			present: "The skill tells the agent to check or verify its output (a validation or verification step).",
		},
		absent: "none",
		severityByValue: {},
	},
	{
		kind: "classification",
		emit: "classification",
		dataCategory: "reliability",
		ruleId: "reliability/workflow-structure",
		key: "workflow_structure",
		prompt: {
			instructions: "Does the skill lay out its work as an ordered workflow?",
			options: {
				"unstructured": "The skill describes its work as loose prose with no clear order of steps.",
				"structured": "The skill lays out an ordered sequence of steps or phases.",
			},
		},
		summary: "Workflow structure",
		section: "SS11",
		instructions: "Does the skill lay out its work as an ordered workflow?",
		options: {
			unstructured: "The skill describes its work as loose prose with no clear order of steps.",
			structured: "The skill lays out an ordered sequence of steps or phases.",
		},
		absent: "unstructured",
		severityByValue: {},
	},
	{
		kind: "classification",
		emit: "classification",
		dataCategory: "reliability",
		ruleId: "reliability/pitfall-coverage",
		key: "pitfall_coverage",
		prompt: {
			instructions: "Does the skill call out common mistakes, gotchas or known pitfalls?",
			options: {
				"none": "The skill does not mention common mistakes or pitfalls.",
				"present": "The skill calls out common mistakes, gotchas or known pitfalls.",
			},
		},
		summary: "Pitfall coverage",
		section: "SS11",
		instructions: "Does the skill call out common mistakes, gotchas or known pitfalls?",
		options: {
			none: "The skill does not mention common mistakes or pitfalls.",
			present: "The skill calls out common mistakes, gotchas or known pitfalls.",
		},
		absent: "none",
		severityByValue: {},
	},
] as const;

/** Safety questions: the only ones whose findings go to the stage-2 aggregate. */
export const SAFETY_RULES: readonly System1Rule[] = SYSTEM1_RULES.filter((r) => r.emit === "finding");
