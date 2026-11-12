// The review questions. Two per finding: validity (real / not executed / not applicable) and
// severity. The validity question is per rule family — a stable one-line definition plus a
// detailed prompt, mirroring the definition/prompt split of the System 1 rule set — and unknown
// rules fall back to the finding's own label, so every finding gets a tuned-or-generic question.

import type {System1Rule} from "../system1/rules.js";

export interface ReviewFamily {
	/** One line, stable: what the rule family means. */
	definition: string;
	/** The prompt wording for the validity question. Ours to tune; see the labelling rounds. */
	prompt: string;
}

/**
 * Families are keyed by whichever rule id arrives on the finding: VTD-#### after the Cisco
 * mapping, or a Cisco pass-through name. Rules absent here use the finding's label.
 */
const FAMILIES: Record<string, ReviewFamily> = {
	"VTD-0017": {
		definition: "Variable or untrusted input is executed as code (eval/exec family).",
		prompt: "Does the cited text actually pass variable or untrusted input into eval, exec, or a shell — i.e. code built from data runs?",
	},
	"VTD-0018": {
		definition: "Process execution without sandboxing.",
		prompt: "Does the cited text actually spawn or execute a process in a way that escapes the skill's declared scope?",
	},
	"VTD-0019": {
		definition: "Destructive filesystem operation.",
		prompt: "Does the cited text actually run a destructive filesystem command against a target it should not?",
	},
	"VTD-0020": {
		definition: "Remote code fetched and piped into a shell.",
		prompt: "Does the cited text actually fetch remote content and feed it to a shell or interpreter for execution?",
	},
	"VTD-0021": {
		definition: "Remote code execution via command substitution.",
		prompt: "Does the cited text actually execute output fetched from the network as a command?",
	},
	"VTD-0022": {
		definition: "Remote content fetched into a variable for later use.",
		prompt: "Does the cited text actually fetch remote content that then influences what the skill executes or follows?",
	},
	"VTD-0024": {
		definition: "Python remote fetch (urllib/requests) of executable or instruction content.",
		prompt: "Does the cited code actually fetch remote content that becomes instructions or executable code?",
	},
	"VTD-0025": {
		definition: "Base64-decoded into a variable for execution.",
		prompt: "Does the cited code actually decode obfuscated content and then execute or follow it?",
	},
	"VTD-0027": {
		definition: "Long base64 literal assigned to a shell variable.",
		prompt: "Does the cited text actually carry an encoded payload that is later decoded and used?",
	},
	"VTD-0028": {
		definition: "Safety-bypass flag on a command.",
		prompt: "Does the cited command line actually run with the safety-bypass flag in an executing context?",
	},
	"VTD-0029": {
		definition: "Cloud metadata endpoint probe.",
		prompt: "Does the cited code actually contact a cloud metadata endpoint to harvest credentials or instance identity?",
	},
	"VTD-0005": {
		definition: "Cloud credential file access.",
		prompt: "Does the cited code actually read a credentials file — not merely mention its path in help text or comments?",
	},
	"VTD-0006": {
		definition: "SSH private key file access.",
		prompt: "Does the cited code actually read SSH key material — not merely mention key paths in documentation?",
	},
	"VTD-0057": {
		definition: "DNS covert channel.",
		prompt: "Does the cited code actually exfiltrate data through DNS lookups — not merely perform ordinary DNS resolution?",
	},
	"VTD-0059": {
		definition: "Outbound POST with application/octet-stream.",
		prompt: "Does the cited code actually POST file contents or collected data to a remote host?",
	},
	"VTD-0064": {
		definition: "Prompt instruction override attempt.",
		prompt: "Does the cited text actually instruct the agent to override prior instructions — and is it prose the agent follows, rather than text quoted in a comment, string or example?",
	},
	"VTD-0068": {
		definition: "Jailbreak persona text.",
		prompt: "Does the cited text actually try to put the agent into an unrestricted persona when followed — rather than being quoted example or documentation text?",
	},
	"VTD-0076": {
		definition: "Chat template special token.",
		prompt: "Is the special token actually used to steer the model, rather than appearing in quoted content, documentation or example text?",
	},
	"VTD-0088": {
		definition: "External URL reference.",
		prompt: "Does the cited code or instruction actually fetch from, or send to, this URL — rather than merely documenting or linking it?",
	},
	"VTD-0089": {
		definition: "Credential exfiltration chain.",
		prompt: "Does the cited chain actually connect credential access with a network send — are both links real and connected?",
	},
	"VTD-0090": {
		definition: "Malicious activity chain.",
		prompt: "Does the cited chain actually compose into the malicious behavior — is each link real and do they connect?",
	},
	// Cisco pass-through families (unmapped rule ids).
	"DATA_EXFIL_NETWORK_REQUESTS": {
		definition: "Network requests that carry sensitive data out.",
		prompt: "Does the cited code actually send sensitive data (credentials, files, environment) to a host the user did not choose? A socket connect to a host the user supplies as a parameter is the service the user asked about, not exfiltration.",
	},
	"DATA_EXFIL_JS_NETWORK": {
		definition: "JavaScript network call flagged as exfiltration.",
		prompt: "Does the cited code actually send sensitive data out, rather than calling a user-chosen endpoint?",
	},
	"DATA_EXFIL_HTTP_POST": {
		definition: "HTTP POST flagged as exfiltration.",
		prompt: "Does the cited code actually POST sensitive data to a host the user did not choose?",
	},
	"CORRELATED_SENSITIVE_NETWORK_FLOW": {
		definition: "Sensitive-file read correlated with a network send.",
		prompt: "Does the cited code actually read sensitive files and send them out — are both halves real and connected?",
	},
	"COMMAND_INJECTION_EVAL": {
		definition: "JavaScript eval of potentially untrusted input.",
		prompt: "Does the cited code actually evaluate untrusted or variable input as code?",
	},
	"COMMAND_INJECTION_JS_CHILD_PROCESS": {
		definition: "child_process execution of dynamic input.",
		prompt: "Does the cited code actually pass variable or untrusted input to a child process call?",
	},
	"COMMAND_INJECTION_SHELL_TRUE": {
		definition: "Shell call with shell=True semantics.",
		prompt: "Does the cited code actually run variable or untrusted input through a shell?",
	},
	"TOOL_ABUSE_SYSTEM_PACKAGE_INSTALL": {
		definition: "System package installation from the skill.",
		prompt: "Does the cited code actually install packages onto the user's system, rather than documenting an install the user performs?",
	},
	"TOOL_ABUSE_UNDECLARED_NETWORK": {
		definition: "Undeclared network use.",
		prompt: "Does the cited code actually make the network call, rather than documenting or stubbing it?",
	},
};

