// Constants shared across modules. Tunables used by exactly one file live as
// named consts at the top of that file instead.

export const SERVICE_NAME = "vettd-scanner-suite";

export const DEFAULT_CONFIG_PATH = "./scanner-suite.toml";

// ─── Zip intake limits ───────────────────────────────────────────────────────
// Enforced in intake/zip.ts; MAX_ZIP_SIZE doubles as the fastify bodyLimit in
// server/app.ts. Values match vettd web's extractZipFiles so both sides of the
// cutover accept the same archives.
export const MAX_ZIP_SIZE = 50 * 1024 * 1024;
export const MAX_FILES = 500;
export const MAX_UNCOMPRESSED_ZIP_BYTES = 75 * 1024 * 1024;
export const MAX_TEXT_FILE_BYTES = 4 * 1024 * 1024;
export const MAX_TOTAL_TEXT_BYTES = 16 * 1024 * 1024;
