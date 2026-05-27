import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = process.env.CAP_WEB_IMAGE_ROOT ?? "/app";

const targetExtensions = new Set([".js", ".mjs", ".cjs"]);
const markerPattern =
	/createUploadTargetFor(?:User|Video)|\.createUploadTarget\(/;
const callPattern =
	/createUploadTargetFor(?:User|Video)\(|\.createUploadTarget\(/g;
const dryRun = process.env.CAP_R2_PATCH_DRY_RUN === "1";
const cluePattern =
	/x-amz-meta-userid|presignedPostData|s3Post|getPresignedPostUrl|raw-upload\.mp4|Presigned URL created successfully/;

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

function replaceAll(source, search, replacement) {
	const count = source.split(search).length - 1;
	if (count === 0) return { output: source, replacements: 0 };
	return {
		output: source.split(search).join(replacement),
		replacements: count,
	};
}

function patchOfficialCompiledSource(source) {
	let output = source;
	let replacements = 0;

	const apply = (search, replacement) => {
		const result = replaceAll(output, search, replacement);
		output = result.output;
		replacements += result.replacements;
		return result.replacements;
	};

	const applyPair = (
		openSearch,
		openReplacement,
		sendSearch,
		sendReplacement,
	) => {
		const openReplacements = apply(openSearch, openReplacement);
		if (openReplacements > 0) apply(sendSearch, sendReplacement);
	};

	output = output.replace(
		/yield\*([A-Za-z_$][\w$]*)\.getPresignedPostUrl\(([^,()]+),\{Fields:\{"Content-Type":([^,{}]+),[^{}]*\},Expires:(\d+)\}\)/g,
		(_match, bucket, key, contentType, expires) => {
			replacements += 1;
			return `({url:yield*${bucket}.getPresignedPutUrl(${key},{ContentType:${contentType}},{expiresIn:${expires}}),fields:{}})`;
		},
	);

	output = output.replace(
		/yield\*([A-Za-z_$][\w$]*)\.getPresignedPostUrl\(([^,()]+),\{Fields:([A-Za-z_$][\w$]*),Expires:(\d+)\}\)/g,
		(_match, bucket, key, fields, expires) => {
			replacements += 1;
			return `({url:yield*${bucket}.getPresignedPutUrl(${key},{ContentType:${fields}["Content-Type"]},{expiresIn:${expires}}),fields:{}})`;
		},
	);

	apply('.default("post"),durationInSecs:', '.default("put"),durationInSecs:');

	applyPair(
		'c.open("POST",h.presignedPostData.url)',
		'c.open("PUT",h.presignedPostData.url),c.setRequestHeader("Content-Type","video/mp4")',
		"c.send(j)",
		"c.send(a)",
	);

	applyPair(
		'r.open("POST",l.presignedPostData.url)',
		'r.open("PUT",l.presignedPostData.url),r.setRequestHeader("Content-Type","video/mp4")',
		"r.send(d)",
		"r.send(e)",
	);

	applyPair(
		'j.open("POST",b.url)',
		'j.open("PUT",b.url),j.setRequestHeader("Content-Type","video/mp4")',
		"j.send(i)",
		"j.send(h)",
	);

	applyPair(
		'e.open("POST",a.presignedPostData.url)',
		'e.open("PUT",a.presignedPostData.url),e.setRequestHeader("Content-Type","image/jpeg")',
		"e.send(b)",
		"e.send(f)",
	);

	applyPair(
		'n.open("POST",e.presignedPostData.url)',
		'n.open("PUT",e.presignedPostData.url),n.setRequestHeader("Content-Type","image/jpeg")',
		"n.send(t)",
		"n.send(l)",
	);

	applyPair(
		'd.open("POST",t.url)',
		'd.open("PUT",t.url),d.setRequestHeader("Content-Type","video/mp4")',
		"d.send(o)",
		"d.send(l)",
	);

	return { output, replacements };
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
	const namedPatch = patchSource(source);
	const compiledPatch = patchOfficialCompiledSource(namedPatch.output);
	const output = compiledPatch.output;
	const replacements = namedPatch.replacements + compiledPatch.replacements;
	if (replacements > 0) {
		if (!dryRun) writeFileSync(file, output);
		filesChanged += 1;
		totalReplacements += replacements;
		console.log(
			`${dryRun ? "would patch" : "patched"} ${replacements} upload target call(s): ${file.replace(root, "")}`,
		);
	}
}

for (const file of walk(root)) {
	const { size } = statSync(file);
	if (size > 20 * 1024 * 1024) continue;

	const source = readFileSync(file, "utf8");
	if (markerPattern.test(source)) continue;

	const { output, replacements } = patchOfficialCompiledSource(source);
	if (replacements > 0) {
		if (!dryRun) writeFileSync(file, output);
		filesChanged += 1;
		totalReplacements += replacements;
		console.log(
			`${dryRun ? "would patch" : "patched"} ${replacements} compiled upload call(s): ${file.replace(root, "")}`,
		);
	}
}

let putEvidence = 0;
let remainingPostUploadEvidence = 0;
let remainingPostPresignEvidence = 0;
for (const file of walk(root)) {
	const { size } = statSync(file);
	if (size > 20 * 1024 * 1024) continue;

	const source = readFileSync(file, "utf8");

	const namedMatches = markerPattern.test(source)
		? (source.match(
				/(createUploadTargetFor(?:User|Video)|\.createUploadTarget\()[\s\S]{0,700}?method\s*:\s*["']put["']/g,
			) ?? [])
		: [];
	const compiledMatches =
		source.match(/getPresignedPutUrl\([^)]*\{ContentType:/g) ?? [];
	putEvidence += namedMatches.length + compiledMatches.length;

	const riskyPostUploads =
		source.match(/open\("POST",[^)]*(?:presignedPostData\.url|\.url)\)/g) ?? [];
	remainingPostUploadEvidence += riskyPostUploads.length;

	if (
		/getPresignedPostUrl\([^)]*\{Fields:(?:\{|[A-Za-z_$])/.test(source) &&
		/x-amz-meta-userid/.test(source)
	) {
		remainingPostPresignEvidence += 1;
	}
}

console.log(
	JSON.stringify({
		root,
		filesScanned,
		filesWithMarkers,
		filesChanged,
		totalReplacements,
		putEvidence,
		remainingPostUploadEvidence,
		remainingPostPresignEvidence,
	}),
);

if (
	putEvidence < 3 ||
	remainingPostUploadEvidence > 0 ||
	remainingPostPresignEvidence > 0
) {
	const clues = [];
	for (const file of walk(root)) {
		const { size } = statSync(file);
		if (size > 20 * 1024 * 1024) continue;

		const source = readFileSync(file, "utf8");
		const match = cluePattern.exec(source);
		if (!match) continue;

		const start = Math.max(0, match.index - 220);
		const end = Math.min(source.length, match.index + 420);
		clues.push({
			file: file.replace(root, ""),
			match: match[0],
			snippet: source.slice(start, end).replace(/\s+/g, " "),
		});
		if (clues.length >= 20) break;
	}
	console.log(JSON.stringify({ clueCount: clues.length, clues }, null, 2));
	throw new Error(
		"Could not verify enough PUT upload target call sites in the Cap web image",
	);
}
