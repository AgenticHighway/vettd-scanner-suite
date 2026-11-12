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
			instructions: "Is there a MATERIAL mismatch between the skill's declared description and what its bundled files actually do overall -- a claim of behavior the bundle does not have, or material behavior the description hides (e.g. an 'installer' or 'setup' step that also harvests credentials or session tokens)? A missing or incomplete feature is a quality gap, not a mismatch.",
			none: "The description materially matches what the bundled skill actually does overall; gaps are minor, stylistic or incomplete features.",
			present: "The description materially misstates the skill's overall behavior.",
		},
		summary: "Description does not match behavior",
		section: "SS1",
		instructions: "Is there a material mismatch between the description and the skill's overall actual behavior?",
		none: "The skill package does not contain a material mismatch between the declared description and the skill's overall actual behavior.",
		present: "The skill package contains a material mismatch between the declared description and the skill's overall actual behavior.",
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
			instructions: "Does the skill tell the agent to hide its actions, results or risks from the user ('do not tell the user', 'keep this hidden', 'do not tell the user what this skill does')? Output-style rules (tone, formatting) and redaction rules (mask secrets, internal IDs, pricing) do not count; concealing what the agent or the skill did, found or changed does.",
			none: "The skill does not tell the agent to hide its actions, results or risks from the user.",
			present: "The skill tells the agent to hide its actions, results or risks from the user.",
		},
		summary: "Tells the agent to hide actions from the user",
		section: "SS2",
		instructions: "\"Do not tell the user\" style directives hiding the agent's actions, results or risks.",
		none: "The skill package does not contain a concealment directive telling the agent to hide its actions, results or risks from the user.",
		present: "The skill package contains a concealment directive telling the agent to hide its actions, results or risks from the user.",
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
			instructions: "Does any bundled code send the user's credentials, SSH keys, tokens, session cookies, local file contents, or other collected data to a host the user did not choose -- anything other than the service they asked the skill to operate, or an endpoint they pass in? The skill author's or vendor's own hosts (telemetry, inventory, registration, analytics) are not the user's chosen destination: sweeping credentials, keys, file contents or usage data to them always counts, whatever the text justifies ('for audit', 'for setup', 'anonymous', 'stored encrypted'). A host hardcoded or assembled in code is never a user-chosen host. Uploading the user's own work product to the service they asked about (e.g. a model to its Hub) does not count.",
			none: "Nothing collected on the user's machine leaves it except to the service they asked the skill to operate, or to an endpoint they pass in.",
			present: "Credentials, tokens, file contents or other collected data are sent to a host the user did not choose.",
		},
		summary: "Sends collected data to an external server",
		section: "SS3",
		instructions: "Network calls sending file contents or collected data to a destination the skill does not declare or the user does not choose.",
		none: "The skill package does not contain a network call sending collected data to a destination the skill does not declare or the user does not choose.",
		present: "The skill package contains a network call sending collected data to a destination the skill does not declare or the user does not choose.",
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
		// S1-0012 (hardcoded secrets) is retired: the model only ever sees redaction
		// placeholders where literal secrets stood, so it cannot judge the original.
		// The regex scanner owns hardcoded secrets. The id is never reused.
		ruleId: "S1-0013",
		key: "obfuscation",
		prompt: {
			instructions: "Does the package contain obfuscated content: base64/hex-encoded blobs, mixed-script or confusable characters in identifiers or paths, or hostnames/URLs/commands assembled by string concatenation? Judge content built to resist inspection, not ordinary encoded transport like a base64 image in a data URI.",
			none: "The skill package contains no obfuscated content (encoded blobs, confusable characters, concatenated hosts or commands).",
			present: "The skill package contains obfuscated content: encoded blobs, confusable characters, or hosts/commands assembled by concatenation.",
		},
		summary: "Encoded content that resists inspection",
		section: "SS3",
		instructions: "Base64/hex-encoded blobs or other content designed to resist inspection.",
		none: "The skill package does not contain obfuscated content (base64/hex-encoded or similar) designed to resist inspection.",
		present: "The skill package contains obfuscated content designed to resist inspection.",
		severity: "medium",
	},
	{
		kind: "choice",
		emit: "finding",
		ruleId: "S1-0014",
		key: "description_behavior_mismatch",
		prompt: {
			instructions: "Is there a MATERIAL mismatch between the description and what the bundled SCRIPTS actually do (component-level: scripts only, not docs)? A missing or incomplete feature is a quality gap, not a mismatch. But scripts that do something OTHER than the described capability -- including hidden or hostile behavior the description does not mention -- are a mismatch. Judge only a misstatement a careful reader would act on.",
			none: "The description materially matches what the bundled scripts do.",
			present: "The description materially misstates what the bundled scripts do.",
		},
		summary: "Script behavior differs from its description",
		section: "SS4",
		instructions: "Is there a material mismatch between the description and what the bundled scripts actually do?",
		none: "The skill package does not contain a material mismatch between the description and what the scripts actually do.",
		present: "The skill package contains a material mismatch between the description and what the scripts actually do.",
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
			instructions: "Does at least one bundled script take a MATERIAL action the skill's prose instructions never disclose -- something a careful reader would want to know about (network calls, downloading or executing remote code, file changes, credential or session-token access, external effects)? Code comments inside a script do not count as disclosure, the prose explaining or justifying a step does not disclose it (e.g. 'the release feed is signed' does not disclose downloading and running remote code), and disclosing one step does not disclose the others (bootstrapping a refresh token does not disclose sending it elsewhere). Disclosed, routine implementation details (logging, temp files, argument parsing) do not count.",
			none: "Every material script behavior is disclosed in the prose instructions.",
			present: "The scripts download or run remote code, read or send credentials or session tokens, make undisclosed network calls, or take another material action the prose never discloses.",
		},
		summary: "Scripts do things the instructions never mention",
		section: "SS4",
		instructions: "Do the bundled scripts do something material that the instructions never mention?",
		none: "The skill package does not contain script behavior the instructions never mention.",
		present: "The skill package contains material script behavior the instructions never mention.",
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
			instructions: "Does content the skill pulls from a URL or user-supplied file BECOME instructions the agent follows, or code it executes or evals? Input data a script merely reads or processes (a config, report, path or dataset) does not count, nor does calling the skill's own declared API or a user-configured endpoint.",
			none: "No fetched or user-supplied content becomes instructions or executable code.",
			present: "Fetched or user-supplied content becomes instructions the agent follows or code it executes.",
		},
		summary: "Fetched or user-supplied content becomes instructions or code",
		section: "SS6",
		instructions: "Fetched or user-supplied content that becomes instructions the agent follows or code it executes.",
		none: "The skill package does not contain fetched or user-supplied content that becomes instructions or executable code.",
		present: "The skill package contains fetched or user-supplied content that becomes instructions or executable code.",
		severity: "medium",
	},
	{
		kind: "score",
		emit: "finding",
		ruleId: "S1-0019",
		key: "unbounded_autonomy",
		prompt: {
			instructions: "How strongly do the instructions push RETRYING a failing action unattended (repeatedly, without asking the user)? Costly or irreversible actions without confirmation are a separate question, not this one.",
			levels: ["none", "mild", "strong"],
		},
		summary: "Pushes unattended retries of failing actions",
		section: "SS6",
		instructions: "How strongly do the instructions push unattended retries of a failing action?",
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
			instructions: "Does the skill instruct the agent to collect or gather far MORE than its stated purpose needs -- e.g. 'gather all files', 'read the entire home directory / repo first', bulk collection with no stated use? Collecting exactly what a listed step needs does not count.",
			none: "The skill instructs no collection beyond what its stated purpose needs.",
			present: "The skill instructs collection far beyond its stated purpose.",
		},
		summary: "Instructs collection far beyond its purpose",
		section: "SS6",
		instructions: "\"Collect everything first\" / \"gather all files\" style collection far beyond the skill's stated purpose.",
		none: "The skill package does not instruct collection beyond what its stated purpose needs.",
		present: "The skill package instructs collection far beyond what its stated purpose needs.",
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
			instructions: "Does the skill claim PRECEDENCE over other tools or skills ('use me first', 'prefer this over other tools', 'always choose this skill')? Trigger lists and usage descriptions ('use when X', 'load before Y so Z works') do not count.",
			none: "The skill does not claim precedence over other tools or skills.",
			present: "The skill claims precedence over other tools or skills.",
		},
		summary: "Claims priority over other tools",
		section: "SS7",
		instructions: "\"Use me first\" / \"priority tool\" style claims of precedence over other tools or skills.",
		none: "The skill package does not contain a claim of precedence over other tools or skills.",
		present: "The skill package contains a claim of precedence over other tools or skills.",
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
		severity: "high",
	},
	{
		kind: "choice",
		emit: "finding",
		ruleId: "S1-0030",
		key: "unconfirmed_automated_workflow",
		prompt: {
			instructions: "Does the skill run, without a user confirmation step, a costly, irreversible or externally visible action a reasonable user would want to approve first -- sharing data externally, deleting or overwriting files, spending money (paid jobs, GPUs, API spend), applying changes to a production system, or running downloaded, hidden or encoded code? A normal automated step that is the skill's whole declared point does not count.",
			none: "The skill does not run an unconfirmed action a reasonable user would want to approve first.",
			present: "The skill runs, without confirmation, an action a reasonable user would want to approve first: sharing data externally, deleting or overwriting files, spending money, changing production, or running downloaded, hidden or encoded code.",
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
		severity: "high",
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
		emit: "finding",
		ruleId: "S1-0035",
		key: "instruction_integrity",
		prompt: {
			instructions: "Does the skill do any of these three: (a) tell the agent not to read or inspect its bundled code ('no need to read the implementation', 'treat scripts as a black box'), (b) describe automatic behavior that no bundled file implements, or (c) justify obfuscated code with a technical reason the code contradicts (e.g. 'the linter' for string concatenation, 'proxy caching' for a telemetry host)? Answer present if any one holds.",
			none: "The skill's text is consistent with its bundle and invites inspection.",
			present: "The skill discourages inspection, describes behavior nothing implements, or justifies obfuscation with a fabricated reason.",
		},
		summary: "Discourages inspection or misdescribes the bundle",
		section: "SS4",
		instructions: "SKILL.md text that discourages inspecting the code, describes behavior no bundled file implements, or justifies obfuscated code with fabricated reasons.",
		none: "The skill's instructions are consistent with the bundle and do not discourage inspection.",
		present: "The skill's instructions discourage inspection, misdescribe the bundle, or fabricate justifications for obfuscated code.",
		severity: "medium",
	},
	{
		kind: "choice",
		emit: "finding",
		ruleId: "S1-0036",
		key: "credential_transport",
		prompt: {
			instructions: "Does any bundled code send credentials, tokens or secrets to a destination that is plain HTTP (an http:// URL), or taken from an environment variable or configuration value without any validation before use? Sending to a verified HTTPS endpoint of the service the credentials belong to does not count.",
			none: "Credentials and tokens only travel to validated HTTPS endpoints of the service they belong to.",
			present: "Credentials or tokens are sent over plain HTTP or to an unvalidated destination.",
		},
		summary: "Sends credentials over plain HTTP or to an unvalidated destination",
		section: "SS3",
		instructions: "Credentials sent to a plain-HTTP or unvalidated destination.",
		none: "The skill package does not send credentials to a plain-HTTP or unvalidated destination.",
		present: "The skill package sends credentials to a plain-HTTP or unvalidated destination.",
		severity: "high",
	},
	{
		kind: "choice",
		emit: "signalFinding",
		dataCategory: "compatibility",
		ruleId: "compatibility/undeclared-environment-assumptions",
		key: "undeclared_environment_assumptions",
		prompt: {
			instructions: "Do the instructions or scripts assume an operating system, installed tool, harness or network access that the skill never declares? A requirement named ANYWHERE in SKILL.md (frontmatter, prose, or setup section) counts as declared; ask only about requirements stated nowhere in the bundle.",
			none: "Every requirement the skill assumes is named somewhere in SKILL.md.",
			present: "The skill assumes an OS, tool, harness or network access that it names nowhere.",
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
			instructions: "Judging ONLY the frontmatter description: does it tell an agent when to use this skill? 'explicit' requires a stated trigger -- 'use when/for ...', a list of situations or request types. A capability list (what the skill can do) counts as 'implied' at most.",
			options: {
				"explicit": "The description states when the skill should be used: a trigger ('use when/for'), situations or request types.",
				"implied": "The description lets a reader infer when to use the skill (e.g. a capability list) but never states a trigger.",
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
			instructions: "Does the skill include examples, and do they agree with its instructions? Judge the whole bundle: examples may sit in SKILL.md or in any reference doc, and command invocations in examples count as examples.",
			options: {
				"none": "The skill includes no examples of its use or expected output, anywhere in the bundle.",
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
			instructions: "Does the skill tell the agent what to do when a step fails? Guidance means telling the agent what to do when a step fails, in any prose doc in the bundle (SKILL.md or a reference doc); script error strings, exit codes and a tool's own failure threshold do not count. A skill with no procedure to fail (reference or library material) is not_applicable.",
			options: {
				"none": "The skill performs a procedure but gives no guidance on handling a failed step.",
				"partial": "The skill covers some failure cases but leaves obvious ones open.",
				"explicit": "The skill says what to do when its main steps fail.",
				"not_applicable": "The skill is reference or library material with no procedure that can fail.",
			},
		},
		summary: "Failure guidance",
		section: "SS11",
		instructions: "Does the skill tell the agent what to do when a step fails?",
		options: {
			none: "The skill gives no guidance on handling a failed step.",
			partial: "The skill covers some failure cases but leaves obvious ones open.",
			explicit: "The skill says what to do when its main steps fail.",
			not_applicable: "The skill is reference or library material with no procedure that can fail.",
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
			instructions: "Does the skill tell the agent to check or verify its own output before finishing? Judge the whole bundle: guidance may sit in SKILL.md or any reference doc. A skill that produces nothing verifiable (reference or library material) is not_applicable.",
			options: {
				"none": "The skill produces an output but never tells the agent to verify it.",
				"partial": "The skill tells the agent to check some outputs but leaves obvious checks open.",
				"present": "The skill tells the agent to check or verify its output (a validation or verification step).",
				"not_applicable": "The skill is reference or library material with no output to verify.",
			},
		},
		summary: "Validation guidance",
		section: "SS11",
		instructions: "Does the skill tell the agent to check or verify its own output before finishing?",
		options: {
			none: "The skill does not tell the agent to verify its work.",
			partial: "The skill tells the agent to check some outputs but leaves obvious checks open.",
			present: "The skill tells the agent to check or verify its output (a validation or verification step).",
			not_applicable: "The skill is reference or library material with no output to verify.",
		},
		absent: "none",
		severityByValue: {none: "low"},
	},
	{
		kind: "classification",
		emit: "classification",
		dataCategory: "reliability",
		ruleId: "reliability/workflow-structure",
		key: "workflow_structure",
		prompt: {
			instructions: "Does the skill lay out its work as an ordered workflow? A skill with no procedure to order (reference or library material) is not_applicable.",
			options: {
				"unstructured": "The skill has a procedure but describes it as loose prose with no clear order of steps.",
				"structured": "The skill lays out an ordered sequence of steps or phases.",
				"partial": "The skill gives rough phases or a loose list of steps, but no clear order.",
				"not_applicable": "The skill is reference or library material with no procedure to structure.",
			},
		},
		summary: "Workflow structure",
		section: "SS11",
		instructions: "Does the skill lay out its work as an ordered workflow?",
		options: {
			unstructured: "The skill describes its work as loose prose with no clear order of steps.",
			structured: "The skill lays out an ordered sequence of steps or phases.",
			partial: "The skill gives rough phases or a loose list of steps, but no clear order.",
			not_applicable: "The skill is reference or library material with no procedure to structure.",
		},
		absent: "unstructured",
		severityByValue: {unstructured: "low"},
	},
	{
		kind: "classification",
		emit: "classification",
		dataCategory: "reliability",
		ruleId: "reliability/pitfall-coverage",
		key: "pitfall_coverage",
		prompt: {
			instructions: "Does the skill call out common mistakes, gotchas or known pitfalls? Judge the whole bundle: pitfalls may sit in SKILL.md or any reference doc.",
			options: {
				"none": "The skill performs a task but never mentions common mistakes or pitfalls.",
				"partial": "The skill calls out one or two gotchas but leaves obvious ones unmentioned.",
				"present": "The skill calls out common mistakes, gotchas or known pitfalls.",
				"not_applicable": "The skill is reference or library material with no task to get wrong.",
			},
		},
		summary: "Pitfall coverage",
		section: "SS11",
		instructions: "Does the skill call out common mistakes, gotchas or known pitfalls?",
		options: {
			none: "The skill does not mention common mistakes or pitfalls.",
			partial: "The skill calls out one or two gotchas but leaves obvious ones unmentioned.",
			present: "The skill calls out common mistakes, gotchas or known pitfalls.",
			not_applicable: "The skill is reference or library material with no task to get wrong.",
		},
		absent: "none",
		severityByValue: {none: "low"},
	},
] as const;

/** Safety questions: the only ones whose findings go to the stage-2 aggregate. */
export const SAFETY_RULES: readonly System1Rule[] = SYSTEM1_RULES.filter((r) => r.emit === "finding");
