// Socket response → suite contract (vettd#1168). Pure: no I/O, no env.
//
// Safety alerts (vulnerability, supply-chain risk, malware) become findings. License, maintenance
// and quality alerts and Socket's 0-1 scores become signals, one row per dependency keyed by its
// PURL. What the run could not check becomes coverage.

import type {AssetCoverageEntry} from "../contract/asset-coverage.js";
import type {AssetFinding, AssetSignal} from "../contract/scanner.js";
import type {Dependency} from "./dependencies/index.js";

export const SOCKET_SOURCE_ID = "socket";
/** Socket's per-request batch limit. */
export const MAX_PURLS_PER_REQUEST = 1024;

interface SocketAlertProps {
	cveId?: string;
	ghsaId?: string;
	title?: string;
	description?: string;
}

export interface SocketAlert {
	type: string;
	severity: string; // "critical" | "high" | "middle" | "low"
	category: string; // "vulnerability" | "supplyChainRisk" | "license" | "quality" | "maintenance" | "other"
	action: string; // "error" | "warn" | "monitor" | "ignore"
	props?: SocketAlertProps;
}

export interface SocketPackage {
	name: string;
	version: string;
	inputPurl: string;
	alerts?: SocketAlert[];
	score?: Record<string, number>;
}

// Synthesized by Socket when `alerts=true`: not facts about the package.
const SYNTHETIC_ALERTS = new Set(["pendingScan", "notFound"]);
const SIGNAL_RULES: Record<string, {ruleId: string; dataCategory: string; noun: string}> = {
	license: {ruleId: "compatibility/dependency-license-risk", dataCategory: "compatibility", noun: "License"},
	maintenance: {ruleId: "reliability/dependency-maintenance-risk", dataCategory: "reliability", noun: "Maintenance"},
	quality: {ruleId: "reliability/dependency-quality-risk", dataCategory: "reliability", noun: "Quality"},
};
const SEVERITY_RANK = ["low", "medium", "high", "critical"];

function severityOf(alert: SocketAlert): string {
	return alert.severity === "middle" ? "medium" : alert.severity;
}

function liveAlerts(pkg: SocketPackage): SocketAlert[] {
	// Socket's own policy marks low-signal alerts as "ignore"; respect that.
	return (pkg.alerts ?? []).filter((a) => a.action !== "ignore" && !SYNTHETIC_ALERTS.has(a.type));
}

export function mapFinding(alert: SocketAlert, pkg: SocketPackage): AssetFinding | null {
	const {severity, category, type, props} = alert;
	const highOrWorse = severity === "critical" || severity === "high";
	let findingSeverity: AssetFinding["severity"];
	let findingCategory: AssetFinding["category"] = "scripts";
	let intent: AssetFinding["intent"] = null;

	if (category === "vulnerability") {
		// Low vulnerabilities are not actionable for the skill trust signal.
		if (severity === "low") return null;
		findingSeverity = highOrWorse ? "critical" : "medium";
	} else if (category === "supplyChainRisk") {
		findingSeverity = highOrWorse ? "critical" : "medium";
		if (highOrWorse && (type === "malware" || type === "knownMalware")) {
			findingCategory = "security";
			intent = "malicious";
		}
	} else {
		return null;
	}

	const cveRef = props?.cveId ?? props?.ghsaId;
	const descSnippet = props?.description?.slice(0, 200) ?? type;
	return {
		category: findingCategory,
		label: `${props?.title ?? type} in ${pkg.name}@${pkg.version}`,
		detail: cveRef ? `${cveRef}: ${descSnippet}` : descSnippet,
		severity: findingSeverity,
		source: SOCKET_SOURCE_ID,
		ruleId: type,
		...(intent ? {intent} : {}),
	};
}

export function mapFindings(packages: SocketPackage[]): AssetFinding[] {
	return packages.flatMap((pkg) => liveAlerts(pkg).map((a) => mapFinding(a, pkg)).filter((f): f is AssetFinding => f !== null));
}

