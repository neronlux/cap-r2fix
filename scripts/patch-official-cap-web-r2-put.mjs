import { readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { extname, basename, dirname, join } from "node:path";

const root = process.env.CAP_WEB_IMAGE_ROOT ?? "/app";
const dryRun = process.env.CAP_R2_PATCH_DRY_RUN === "1";

const PATCHABLE_EXT = new Set([".js", ".mjs", ".cjs"]);
const TEXT_EXT = new Set([...PATCHABLE_EXT, ".json", ".html", ".txt"]);
const MAX_FILE_SIZE = 20 * 1024 * 1024;

const MARKER = /createUploadTargetFor(?:User|Video)|\.createUploadTarget\(/;
const CALL_PATTERN = /createUploadTargetFor(?:User|Video)\(|\.createUploadTarget\(/g;
const CLUE_PATTERN = /x-amz-meta-userid|presignedPostData|s3Post|getPresignedPostUrl|raw-upload\.mp4|Presigned URL created successfully|\.well-known\/workflow|\/verify-otp|\/video\/process|x-media-server-secret/;

// ── Helpers ──────────────────────────────────────────────────────────────────

function walk(dir) {
	const results = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const p = join(dir, entry.name);
		if (entry.isDirectory()) {
			if (entry.name === "node_modules" || entry.name === ".git") continue;
			results.push(...walk(p));
		} else if (entry.isFile() && PATCHABLE_EXT.has(extname(p))) {
			results.push(p);
		}
	}
	return results;
}

function walkText(dir) {
	const results = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const p = join(dir, entry.name);
		if (entry.isDirectory()) {
			if (entry.name === "node_modules" || entry.name === ".git") continue;
			results.push(...walkText(p));
		} else if (entry.isFile() && TEXT_EXT.has(extname(p))) {
			results.push(p);
		}
	}
	return results;
}

function isStaticChunk(p) {
	return p.includes("/apps/web/.next/static/chunks/") && p.endsWith(".js");
}

function findMatchingBrace(source, start) {
	let depth = 0;
	let quote = null;
	let escaped = false;
	let lineComment = false;
	let blockComment = false;

	for (let i = start; i < source.length; i++) {
		const c = source[i];
		const next = source[i + 1];

		if (lineComment) { if (c === "\n") lineComment = false; continue; }
		if (blockComment) { if (c === "*" && next === "/") { blockComment = false; i += 1; } continue; }
		if (quote) { if (escaped) { escaped = false; continue; } if (c === "\\") { escaped = true; continue; } if (c === quote) quote = null; continue; }
		if (c === "/" && next === "/") { lineComment = true; i += 1; continue; }
		if (c === "*" && next === "/") { blockComment = true; i += 1; continue; }
		if (c === '"' || c === "'" || c === "`") { quote = c; continue; }

		if (c === "{") depth += 1;
		if (c === "}") { depth -= 1; if (depth === 0) return i; }
	}
	return -1;
}

function findUploadOptionsObject(source, callIndex) {
	const limit = Math.min(source.length, callIndex + 900);
	let from = callIndex;

	while (from < limit) {
		const objStart = source.indexOf("{", from);
		if (objStart === -1 || objStart > limit) return null;

		const objEnd = findMatchingBrace(source, objStart);
		if (objEnd === -1) return null;

		const obj = source.slice(objStart, objEnd + 1);
		if (/\bcontentType\s*:/.test(obj) && /\bfields\s*:/.test(obj)) {
			return { objectStart: objStart, objectEnd: objEnd, objectSource: obj };
		}
		from = objEnd + 1;
	}
	return null;
}

// ── Source-level patch (named upload targets → presigned PUT) ────────────────

function patchSource(source) {
	const insertions = [];

	for (const match of source.matchAll(CALL_PATTERN)) {
		const options = findUploadOptionsObject(source, match.index ?? 0);
		if (!options) continue;
		if (/\bmethod\s*:/.test(options.objectSource)) continue;

		const fieldsMatch = /\bfields\s*:/.exec(options.objectSource);
		if (!fieldsMatch) continue;

		insertions.push(options.objectStart + fieldsMatch.index);
	}

	if (insertions.length === 0) return { output: source, count: 0 };

	let output = "";
	let cursor = 0;
	for (const pos of insertions) {
		output += source.slice(cursor, pos);
		output += 'method:"put",';
		cursor = pos;
	}
	output += source.slice(cursor);
	return { output, count: insertions.length };
}

// ── Compiled-image patches ───────────────────────────────────────────────────

const compiledPatches = [
	{
		name: "presigned-post→put (inline fields)",
		apply(source) {
			const r = source.replace(
				/yield\*([A-Za-z_$][\w$]*)\.getPresignedPostUrl\(([^,()]+),\{Fields:\{"Content-Type":([^,{}]+),[^{}]*\},Expires:(\d+)\}\)/g,
				(_m, bucket, key, ct, exp) =>
					`({url:yield*${bucket}.getPresignedPutUrl(${key},{ContentType:${ct}},{expiresIn:${exp}}),fields:{}})`,
			);
			return { output: r, count: r !== source ? 1 : 0 };
		},
		verify: (s) => (s.match(/getPresignedPutUrl\([^)]*\{ContentType:/g) ?? []).length,
	},
	{
		name: "presigned-post→put (variable fields)",
		apply(source) {
			const r = source.replace(
				/yield\*([A-Za-z_$][\w$]*)\.getPresignedPostUrl\(([^,()]+),\{Fields:([A-Za-z_$][\w$]*),Expires:(\d+)\}\)/g,
				(_m, bucket, key, fields, exp) =>
					`({url:yield*${bucket}.getPresignedPutUrl(${key},{ContentType:${fields}["Content-Type"]},{expiresIn:${exp}}),fields:{}})`,
			);
			return { output: r, count: r !== source ? 1 : 0 };
		},
		verify: (s) => (s.match(/getPresignedPutUrl\([^)]*\{ContentType:/g) ?? []).length,
	},
	{
		name: "upload method default post→put",
		apply(source) {
			const r = source.replaceAll('.default("post"),durationInSecs:', '.default("put"),durationInSecs:');
			return { output: r, count: source.split('.default("post"),durationInSecs:').length - 1 };
		},
		verify: (s) => (s.match(/getPresignedPutUrl\([^)]*\{ContentType:/g) ?? []).length,
	},
	{
		name: "XHR upload pairs → PUT + send correct body",
		apply(source) {
			let output = source;
			let total = 0;
			const pairs = [
				['c.open("POST",h.presignedPostData.url)', 'c.open("PUT",h.presignedPostData.url),c.setRequestHeader("Content-Type","video/mp4")', "c.send(j)", "c.send(a)"],
				['r.open("POST",l.presignedPostData.url)', 'r.open("PUT",l.presignedPostData.url),r.setRequestHeader("Content-Type","video/mp4")', "r.send(d)", 'r.send(d.get("file"))'],
				['j.open("POST",b.url)', 'j.open("PUT",b.url),j.setRequestHeader("Content-Type","video/mp4")', "j.send(i)", "j.send(h)"],
				['e.open("POST",a.presignedPostData.url)', 'e.open("PUT",a.presignedPostData.url),e.setRequestHeader("Content-Type","image/jpeg")', "e.send(b)", "e.send(f)"],
				['n.open("POST",e.presignedPostData.url)', 'n.open("PUT",e.presignedPostData.url),n.setRequestHeader("Content-Type","image/jpeg")', "n.send(t)", "n.send(l)"],
				['d.open("POST",t.url)', 'd.open("PUT",t.url),d.setRequestHeader("Content-Type","video/mp4")', "d.send(o)", "d.send(l)"],
			];
			for (const [openS, openR, sendS, sendR] of pairs) {
				const openCount = output.split(openS).length - 1;
				if (openCount === 0) continue;
				output = output.replaceAll(openS, openR);
				total += openCount;
				const sendCount = output.split(sendS).length - 1;
				if (sendCount > 0) output = output.replaceAll(sendS, sendR);
			}
			return { output, count: total };
		},
		verify: (s) => (s.match(/open\("PUT",[^)]*\)/g) ?? []).length,
	},
	{
		name: "queue body toString",
		apply(source) {
			const search = "body:k});if(d.ok)return;let e=await d.text();if(503===d.status";
			const replacement = "body:k.toString()});if(d.ok)return;let e=await d.text();if(503===d.status";
			const count = source.split(search).length - 1;
			if (count === 0) return { output: source, count: 0 };
			return { output: source.replaceAll(search, replacement), count };
		},
		verify: (s) => (s.match(/body:k\.toString\(\)\}\)/g) ?? []).length,
	},
	{
		name: "email sender RESEND_FROM_EMAIL override",
		apply(source) {
			const domainExpr = "$" + "{(0,d.NK)().RESEND_FROM_DOMAIN}";
			const original =
				'l=k||(f?"Richie from Cap <richie@send.cap.so>":d.WB.NEXT_PUBLIC_IS_CAP?"Cap Auth <no-reply@auth.cap.so>":`auth@' +
				domainExpr +
				"`)";
			const patched = original.replace("l=k||", "l=k||process.env.RESEND_FROM_EMAIL||");
			const count = source.split(original).length - 1;
			if (count === 0) return { output: source, count: 0 };
			return { output: source.replaceAll(original, patched), count };
		},
		verify: (s) => (s.match(/process\.env\.RESEND_FROM_EMAIL/g) ?? []).length,
	},
	{
		name: "OTP session retry",
		apply(source) {
			const search =
				'mutationFn:async()=>{let e=x.join("");if(6!==e.length)throw"Please enter a complete 6-digit code";if(!(await fetch("/api/auth/callback/email?email=".concat(encodeURIComponent(j),"&token=").concat(encodeURIComponent(e),"&callbackUrl=").concat(encodeURIComponent("/login-success")))).url.includes("/login-success")){var t;throw m(["","","","","",""]),null==(t=f.current[0])||t.focus(),"Invalid code. Please try again."}}';
			const replacement =
				'mutationFn:async()=>{let e=x.join("");if(6!==e.length)throw"Please enter a complete 6-digit code";let t=()=>{var e;m(["","","","","",""]),null==(e=f.current[0])||e.focus()},r=await fetch("/api/auth/callback/email?email=".concat(encodeURIComponent(j),"&token=").concat(encodeURIComponent(e),"&callbackUrl=").concat(encodeURIComponent("/login-success")),{cache:"no-store",credentials:"include"});if(r.url.includes("error=Verification"))throw t(),"Invalid code. Please try again.";for(let e=0;e<8;e++){let r=await fetch("/api/auth/session",{cache:"no-store",credentials:"include"});if(r.ok){let e=await r.json();if(null==e?void 0:e.user)return}await new Promise(e=>setTimeout(e,250))}throw t(),"Invalid code. Please try again."}';
			const count = source.split(search).length - 1;
			if (count === 0) return { output: source, count: 0 };
			return { output: source.replaceAll(search, replacement), count };
		},
		verify: (s) =>
			(s.match(/\/api\/auth\/session",\{cache:"no-store",credentials:"include"\}/g) ?? []).length,
	},
	{
		name: "invite accept skip subscription gate",
		apply(source) {
			const search =
				'if(!d||!d.stripeSubscriptionId)return z.NextResponse.json({error:"Organization owner not found or has no subscription"},{status:404});';
			const replacement = "d||(d={stripeSubscriptionId:null});";
			const count = source.split(search).length - 1;
			if (count === 0) return { output: source, count: 0 };
			return { output: source.replaceAll(search, replacement), count };
		},
		verify: (s) => (s.match(/stripeSubscriptionId:null/g) ?? []).length,
	},
	{
		name: "workflow proxy allowlist",
		apply(source) {
			let count = 0;
			const output = source.replace(
				/(([A-Za-z_$][\w$]*)\.startsWith\("\/api"\)\|\|)(\2\.startsWith\("\/login"\))/g,
				(match, prefix, pathVar, loginCheck) => {
					if (match.includes("/.well-known/workflow")) return match;
					count += 1;
					return `${prefix}${pathVar}.startsWith("/.well-known/workflow")||${loginCheck}`;
				},
			);
			return { output, count };
		},
		verify: (s) =>
			(s.match(/startsWith\("\/\.well-known\/workflow"\)/g) ?? []).length,
	},
	{
		name: "media server webhook auth",
		apply(source) {
			let count = 0;
			const output = source.replace(
				/fetch\(`\$\{([A-Za-z_$][\w$]*)\}\/video\/process`,\{method:"POST",headers:\{"Content-Type":"application\/json"\},body:JSON\.stringify\(\{videoId:([A-Za-z_$][\w$]*),userId:([A-Za-z_$][\w$]*),videoUrl:([A-Za-z_$][\w$]*),outputPresignedUrl:([A-Za-z_$][\w$]*),thumbnailPresignedUrl:([A-Za-z_$][\w$]*),webhookUrl:([A-Za-z_$][\w$]*)\}\)\}\)/g,
				(m, url, vid, uid, vurl, out, thumb, hook) => {
					if (m.includes("x-media-server-secret") || m.includes("webhookSecret")) return m;
					count += 1;
					return `fetch(\`\${${url}}/video/process\`,{method:"POST",headers:{"Content-Type":"application/json",...(process.env.MEDIA_SERVER_WEBHOOK_SECRET?{"x-media-server-secret":process.env.MEDIA_SERVER_WEBHOOK_SECRET}:{})},body:JSON.stringify({videoId:${vid},userId:${uid},videoUrl:${vurl},outputPresignedUrl:${out},thumbnailPresignedUrl:${thumb},webhookUrl:${hook},webhookSecret:process.env.MEDIA_SERVER_WEBHOOK_SECRET||void 0})})`;
				},
			);
			return { output, count };
		},
		verify: (s) =>
			(s.match(/webhookSecret:process\.env\.MEDIA_SERVER_WEBHOOK_SECRET\|\|void 0/g) ?? [])
				.length,
	},
];

// ── Verification assertions ──────────────────────────────────────────────────

const assertions = [
	{ name: "putEvidence", threshold: 3, verify: (s) => (s.match(/getPresignedPutUrl\([^)]*\{ContentType:/g) ?? []).length + (s.match(/createUploadTargetFor(?:User|Video)|\.createUploadTarget\(/g) ? (s.match(/method\s*:\s*["']put["']/g) ?? []).length : 0) },
	{ name: "remainingPostUploads", threshold: 0, max: 0, verify: (s) => (s.match(/open\("POST",[^)]*(?:presignedPostData\.url|\.url)\)/g) ?? []).length },
	{ name: "remainingPostPresign", threshold: 0, max: 0, verify: (s) => (/getPresignedPostUrl\([^)]*\{Fields:(?:\{|[A-Za-z_$])/.test(s) && /x-amz-meta-userid/.test(s)) ? 1 : 0 },
	{ name: "emailSender", threshold: 3, verify: (s) => (s.match(/process\.env\.RESEND_FROM_EMAIL/g) ?? []).length },
	{ name: "otpSessionRetry", threshold: 1, verify: (s) => (s.match(/\/api\/auth\/session",\{cache:"no-store",credentials:"include"\}/g) ?? []).length },
	{ name: "inviteAcceptSelfHosted", threshold: 1, verify: (s) => (s.match(/stripeSubscriptionId:null/g) ?? []).length },
	{ name: "inviteSubscriptionGateGone", threshold: 0, max: 0, verify: (s) => (s.match(/Organization owner not found or has no subscription/g) ?? []).length },
	{ name: "workflowProxy", threshold: 1, verify: (s) => (s.match(/startsWith\("\/\.well-known\/workflow"\)/g) ?? []).length },
	{ name: "mediaServerAuth", threshold: 1, verify: (s) => (s.match(/webhookSecret:process\.env\.MEDIA_SERVER_WEBHOOK_SECRET\|\|void 0/g) ?? []).length },
];

// ── Cache busting ────────────────────────────────────────────────────────────

function cacheBust(changedChunks) {
	const unique = [...new Set(changedChunks)].filter(isStaticChunk);
	const renames = [];

	for (const file of unique) {
		const name = basename(file);
		if (name.endsWith(".r2fix.js") || name.endsWith(".r2fix2.js")) continue;
		const newName = name.replace(/\.js$/, ".r2fix2.js");
		renames.push({ oldPath: file, newPath: join(dirname(file), newName), oldName: name, newName });
	}

	if (renames.length === 0 || dryRun) return renames.length;

	for (const file of walkText(root)) {
		if (statSync(file).size > MAX_FILE_SIZE) continue;
		let source = readFileSync(file, "utf8");
		let changed = false;
		for (const { oldName, newName } of renames) {
			if (!source.includes(oldName)) continue;
			source = source.replaceAll(oldName, newName);
			changed = true;
		}
		if (changed) writeFileSync(file, source);
	}

	for (const { oldPath, newPath } of renames) renameSync(oldPath, newPath);
	return renames.length;
}

// ── Main ─────────────────────────────────────────────────────────────────────

let filesScanned = 0;
let filesChanged = 0;
let totalReplacements = 0;
const changedStaticChunks = [];

for (const file of walk(root)) {
	if (statSync(file).size > MAX_FILE_SIZE) continue;
	filesScanned += 1;

	let source = readFileSync(file, "utf8");
	let replacements = 0;

	if (MARKER.test(source)) {
		const named = patchSource(source);
		source = named.output;
		replacements += named.count;
	}

	for (const patch of compiledPatches) {
		const result = patch.apply(source);
		source = result.output;
		replacements += result.count;
	}

	if (replacements > 0) {
		if (!dryRun) writeFileSync(file, source);
		if (isStaticChunk(file)) changedStaticChunks.push(file);
		filesChanged += 1;
		totalReplacements += replacements;
		console.log(`${dryRun ? "would patch" : "patched"} ${replacements} call(s): ${file.replace(root, "")}`);
	}
}

const cacheBusted = cacheBust(changedStaticChunks);

// ── Verify patches landed ────────────────────────────────────────────────────

const evidence = {};
for (const file of walk(root)) {
	if (statSync(file).size > MAX_FILE_SIZE) continue;
	const source = readFileSync(file, "utf8");
	for (const a of assertions) {
		evidence[a.name] = (evidence[a.name] ?? 0) + a.verify(source);
	}
}

const failed = assertions.filter((a) => {
	const val = evidence[a.name] ?? 0;
	return a.max !== undefined ? val > a.max : val < a.threshold;
});

console.log(
	JSON.stringify({ root, filesScanned, filesChanged, totalReplacements, cacheBusted, evidence }),
);

if (failed.length > 0) {
	const clues = [];
	for (const file of walk(root)) {
		if (statSync(file).size > MAX_FILE_SIZE) continue;
		const source = readFileSync(file, "utf8");
		const match = CLUE_PATTERN.exec(source);
		if (!match) continue;
		clues.push({
			file: file.replace(root, ""),
			match: match[0],
			snippet: source.slice(Math.max(0, match.index - 220), match.index + 420).replace(/\s+/g, " "),
		});
		if (clues.length >= 20) break;
	}
	console.log(JSON.stringify({ failed: failed.map((f) => f.name), clues }, null, 2));
	throw new Error(`Patch verification failed: ${failed.map((f) => `${f.name}=${evidence[f.name] ?? 0}`).join(", ")}`);
}