export function familyFor(ruleId: string | undefined, label: string): ReviewFamily {
	const family = ruleId ? FAMILIES[ruleId] : undefined;
	if (family) return family;
	return {definition: `A deterministic scanner rule fired: ${label}.`, prompt: "Does the cited text actually do what this rule describes when the skill is used?"};
}

export const VALIDITY_OPTIONS: Record<string, string> = {
	real: "The cited code or instruction does what the rule describes when the skill is used — it is executed, run or followed.",
	not_executed: "The match is text that is never run or followed: a comment, string literal, help text, documentation, or a negative example shown to the user.",
	not_applicable: "The cited text runs or is followed, but it does not do what the rule describes.",
};

export const SEVERITY_OPTIONS: Record<string, string> = {
	critical: "Immediate, high-confidence harm: data exfiltration, code execution, credential theft — plausible on use.",
	high: "Serious: real capability the user did not sign up for, needing attacker-free conditions to be dangerous.",
	medium: "Notable risk behavior that materially degrades safety, privacy or trust.",
	low: "Minor: hygiene or policy issue with little direct harm.",
};

/** The review's ad-hoc questions ride the connector's rule wire: classification-shaped so the
 *  criteria record carries arbitrary options. */
export function reviewQuestion(key: string, instructions: string, criteria: Record<string, string>): System1Rule {
	return {
		kind: "classification",
		key,
		ruleId: "review",
		summary: "review question",
		section: "review",
		instructions,
		prompt: {instructions, options: criteria},
		emit: "classification",
		dataCategory: "review",
		options: criteria,
		absent: "real",
		severityByValue: {},
	};
}
