// Config-driven scanner registry. Replaces vettd web's env-var pattern
// (EXTERNAL_SCANNERS) — enablement comes exclusively from the TOML config.

import {createCiscoScanner} from "../adapters/cisco.js";
import {createOpenRouterConnector} from "../adapters/jev.js";
import {createSystem1Scanner} from "../system1/scanner.js";
import {createSocketScanner} from "../adapters/socket.js";
import {createVettdScanner} from "../adapters/vettd.js";
import type {SuiteConfig} from "../config/schema.js";
import type {SkillScanner} from "../contract/scanner.js";

/**
 * Instantiates the enabled scanners in fixed order: vettd first, then cisco,
 * then socket, then system1. Config declares enablement, not order — run order is a suite
 * decision so results stay stable across config layouts.
 */
export function buildScanners(config: SuiteConfig): SkillScanner[] {
	const scanners: SkillScanner[] = [];
	if (config.scanners.vettd.enabled) scanners.push(createVettdScanner(config.scanners.vettd));
	if (config.scanners.cisco.enabled) scanners.push(createCiscoScanner(config.scanners.cisco));
	if (config.scanners.socket.enabled) scanners.push(createSocketScanner(config.scanners.socket));
	if (config.scanners.system1.enabled) {
		scanners.push(createSystem1Scanner(config.scanners.system1, createOpenRouterConnector(config.scanners.system1)));
	}
	return scanners;
}
