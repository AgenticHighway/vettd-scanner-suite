// Service entry point: load config, wire dependencies, listen.
// Usage: node dist/server/index.js [path/to/scanner-suite.toml]

import {ConfigError, loadConfig} from "../config/load.js";
import {DEFAULT_CONFIG_PATH} from "../consts.js";
import {JobExecutor} from "../core/jobs/executor.js";
import {InMemoryJobStore} from "../core/jobs/store.js";
import {buildScanners} from "../core/registry.js";
import {logger} from "../logger.js";
import {buildApp} from "./app.js";

const configPath = process.argv[2] ?? DEFAULT_CONFIG_PATH;

let config;
try {
	config = loadConfig(configPath);
} catch (err) {
	if (err instanceof ConfigError) {
		logger.error({module: "server", configPath, err}, "invalid configuration");
		process.exit(1);
	}
	throw err;
}

const scanners = buildScanners(config);
logger.info(
	{module: "server", configPath, scanners: scanners.map((s) => s.id)},
	"scanner suite starting",
);

const store = new InMemoryJobStore();
const executor = new JobExecutor({
	store,
	scanners,
	scannerTimeoutMs: config.jobs.scannerTimeoutMs,
	maxConcurrent: config.jobs.maxConcurrent,
});
const app = buildApp({store, executor});

await app.listen({host: config.server.host, port: config.server.port});

// In-flight jobs are abandoned on shutdown by design — the store is
// in-memory and callers resubmit (same contract as a crash/restart).
for (const signal of ["SIGINT", "SIGTERM"] as const) {
	process.once(signal, () => {
		void app.close().then(() => process.exit(0));
	});
}
