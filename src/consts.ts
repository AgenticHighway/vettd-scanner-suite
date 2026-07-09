// Constants shared across modules. Tunables used by exactly one file live as
// named consts at the top of that file instead.

export const SERVICE_NAME = "vettd-scanner-suite";

export const DEFAULT_CONFIG_PATH = "./scanner-suite.toml";

// ─── Submit (JSON) intake limits ─────────────────────────────────────────────
// Enforced in server/app.ts on the JSON body: number of files (allPaths),
// size of each text file value, and total text bytes. These mirror the limits
// the old zip path enforced (see src/intake/zip.ts, removed in #13).
export const MAX_FILES = 500;
export const MAX_TEXT_FILE_BYTES = 4 * 1024 * 1024;
export const MAX_TOTAL_TEXT_BYTES = 16 * 1024 * 1024;

// Hard cap on the overall HTTP request body. Larger than MAX_TOTAL_TEXT_BYTES
// to leave room for JSON overhead (keys, quotes, whitespace).
export const MAX_BODY_BYTES = 20 * 1024 * 1024;
