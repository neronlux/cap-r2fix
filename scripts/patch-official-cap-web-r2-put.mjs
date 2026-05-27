import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = process.env.CAP_WEB_IMAGE_ROOT ?? "/app";

const targetExtensions = new Set([".js", ".mjs", ".cjs"]);
const markerPattern =
	/createUploadTargetFor(?:User|Video)|\.createUploadTarget\(/;
const callPattern =
	/createUploadTargetFor(?:User|Video)\(|\.createUploadTarget\(/g;
const dryRun = process.env.CAP_R2_PATCH_DRY_RUN === "1";

function hasTargetExtension(path) {
	for (const extension of targetExtensions) {
		if (path.endsWith(extension)) return true;
	}
	return false;
}

function walk(directory, files = []) {
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		const path = join(directory, entry.name);
		if (entry.isDirectory()) {
			if (entry.name === "node_modules" || entry.name === ".git") continue;
			walk(path, files);
			continue;
		}

		if (entry.isFile() && hasTargetExtension(path)) files.push(path);
	}

	return files;
}

function findMatchingBrace(source, start) {
	let depth = 0;
	let quote = null;
	let escaped = false;
	let lineComment = false;
	let blockComment = false;

	for (let index = start; index < source.length; index++) {
		const char = source[index];
		const next = source[index + 1];

		if (lineComment) {
			if (char === "\n") lineComment = false;
			continue;
		}

		if (blockComment) {
			if (char === "*" && next === "/") {
				blockComment = false;
				index += 1;
			}
			continue;
		}

		if (quote) {
			if (escaped) {
				escaped = false;
				continue;
			}
			if (char === "\\") {
				escaped = true;
				continue;
			}
			if (char === quote) quote = null;
			continue;
		}

		if (char === "/" && next === "/") {
			lineComment = true;
			index += 1;
			continue;
		}

		if (char === "/" && next === "*") {
			blockComment = true;
			index += 1;
			continue;
		}

		if (char === '"' || char === "'" || char === "`") {
			quote = char;
			continue;
		}

		if (char === "{") depth += 1;
		if (char === "}") {
			depth -= 1;
			if (depth === 0) return index;
		}
	}

	return -1;
}

function findUploadOptionsObject(source, callIndex) {
	let searchFrom = callIndex;
	const searchLimit = Math.min(source.length, callIndex + 900);

	while (searchFrom < searchLimit) {
		const objectStart = source.indexOf("{", searchFrom);
		if (objectStart === -1 || objectStart > searchLimit) return null;

		const objectEnd = findMatchingBrace(source, objectStart);
		if (objectEnd === -1) return null;

		const objectSource = source.slice(objectStart, objectEnd + 1);
		if (
			/\bcontentType\s*:/.test(objectSource) &&
			/\bfields\s*:/.test(objectSource)
		) {
			return { objectStart, objectEnd, objectSource };
		}

		searchFrom = objectEnd + 1;
	}

	return null;
}

function patchSource(source) {
	const insertions = [];

	for (const match of source.matchAll(callPattern)) {
		const options = findUploadOptionsObject(source, match.index ?? 0);
		if (!options) continue;
		if (/\bmethod\s*:/.test(options.objectSource)) continue;

		const fieldsMatch = /\bfields\s*:/.exec(options.objectSource);
		if (!fieldsMatch) continue;

		insertions.push(options.objectStart + fieldsMatch.index);
	}

	if (insertions.length === 0) return { output: source, replacements: 0 };

	let output = "";
	let cursor = 0;
	for (const insertion of insertions) {
		output += source.slice(cursor, insertion);
		output += 'method:"put",';
		cursor = insertion;
	}
	output += source.slice(cursor);

	return { output, replacements: insertions.length };
}

let filesScanned = 0;
let filesWithMarkers = 0;
let filesChanged = 0;
let totalReplacements = 0;

for (const file of walk(root)) {
	const { size } = statSync(file);
	if (size > 20 * 1024 * 1024) continue;

	filesScanned += 1;
	const source = readFileSync(file, "utf8");
	if (!markerPattern.test(source)) continue;

	filesWithMarkers += 1;
	const { output, replacements } = patchSource(source);
	if (replacements > 0) {
		if (!dryRun) writeFileSync(file, output);
		filesChanged += 1;
		totalReplacements += replacements;
		console.log(
			`${dryRun ? "would patch" : "patched"} ${replacements} upload target call(s): ${file.replace(root, "")}`,
		);
	}
}

let putEvidence = 0;
for (const file of walk(root)) {
	const { size } = statSync(file);
	if (size > 20 * 1024 * 1024) continue;

	const source = readFileSync(file, "utf8");
	if (!markerPattern.test(source)) continue;

	const matches =
		source.match(
			/(createUploadTargetFor(?:User|Video)|\.createUploadTarget\()[\s\S]{0,700}?method\s*:\s*["']put["']/g,
		) ?? [];
	putEvidence += matches.length;
}

console.log(
	JSON.stringify({
		root,
		filesScanned,
		filesWithMarkers,
		filesChanged,
		totalReplacements,
		putEvidence,
	}),
);

if (putEvidence < 3) {
	throw new Error(
		"Could not verify enough PUT upload target call sites in the Cap web image",
	);
}
