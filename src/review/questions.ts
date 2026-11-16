// The review questions. Three per finding after the first measurement round (amendments 9-12):
// two independently worded validity questions (demotion requires both to say not_executed at
// 0.8+), and a severity question anchored to the scanner's original severity. The validity
// questions are per rule family — a stable one-line definition plus a detailed prompt, mirroring
// the definition/prompt split of the System 1 rule set — and unknown rules fall back to the
// finding's own label, so every finding gets a tuned-or-generic question.

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
	"VTD-0008": {
		definition: "Credential file path literal.",
		prompt: "Does the cited code actually read the credential file — open() on the path, or a command consuming it? A bare path string inside a list of filenames the script names, prints, or checks for is data about the path, not access to the file: answer not_executed.",
	},
	"VTD-0012": {
		definition: "Credential file path literal.",
		prompt: "Does the cited code actually read the credential file — open() on the path, or a command consuming it? A bare path string inside a list of filenames the script names, prints, or checks for is data about the path, not access to the file: answer not_executed.",
	},
	"YARA_jailbreak_generic": {
		definition: "Jailbreak-prompt pattern in skill text.",
		prompt: "First ask whether this skill itself performs jailbreaks — does its code run jailbreak prompts against models, write them into user configs, or ship working jailbreak templates as its purpose? If yes, a jailbreak-pattern hit is real even when the cited line is documentation. Second ask whether the matched phrase is actually about LLM jailbreaking at all — a match on an unrelated technical term (a hardware or protocol master key, a crypto key, a database master key) is a rule-fit miss, not a jailbreak: answer not_executed for it — prefer not_executed over not_applicable in that case, since the flagged text is inert as a jailbreak. Otherwise answer not_executed only when the skill does not itself perform jailbreaks and the cited text is purely educational or detection material about patterns (teaching, research references, quoted examples).",
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
		prompt: "Does the claimed steering actually happen — is this text prose the agent follows as an instruction to override prior instructions? Quoted example phrases, documentation of injection techniques, and detection payloads shown inside string literals or docstrings are quotes about the behavior, not the behavior: answer not_executed when the claimed instruction is never actually given to the agent.",
	},
	"VTD-0095": {
		definition: "Structural requirement on the skill's files.",
		prompt: "This rule is a structural claim about the skill's layout, not a behavior in code. Judge whether the claim is factually true of this skill: if the required structure is actually present (or the claim does not hold), the finding does not stand; the cited text is the rule's own statement, never executed as code.",
	},
	"VTD-0076": {
		definition: "Chat template special token.",
		prompt: "Is the special token actually used to steer the model, rather than appearing in quoted content, documentation or example text?",
	},
	"VTD-0087": {
		definition: "Hidden Unicode character in skill text.",
		prompt: "Does the hidden character sit in text the skill delivers to the agent or user — instructions, code that runs, or content that shapes what the agent reads — rather than inside a code comment or a quoted example of the character itself?",
	},
	"VTD-0088": {
		definition: "External URL reference.",
		prompt: "Does the skill actually use this URL — code fetches/sends to it, or the skill's instructions or reference files direct the agent or user to it — rather than the URL appearing in a code comment or a quoted sample of someone else's page? URLs in the skill's own SKILL.md, instructions or references/ files are part of what the skill directs the agent to read: they are used, not inert. Only URLs inside code comments or quoted third-party content are unused.",
	},
	"VTD-0090": {
		definition: "Credential-exfiltration chain.",
		prompt: "Do the chain's links actually connect: does the code both read the sensitive data AND send it somewhere, with the send carrying what was read? A chain whose send step posts to a host the user supplies, or whose read step is documentation, is not the chain.",
	},
	// Cisco pass-through families (unmapped rule ids), tuned on the labelling rounds.
	"DATA_EXFIL_SOCKET_CONNECT": {
		definition: "A socket connection flagged as exfiltration.",
		prompt: "A socket connect is exfiltration only when it sends sensitive data somewhere the user did not choose. The skill connecting to a host the user supplies as a parameter (an endpoint, API host or URL argument) is the service the user asked for, not exfiltration. Does this connection actually send collected or sensitive data to a host the user did not supply?",
	},
	"DATA_EXFIL_NETWORK_REQUESTS": {
		definition: "Network requests flagged as exfiltration.",
		prompt: "A network request is exfiltration only when it sends sensitive data (credentials, files, environment) to a host the user did not choose. Requests to hosts the user supplies as parameters, or plain fetches that return data, are not exfiltration. Does this request actually send sensitive data out?",
	},
	"DATA_EXFIL_JS_NETWORK": {
		definition: "JavaScript network call flagged as exfiltration.",
		prompt: "Same standard as any exfiltration rule: does this skill's code actually send sensitive data to a host the user did not choose? Judge the cited file's code as a whole — the capability counts even when the flagged line itself is a reporting or template line about the call, and a destination the user supplies is not exfiltration.",
	},
	"DATA_EXFIL_HTTP_POST": {
		definition: "HTTP POST flagged as exfiltration.",
		prompt: "Does the POST actually carry sensitive data to a host the user did not choose?",
	},
	"DATA_EXFIL_SENSITIVE_FILES": {
		definition: "Sensitive-file read flagged for exfiltration.",
		prompt: "Does the code actually read a sensitive file AND send it out? Reading alone, or sending data the user provided for the task, is not exfiltration.",
	},
	"CORRELATED_SENSITIVE_NETWORK_FLOW": {
		definition: "Sensitive-file read correlated with a network send.",
		prompt: "Both halves must be real and connected: the sensitive file must actually be read by this code, and the network call must actually send what was read.",
	},
	"CORRELATED_NETWORK_EXECUTION_FLOW": {
		definition: "A code-execution capability correlated with network access.",
		prompt: "Does the code actually combine executing something with reaching the network in a way the skill's stated purpose does not cover? An execution capability that stays local is not this chain.",
	},
	"CORRELATED_OBFUSCATION_EXECUTION_FLOW": {
		definition: "Obfuscated content correlated with execution.",
		prompt: "Is obfuscated content actually decoded and executed? An encoded blob that is never decoded is not a chain.",
	},
	"PIPELINE_TAINT_FLOW": {
		definition: "Data-flow taint from a sensitive source to a dangerous sink.",
		prompt: "The flagged lines are code, so the question is not whether the text runs — it is whether the flagged flow exists in the cited code: does data from the sensitive source actually reach the flagged sink (a network send, file write, or command), or does it stay in a variable that goes nowhere?",
	},
	"ACTIVE_REMOTE_ACQUIRE_EXECUTE": {
		definition: "Remote content acquired and executed.",
		prompt: "Does the code actually fetch remote content AND run it? Fetching without executing is not this rule.",
	},
	"ACTIVE_OS_PERSISTENCE_DIRECTIVE": {
		definition: "Persistence directive.",
		prompt: "Does the skill actually instruct or script persistence (cron, startup hooks, background services) beyond its declared purpose — rather than documenting a legitimate install step?",
	},
	"ACTIVE_DYNAMIC_EXECUTION": {
		definition: "Dynamic code execution.",
		prompt: "Does the code actually execute dynamically built code when it runs — rather than containing a string that merely looks like code?",
	},
	"OBFUSCATION_BASE64_LARGE": {
		definition: "Large base64 literal.",
		prompt: "Is the literal actually decoded and used by the skill's code — a blob that is stored but never decoded is encoded data, not obfuscation.",
	},
	"TOOL_ABUSE_SYSTEM_PACKAGE_INSTALL": {
		definition: "Package installation from the skill.",
		prompt: "Does the skill install system packages — either code that runs the install itself, or install steps the skill directs the user/agent to perform as part of using it? Requirements/package files the user's tooling installs count only when the skill's own code runs them.",
	},
	"TOOL_ABUSE_UNDECLARED_NETWORK": {
		definition: "Undeclared network use.",
		prompt: "Does the code actually make the network call when the skill runs, or does the skill's text direct the user/agent to reach that endpoint — rather than merely documenting or stubbing it?",
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
	"FILE_MAGIC_MISMATCH": {
		definition: "File content does not match its extension.",
		prompt: "Does the file's actual content genuinely mismatch its extension in a way that conceals what it is? A script that also happens to parse another format is not a mismatch.",
	},
	"YARA_script_injection_generic": {
		definition: "YARA: scripting API use in a rule file.",
		prompt: "Does the YARA rule actually rely on executing script, rather than only matching text? A rule whose condition is written into the file is matching, not injection.",
	},
	"VTD-0033": {
		definition: "Credential dumping tool reference or invocation.",
		prompt: "Does the skill's code actually invoke or script a credential-dumping tool or API? Discussion or documentation of how the tool works is analysis, not the finding — the finding needs the skill to run or direct the user to run the tool.",
	},
	"VTD-0080": {
		definition: "Base64-encoded content present in the skill's documentation.",
		prompt: "This rule's claim is presence, not execution: it reports that base64-encoded content appears in the skill's documentation, where it is rarely expected. The finding is real whenever a base64 payload genuinely appears in the skill's text — including an inline data: URI example — because the payload is present in what the agent reads. Answer not_executed only when the cited text contains no actual base64 payload.",
	},
	"VTD-0082": {
		definition: "Skill name resembles a popular skill name (typosquatting).",
		prompt: "This rule is a factual claim about the skill's metadata, not about executing text: judge whether the skill's declared name really is confusingly close to the popular name the scanner named. If the claim is factually true of this skill, the finding is real.",
	},
	"VTD-0099": {
		definition: "Skill name contains invalid characters.",
		prompt: "This rule is a factual claim about the skill's metadata, not about executing text: judge whether the skill's declared name really contains what the scanner says. If the claim is factually true of this skill, the finding is real.",
	},
	"YARA_sql_injection_generic": {
		definition: "SQL-injection pattern in the skill's code.",
		prompt: "Does the skill actually use these SQL patterns — a payload list the code runs against targets, or a query it builds and executes? That is real. Only patterns shown as documentation examples that no code uses are inert.",
	},
	"YARA_SUSP_Win_EncodedPowerShell_Exec_Sep26": {
		definition: "YARA: encoded PowerShell execution indicator.",
		prompt: "Does the cited code actually decode and execute an encoded command? Security-training or course material that displays encoded PowerShell for analysis, without executing it, is not execution — but a script that runs the encoded payload is.",
	},

};

