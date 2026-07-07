import JSZip from "jszip";
import {describe, expect, it} from "vitest";

import {extractZipFiles, ZipValidationError} from "../zip.js";

async function buildZip(files: Record<string, string | Uint8Array>): Promise<Buffer> {
	const zip = new JSZip();
	for (const [path, content] of Object.entries(files)) {
		zip.file(path, content);
	}
	return zip.generateAsync({type: "nodebuffer"});
}

// JSZip sanitizes entry names it writes AND resolves ".." on load, so hostile
// paths can't be produced through the JSZip API. Hand-craft a raw STORED zip
// to smuggle arbitrary entry names (absolute and backslash paths survive
// JSZip's load normalization — those are the vectors the guard must catch).
function rawZip(entries: Array<[name: string, data: string]>): Buffer {
	const parts: Buffer[] = [];
	const central: Buffer[] = [];
	let offset = 0;
	for (const [name, data] of entries) {
		const nameB = Buffer.from(name);
		const dataB = Buffer.from(data);
		const crc = crc32(dataB);
		const lfh = Buffer.alloc(30);
		lfh.writeUInt32LE(0x04034b50, 0);
		lfh.writeUInt16LE(20, 4);
		lfh.writeUInt32LE(crc, 14);
		lfh.writeUInt32LE(dataB.length, 18);
		lfh.writeUInt32LE(dataB.length, 22);
		lfh.writeUInt16LE(nameB.length, 26);
		const cdh = Buffer.alloc(46);
		cdh.writeUInt32LE(0x02014b50, 0);
		cdh.writeUInt16LE(20, 4);
		cdh.writeUInt16LE(20, 6);
		cdh.writeUInt32LE(crc, 16);
		cdh.writeUInt32LE(dataB.length, 20);
		cdh.writeUInt32LE(dataB.length, 24);
		cdh.writeUInt16LE(nameB.length, 28);
		cdh.writeUInt32LE(offset, 42);
		parts.push(lfh, nameB, dataB);
		central.push(cdh, nameB);
		offset += 30 + nameB.length + dataB.length;
	}
	const centralSize = central.reduce((n, b) => n + b.length, 0);
	const eocd = Buffer.alloc(22);
	eocd.writeUInt32LE(0x06054b50, 0);
	eocd.writeUInt16LE(entries.length, 8);
	eocd.writeUInt16LE(entries.length, 10);
	eocd.writeUInt32LE(centralSize, 12);
	eocd.writeUInt32LE(offset, 16);
	return Buffer.concat([...parts, ...central, eocd]);
}

function crc32(buf: Buffer): number {
	let crc = 0xffffffff;
	for (let i = 0; i < buf.length; i++) {
		let c = (crc ^ buf[i]) & 0xff;
		for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		crc = (crc >>> 8) ^ c;
	}
	return (crc ^ 0xffffffff) >>> 0;
}

describe("extractZipFiles", () => {
	it("returns text files and all paths for a simple skill archive", async () => {
		const buffer = await buildZip({
			"SKILL.md": "# My Skill",
			"scripts/run.sh": "echo hi",
		});
		const {textFiles, allPaths} = await extractZipFiles(buffer);
		expect(textFiles.get("SKILL.md")).toBe("# My Skill");
		expect(textFiles.get("scripts/run.sh")).toBe("echo hi");
		expect(allPaths.sort()).toEqual(["SKILL.md", "scripts/run.sh"]);
	});

	// Zips made by "zip -r skill/" wrap everything in one directory; scanners
	// must see root-relative paths (SKILL.md, not skill/SKILL.md).
	it("strips a common directory prefix", async () => {
		const buffer = await buildZip({
			"my-skill/SKILL.md": "# Wrapped",
			"my-skill/references/notes.md": "notes",
		});
		const {textFiles, allPaths} = await extractZipFiles(buffer);
		expect(textFiles.has("SKILL.md")).toBe(true);
		expect(allPaths.sort()).toEqual(["SKILL.md", "references/notes.md"]);
	});

	// CWE-22 zip slip: a hostile archive must never smuggle escaping paths
	// through to scanners (which treat paths as asset-root-relative). The
	// second normal entry prevents the common-prefix strip from consuming
	// the leading "/" before the guard sees it.
	it("rejects absolute-path entries", async () => {
		const buffer = rawZip([
			["SKILL.md", "# ok"],
			["/etc/evil.sh", "rm -rf /"],
		]);
		await expect(extractZipFiles(buffer)).rejects.toThrow(ZipValidationError);
		await expect(extractZipFiles(buffer)).rejects.toThrow(/unsafe path/);
	});

	it("rejects backslash-path entries", async () => {
		const buffer = rawZip([
			["SKILL.md", "# ok"],
			["\\windows\\evil.bat", "del /s"],
		]);
		await expect(extractZipFiles(buffer)).rejects.toThrow(/unsafe path/);
	});

	// JSZip resolves ".." segments at load time, so traversal names collapse
	// to safe relative paths before our guard runs — assert the end-to-end
	// property: no path containing ".." ever reaches the output.
	it("neutralizes ../ traversal entries", async () => {
		const buffer = rawZip([
			["SKILL.md", "# ok"],
			["../evil.sh", "rm -rf /"],
			["a/../../up.sh", "up"],
		]);
		const {allPaths} = await extractZipFiles(buffer);
		expect(allPaths.every((p) => !p.includes(".."))).toBe(true);
	});

	it("rejects archives with more than the file-count limit", async () => {
		const files: Record<string, string> = {};
		for (let i = 0; i < 501; i++) files[`f${i}.txt`] = "x";
		const buffer = await buildZip(files);
		await expect(extractZipFiles(buffer)).rejects.toThrow(/limit: 500/);
	});

	// Binary files must appear in allPaths (structure checks need them) but
	// never be decoded into textFiles.
	it("excludes binary files from textFiles but keeps them in allPaths", async () => {
		const buffer = await buildZip({
			"SKILL.md": "# ok",
			"logo.png": new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
		});
		const {textFiles, allPaths} = await extractZipFiles(buffer);
		expect(textFiles.has("logo.png")).toBe(false);
		expect(allPaths.sort()).toEqual(["SKILL.md", "logo.png"]);
	});

	it("rejects a buffer that is not a zip archive", async () => {
		await expect(extractZipFiles(Buffer.from("definitely not a zip"))).rejects.toThrow(ZipValidationError);
	});

	it("rejects a text file over the per-file limit", async () => {
		// 4MB + 1 byte of compressible content keeps the test fast while
		// still crossing MAX_TEXT_FILE_BYTES on the decoded size.
		const big = "a".repeat(4 * 1024 * 1024 + 1);
		const buffer = await buildZip({"SKILL.md": "# ok", "big.txt": big});
		await expect(extractZipFiles(buffer)).rejects.toThrow(/exceeds 4 MB limit/);
	});
});
