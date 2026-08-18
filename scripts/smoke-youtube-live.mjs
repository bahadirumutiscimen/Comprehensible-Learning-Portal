import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const nativeRequire = createRequire(import.meta.url);

async function loadDesktopModule(entry) {
	const result = await build({
		entryPoints: [resolve(root, entry)],
		bundle: true,
		format: "cjs",
		platform: "node",
		write: false,
		plugins: [{
			name: "obsidian-live-smoke-shim",
			setup(api) {
				api.onResolve({ filter: /^obsidian$/ }, () => ({ path: "obsidian", namespace: "test-shim" }));
				api.onLoad({ filter: /.*/, namespace: "test-shim" }, () => ({
					contents: `
						export const Platform={isDesktopApp:true,isMobileApp:false};
						export async function requestUrl(options){
							const response=await fetch(options.url,{headers:options.headers});
							const arrayBuffer=await response.arrayBuffer();
							return {status:response.status,arrayBuffer,text:new TextDecoder().decode(arrayBuffer),headers:{}};
						}
					`,
					loader: "js",
				}));
			},
		}],
	});
	const module = { exports: {} };
	new Function("module", "exports", "require", result.outputFiles[0].text)(module, module.exports, nativeRequire);
	return module.exports;
}

const youtube = await loadDesktopModule("youtube.ts");
const translation = await loadDesktopModule("translation-service.ts");
const url = "https://www.youtube.com/watch?v=dXAs6lQD7tk&list=PLA1HFinRcKT4HQqb6-WaLWzWPouDHZAns";
const settings = {
	backend: "codex",
	sourceLanguage: "en",
	targetLanguage: "tr",
	codexCommand: "",
	codexModel: "gpt-5.4-mini",
	reasoningEffort: "low",
	timeoutSeconds: 180,
	batchCharacters: 4000,
	viewMode: "bilingual",
	bilingualLayout: "auto",
};

const ytDlp = await youtube.probeLocalTool("yt-dlp");
const ffmpeg = await youtube.probeLocalTool("ffmpeg");
assert.equal(ytDlp.available, true, ytDlp.detail);
assert.equal(ffmpeg.available, true, ffmpeg.detail);

if (process.argv.includes("--frame-only")) {
	const frame = await youtube.captureYoutubeFrame("dXAs6lQD7tk", 125);
	const bytes = new Uint8Array(frame);
	assert.ok(bytes.length > 1000);
	assert.equal(bytes[0], 0xff);
	assert.equal(bytes[1], 0xd8);
	console.log(JSON.stringify({ videoId: "dXAs6lQD7tk", time: 125, frameBytes: bytes.length }, null, 2));
	process.exit(0);
}

const transcript = await youtube.fetchYoutubeTranscriptWithYtDlp(url, "en");
assert.equal(transcript.videoId, "dXAs6lQD7tk");
assert.ok(transcript.title.trim().length > 0);
assert.ok(transcript.segments.length > 20);
assert.ok(transcript.segments.every((segment) => segment.text.trim() && segment.duration > 0));

// A bounded prefix proves the real Codex topic-boundary adapter without making
// the acceptance smoke needlessly expensive for a long video.
const topicSample = transcript.segments.slice(0, 36);
const topicBoundaryStarts = await youtube.detectTopicBoundaryStarts(topicSample, { settings });
const paragraphs = youtube.buildStoryParagraphs(transcript.segments, {
	topicTransitions: true,
	topicBoundaryStarts,
});
assert.ok(paragraphs.length > 3);
assert.ok(paragraphs.every((paragraph) => paragraph.text.trim() && paragraph.sourceHash && paragraph.duration > 0));

const sample = paragraphs.slice(0, 2);
const cache = {};
const translated = await translation.translateUnits(sample, { settings, cache });
assert.equal(translated.pairs.length, sample.length);
assert.deepEqual(translated.pairs.map((pair) => pair.id), sample.map((paragraph) => paragraph.id));
assert.ok(translated.pairs.every((pair) => pair.translation.trim().length > 0));

let frameBytes = null;
if (process.argv.includes("--frame")) {
	const frame = await youtube.captureYoutubeFrame(transcript.videoId, paragraphs[0].start);
	const bytes = new Uint8Array(frame);
	assert.ok(bytes.length > 1000);
	assert.equal(bytes[0], 0xff);
	assert.equal(bytes[1], 0xd8);
	frameBytes = bytes.length;
}

console.log(JSON.stringify({
	videoId: transcript.videoId,
	title: transcript.title,
	segments: transcript.segments.length,
	paragraphs: paragraphs.length,
	topicBoundariesInSample: topicBoundaryStarts.length,
	translations: translated.pairs.map(({ id, translation: text }) => ({ id, text })),
	usage: translated.usage,
	ytDlp: ytDlp.detail,
	ffmpeg: ffmpeg.detail,
	frameBytes,
}, null, 2));