export function familyFor(ruleId: string | undefined, label: string): ReviewFamily {
	const family = ruleId ? FAMILIES[ruleId] : undefined;
	if (family) return family;
	return {definition: `A deterministic scanner rule fired: ${label}.`, prompt: "Does the cited text actually do what this rule describes when the skill is used?"};
}

export const VALIDITY_OPTIONS: Record<string, string> = {
	real: "The finding holds when the skill is used: the cited code runs, or the cited prose is an instruction the agent or user is told to follow (setup and install sections, run commands in the skill's instructions). Data the skill's code or instructions actually use — including payload or sample lists the code runs against targets — is real.",
	not_executed: "The match is inert text only: a code comment, a docstring that describes rather than directs, a usage string merely printed to the user (print/echo help text), a negative example ('do not do X'), or an example shown in documentation that the skill's code and instructions never use. Nothing runs it, nothing follows it, and nothing uses it.",
	not_applicable: "The cited text runs or is followed, but it does not do what the rule describes.",
};

/** Second, independently worded validity question (amendment 11: demotion needs both to agree).
 *  Same boundary as the first question: directing prose (install steps, setup commands the skill
 *  tells the user/agent to run) counts as real; inert text (comments, descriptive docstrings,
 *  printed usage/output strings, documentation-only examples) does not. */
export const VALIDITY_OPTIONS_2: Record<string, string> = {
	real: "When a user's agent uses this skill as intended, the flagged behavior occurs: code runs, an instruction the skill gives (setup, install or run steps) is followed, or data the skill's code uses is used.",
	not_executed: "When a user's agent uses this skill as intended, the flagged text affects nothing: it is a comment, purely descriptive text that instructs no one, usage text merely printed to the user, a negative example, a documentation example the skill never uses, or a bare literal the program merely stores in a list or variable without using it to act (a filename in a list of paths to print or check, a pattern in a rules table). Install or setup instructions the skill gives DO affect what happens and are not inert.",
	not_applicable: "The flagged behavior occurs, but the scanner's rule does not fit it.",
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
