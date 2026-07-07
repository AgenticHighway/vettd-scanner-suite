// Zip intake for scan submissions.
//
// Ported from vettd packages/api/src/skills/skill-analyzer.ts (extractZipFiles
// and helpers) so both sides of the cutover accept the same archives. Limits
// live in src/consts.ts because server/app.ts shares MAX_ZIP_SIZE as the
// fastify bodyLimit.

import JSZip from "jszip";

import {
	MAX_FILES,
	MAX_TEXT_FILE_BYTES,
	MAX_TOTAL_TEXT_BYTES,
	MAX_UNCOMPRESSED_ZIP_BYTES,
	MAX_ZIP_SIZE,
} from "../consts.js";

/** Caller-fault extraction failure — the HTTP layer maps this to a 400. */
export class ZipValidationError extends Error {}

type JSZipObjectWithPrivateSize = JSZip.JSZipObject & {
	_data?: {
		compressedSize?: number;
		uncompressedSize?: number;
	};
};

export interface ExtractedZipFiles {
	textFiles: Map<string, string>;
	allPaths: string[];
}

/**
 * @brief reads uncompressed size from JSZip's private `_data` field
 * @param entry JSZip object to find size of
 * @returns null if unavailable or invalid.
 */
function getUncompressedSize(entry: JSZip.JSZipObject): number | null {
	// GOTCHA: `_data` is not part of JSZip's public API — re-validate on
	// jszip upgrades. Used as a zip-bomb guard before any decompression.
	const privateData = entry as JSZipObjectWithPrivateSize;
	const size = privateData._data?.uncompressedSize;
	return typeof size === "number" && Number.isFinite(size) && size >= 0 ?
			size
		:	null;
}

function findCommonPrefix(paths: string[]): string {
	if (paths.length === 0) return "";
	// Only strip if all paths share a directory prefix
	const parts = paths[0].split("/");
	let prefix = "";
	for (let i = 0; i < parts.length - 1; i++) {
		const candidate = prefix + parts[i] + "/";
		if (paths.every((p) => p.startsWith(candidate))) {
			prefix = candidate;
		} else {
			break;
		}
	}
	return prefix;
}

/** @brief returns true if the file extension indicates binary content that should not be decoded as text. */
function isBinaryPath(path: string): boolean {
	// NOTE: `svg` is treated as binary — inherited from vettd web verbatim;
	// parity across the cutover matters more than strict correctness here.
	const ext = path.split(".").pop()?.toLowerCase() ?? "";
	return [
		"png",
		"jpg",
		"jpeg",
		"gif",
		"webp",
		"ico",
		"svg",
		"woff",
		"woff2",
		"ttf",
		"eot",
		"pdf",
		"zip",
		"tar",
		"gz",
		"bz2",
		"exe",
		"dll",
		"so",
		"dylib",
		"class",
		"pyc",
		"wasm",
	].includes(ext);
}

/**
 * @brief extracts text files from a ZIP buffer
 * @description returns both a file map and a list of normalized paths so
 * callers can run every scanner on the same data. throws ZipValidationError
 * on any caller-fault input (bad archive, size/count limits, unsafe paths).
 * @param zipBuffer buffer holding the zip contents
 * @returns the file map and normalized paths
 */
export async function extractZipFiles(zipBuffer: ArrayBuffer | Uint8Array): Promise<ExtractedZipFiles> {
	if (zipBuffer.byteLength > MAX_ZIP_SIZE) {
		throw new ZipValidationError(
			`Zip file exceeds ${(MAX_ZIP_SIZE / 1024 / 1024).toFixed(1)} MB limit (received ${(zipBuffer.byteLength / 1024 / 1024).toFixed(1)} MB)`,
		);
	}

	let zip: JSZip;
	try {
		zip = await JSZip.loadAsync(zipBuffer);
	} catch (err) {
		throw new ZipValidationError(
			`Failed to read zip archive: ${err instanceof Error ? err.message : String(err)}`,
		);
	}

	const allPaths = Object.keys(zip.files).filter((p) => !zip.files[p].dir);

	if (allPaths.length > MAX_FILES) {
		throw new ZipValidationError(
			`Zip contains ${allPaths.length} files (limit: ${MAX_FILES}). Remove unnecessary files or upload individual skill directories.`,
		);
	}

	const prefix = findCommonPrefix(allPaths);
	const normalizedPaths = allPaths.map((p) => p.slice(prefix.length));

	// Security: reject zip entries with path traversal (CWE-22 / zip slip)
	for (const normPath of normalizedPaths) {
		if (normPath.includes("..") || normPath.startsWith("/") || normPath.startsWith("\\")) {
			throw new ZipValidationError(
				`Zip contains unsafe path: ${normPath}. Entries must not contain ".." or start with "/".`,
			);
		}
	}

	let totalUncompressedBytes = 0;

	for (const rawPath of allPaths) {
		const size = getUncompressedSize(zip.files[rawPath]);
		if (size === null) continue;
		totalUncompressedBytes += size;
		if (totalUncompressedBytes > MAX_UNCOMPRESSED_ZIP_BYTES) {
			throw new ZipValidationError(
				`Zip contents exceed ${(MAX_UNCOMPRESSED_ZIP_BYTES / 1024 / 1024).toFixed(0)} MB uncompressed limit`,
			);
		}
	}

	const textFiles = new Map<string, string>();
	let extractedTextBytes = 0;
	for (let i = 0; i < allPaths.length; i++) {
		const rawPath = allPaths[i];
		const normPath = normalizedPaths[i];
		if (isBinaryPath(normPath)) continue;
		const file = zip.files[rawPath];
		const declaredSize = getUncompressedSize(file);
		if (declaredSize !== null && declaredSize > MAX_TEXT_FILE_BYTES) {
			throw new ZipValidationError(
				`Text file ${normPath} exceeds ${(MAX_TEXT_FILE_BYTES / 1024 / 1024).toFixed(0)} MB limit`,
			);
		}

		let contentBytes: Uint8Array;
		try {
			contentBytes = await file.async("uint8array");
		} catch {
			continue;
		}

		if (contentBytes.byteLength > MAX_TEXT_FILE_BYTES) {
			throw new ZipValidationError(
				`Text file ${normPath} exceeds ${(MAX_TEXT_FILE_BYTES / 1024 / 1024).toFixed(0)} MB limit`,
			);
		}

		extractedTextBytes += contentBytes.byteLength;
		if (extractedTextBytes > MAX_TOTAL_TEXT_BYTES) {
			throw new ZipValidationError(
				`Extracted text exceeds ${(MAX_TOTAL_TEXT_BYTES / 1024 / 1024).toFixed(0)} MB limit`,
			);
		}

		try {
			const content = new TextDecoder().decode(contentBytes);
			textFiles.set(normPath, content);
		} catch {
			continue;
		}
	}

	return {textFiles, allPaths: normalizedPaths};
}
