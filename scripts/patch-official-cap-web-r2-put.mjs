import {
	readdirSync,
	readFileSync,
	renameSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";

const root = process.env.CAP_WEB_IMAGE_ROOT ?? "/app";

const targetExtensions = new Set([".js", ".mjs", ".cjs"]);
const textExtensions = new Set([...targetExtensions, ".json", ".html", ".txt"]);
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

function hasTextExtension(path) {
	for (const extension of textExtensions) {
		if (path.endsWith(extension)) return true;
	}
	return false;
}

function walk(directory, files = [], filter = hasTargetExtension) {
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		const path = join(directory, entry.name);
		if (entry.isDirectory()) {
			if (entry.name === "node_modules" || entry.name === ".git") continue;
			walk(path, files, filter);
			continue;
		}

		if (entry.isFile() && filter(path)) files.push(path);
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
		'r.send(d.get("file"))',
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

	apply(
		"body:k});if(d.ok)return;let e=await d.text();if(503===d.status",
		"body:Buffer.from(k)});if(d.ok)return;let e=await d.text();if(503===d.status",
	);

	return { output, replacements };
}

function patchOfficialCompiledEmailSource(source) {
	let output = source;
	let replacements = 0;
	const resendDomainExpression = "$" + "{(0,d.NK)().RESEND_FROM_DOMAIN}";
	const defaultSenderSource =
		'l=k||(f?"Richie from Cap <richie@send.cap.so>":d.WB.NEXT_PUBLIC_IS_CAP?"Cap Auth <no-reply@auth.cap.so>":`auth@' +
		resendDomainExpression +
		"`)";

	const result = replaceAll(
		output,
		defaultSenderSource,
		defaultSenderSource.replace(
			"l=k||",
			"l=k||process.env.RESEND_FROM_EMAIL||",
		),
	);
	output = result.output;
	replacements += result.replacements;

	return { output, replacements };
}

function patchOfficialCompiledOtpSource(source) {
	const search =
		'mutationFn:async()=>{let e=x.join("");if(6!==e.length)throw"Please enter a complete 6-digit code";if(!(await fetch("/api/auth/callback/email?email=".concat(encodeURIComponent(j),"&token=").concat(encodeURIComponent(e),"&callbackUrl=").concat(encodeURIComponent("/login-success")))).url.includes("/login-success")){var t;throw m(["","","","","",""]),null==(t=f.current[0])||t.focus(),"Invalid code. Please try again."}}';
	const replacement =
		'mutationFn:async()=>{let e=x.join("");if(6!==e.length)throw"Please enter a complete 6-digit code";let t=()=>{var e;m(["","","","","",""]),null==(e=f.current[0])||e.focus()},r=await fetch("/api/auth/callback/email?email=".concat(encodeURIComponent(j),"&token=").concat(encodeURIComponent(e),"&callbackUrl=").concat(encodeURIComponent("/login-success")),{cache:"no-store",credentials:"include"});if(r.url.includes("error=Verification"))throw t(),"Invalid code. Please try again.";for(let e=0;e<8;e++){let r=await fetch("/api/auth/session",{cache:"no-store",credentials:"include"});if(r.ok){let e=await r.json();if(null==e?void 0:e.user)return}await new Promise(e=>setTimeout(e,250))}throw t(),"Invalid code. Please try again."}';

	return replaceAll(source, search, replacement);
}

function patchOfficialCompiledInviteAcceptSource(source) {
	const search =
		'if(!d||!d.stripeSubscriptionId)return z.NextResponse.json({error:"Organization owner not found or has no subscription"},{status:404});';
	const replacement = "d||(d={stripeSubscriptionId:null});";

	return replaceAll(source, search, replacement);
}

function isStaticChunk(path) {
	return (
		path.includes("/apps/web/.next/static/chunks/") && path.endsWith(".js")
	);
}

function cacheBustedChunkName(file) {
	const name = basename(file);
	if (name.endsWith(".r2fix.js") || name.endsWith(".r2fix2.js")) return null;
	return name.replace(/\.js$/, ".r2fix2.js");
}

function cacheBustStaticChunks(files) {
	const uniqueFiles = [...new Set(files)].filter(isStaticChunk);
	const renames = [];

	for (const file of uniqueFiles) {
		const newName = cacheBustedChunkName(file);
		if (!newName) continue;

		const oldName = basename(file);
		const newPath = join(dirname(file), newName);
		renames.push({ oldName, newName, oldPath: file, newPath });
	}

	if (renames.length === 0) return 0;

	if (!dryRun) {
		for (const file of walk(root, [], hasTextExtension)) {
			const { size } = statSync(file);
			if (size > 20 * 1024 * 1024) continue;

			let source = readFileSync(file, "utf8");
			let changed = false;
			for (const { oldName, newName } of renames) {
				if (!source.includes(oldName)) continue;
				source = source.split(oldName).join(newName);
				changed = true;
			}
			if (changed) writeFileSync(file, source);
		}

		for (const { oldPath, newPath } of renames) {
			renameSync(oldPath, newPath);
		}
	}

	for (const { oldPath, newPath } of renames) {
		console.log(
			`${dryRun ? "would cache-bust" : "cache-busted"} static chunk: ${oldPath.replace(root, "")} -> ${newPath.replace(root, "")}`,
		);
	}

	return renames.length;
}

let filesScanned = 0;
let filesWithMarkers = 0;
let filesChanged = 0;
let totalReplacements = 0;
let cacheBustedStaticChunks = 0;
const changedStaticChunks = [];

for (const file of walk(root)) {
	const { size } = statSync(file);
	if (size > 20 * 1024 * 1024) continue;

	filesScanned += 1;
	const source = readFileSync(file, "utf8");
	if (!markerPattern.test(source)) continue;

	filesWithMarkers += 1;
	const namedPatch = patchSource(source);
	const compiledPatch = patchOfficialCompiledSource(namedPatch.output);
	const emailPatch = patchOfficialCompiledEmailSource(compiledPatch.output);
	const otpPatch = patchOfficialCompiledOtpSource(emailPatch.output);
	const inviteAcceptPatch = patchOfficialCompiledInviteAcceptSource(
		otpPatch.output,
	);
	const output = inviteAcceptPatch.output;
	const replacements =
		namedPatch.replacements +
		compiledPatch.replacements +
		emailPatch.replacements +
		otpPatch.replacements +
		inviteAcceptPatch.replacements;
	if (replacements > 0) {
		if (!dryRun) writeFileSync(file, output);
		if (isStaticChunk(file)) changedStaticChunks.push(file);
		filesChanged += 1;
		totalReplacements += replacements;
		console.log(
			`${dryRun ? "would patch" : "patched"} ${replacements} compiled call(s): ${file.replace(root, "")}`,
		);
	}
}

for (const file of walk(root)) {
	const { size } = statSync(file);
	if (size > 20 * 1024 * 1024) continue;

	const source = readFileSync(file, "utf8");
	if (markerPattern.test(source)) continue;

	const compiledPatch = patchOfficialCompiledSource(source);
	const emailPatch = patchOfficialCompiledEmailSource(compiledPatch.output);
	const otpPatch = patchOfficialCompiledOtpSource(emailPatch.output);
	const inviteAcceptPatch = patchOfficialCompiledInviteAcceptSource(
		otpPatch.output,
	);
	const output = inviteAcceptPatch.output;
	const replacements =
		compiledPatch.replacements +
		emailPatch.replacements +
		otpPatch.replacements +
		inviteAcceptPatch.replacements;
	if (replacements > 0) {
		if (!dryRun) writeFileSync(file, output);
		if (isStaticChunk(file)) changedStaticChunks.push(file);
		filesChanged += 1;
		totalReplacements += replacements;
		console.log(
			`${dryRun ? "would patch" : "patched"} ${replacements} compiled call(s): ${file.replace(root, "")}`,
		);
	}
}

cacheBustedStaticChunks = cacheBustStaticChunks(changedStaticChunks);

let putEvidence = 0;
let remainingPostUploadEvidence = 0;
let remainingPostPresignEvidence = 0;
let emailSenderEvidence = 0;
let otpSessionRetryEvidence = 0;
let inviteAcceptSelfHostedEvidence = 0;
let remainingInviteSubscriptionGateEvidence = 0;
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

	emailSenderEvidence +=
		source.match(/process\.env\.RESEND_FROM_EMAIL/g)?.length ?? 0;
	otpSessionRetryEvidence +=
		source.match(
			/\/api\/auth\/session",\{cache:"no-store",credentials:"include"\}/g,
		)?.length ?? 0;
	inviteAcceptSelfHostedEvidence +=
		source.match(/stripeSubscriptionId:null/g)?.length ?? 0;
	remainingInviteSubscriptionGateEvidence +=
		source.match(/Organization owner not found or has no subscription/g)
			?.length ?? 0;
}

console.log(
	JSON.stringify({
		root,
		filesScanned,
		filesWithMarkers,
		filesChanged,
		totalReplacements,
		cacheBustedStaticChunks,
		putEvidence,
		remainingPostUploadEvidence,
		remainingPostPresignEvidence,
		emailSenderEvidence,
		otpSessionRetryEvidence,
		inviteAcceptSelfHostedEvidence,
		remainingInviteSubscriptionGateEvidence,
	}),
);

if (
	putEvidence < 3 ||
	cacheBustedStaticChunks < 2 ||
	remainingPostUploadEvidence > 0 ||
	remainingPostPresignEvidence > 0 ||
	emailSenderEvidence < 3 ||
	otpSessionRetryEvidence < 1 ||
	inviteAcceptSelfHostedEvidence < 1 ||
	remainingInviteSubscriptionGateEvidence > 0
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