function packageSignals(pkg: SocketPackage, observedAt: string): AssetSignal[] {
	const base = {sourceClass: "scan", observedAt, relatedType: "declared_package", relatedId: pkg.inputPurl};
	const ref = `${pkg.name}@${pkg.version}`;
	const signals: AssetSignal[] = [
		{...base, dataCategory: "compatibility", ruleId: "compatibility/declared-dependencies", valueText: pkg.inputPurl, derivation: "read", label: ref},
	];
	if (typeof pkg.score?.overall === "number") {
		signals.push({...base, dataCategory: "reliability", ruleId: "reliability/dependency-score", valueNum: pkg.score.overall, unit: "ratio", method: "socket-score", label: ref, payload: {score: pkg.score}});
	}
	// One row per (rule, package): the row identity includes the package, so several alerts of
	// one category are folded into a single row at the worst severity.
	for (const [category, rule] of Object.entries(SIGNAL_RULES)) {
		const alerts = liveAlerts(pkg).filter((a) => a.category === category);
		if (alerts.length === 0) continue;
		const severity = alerts.map(severityOf).reduce((a, b) => (SEVERITY_RANK.indexOf(b) > SEVERITY_RANK.indexOf(a) ? b : a));
		signals.push({
			...base,
			dataCategory: rule.dataCategory,
			ruleId: rule.ruleId,
			severity,
			label: `${rule.noun} risk in ${ref}`,
			detail: alerts.map((a) => a.props?.title ?? a.type).join("; "),
			payload: {alertTypes: alerts.map((a) => a.type)},
		});
	}
	return signals;
}

export function mapSignals(packages: SocketPackage[], observedAt: Date): AssetSignal[] {
	return packages.flatMap((pkg) => packageSignals(pkg, observedAt.toISOString()));
}

function coverageEntry(ruleId: string, label: string, detail: string): AssetCoverageEntry {
	return {kind: "coverage", ruleId, label, detail, category: "security"};
}

export function lookupsNotPermittedCoverage(dependencyCount: number): AssetCoverageEntry {
	return coverageEntry("security/socket-lookups-not-permitted", "Dependencies not checked by Socket", `${dependencyCount} dependencies found; third-party lookups are not permitted for this asset.`);
}

/** What the extraction step found but could not send. */
export function extractionCoverage(purls: string[], unversioned: Dependency[]): AssetCoverageEntry[] {
	const coverage: AssetCoverageEntry[] = [];
	if (unversioned.length > 0) {
		const names = unversioned.slice(0, 10).map((d) => d.name).join(", ");
		coverage.push(coverageEntry("security/socket-unversioned-dependencies", "Dependencies without an exact version not checked", `${unversioned.length} dependencies have no exact version (${names}${unversioned.length > 10 ? ", ..." : ""}).`));
	}
	if (purls.length > MAX_PURLS_PER_REQUEST) {
		coverage.push(coverageEntry("security/socket-dependency-limit", "Dependency limit reached", `${purls.length} dependencies found; only the first ${MAX_PURLS_PER_REQUEST} were checked.`));
	}
	return coverage;
}

/** Packages Socket could not resolve or had not finished analysing. */
export function responseCoverage(packages: SocketPackage[]): AssetCoverageEntry[] {
	const coverage: AssetCoverageEntry[] = [];
	for (const type of SYNTHETIC_ALERTS) {
		const count = packages.filter((p) => (p.alerts ?? []).some((a) => a.type === type)).length;
		if (count === 0) continue;
		coverage.push(type === "notFound"
			? coverageEntry("security/socket-dependency-not-found", "Dependencies unknown to Socket", `${count} dependencies could not be resolved by Socket.`)
			: coverageEntry("security/socket-analysis-pending", "Socket analysis pending", `${count} dependencies were still being analysed by Socket.`));
	}
	return coverage;
}
