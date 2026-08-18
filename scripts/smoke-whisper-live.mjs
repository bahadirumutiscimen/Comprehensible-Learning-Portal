import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const nativeRequire = createRequire(import.meta.url);
const result = await build({
	entryPoints: [resolve(root, "youtube.ts")],
	bundle: true,
	format: "cjs",
	platform: "node",
	write: false,
	plugins: [{
		name: "obsidian-whisper-smoke-shim",
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
const youtube = module.exports;

const setup = await youtube.probeWhisperSetup("", "base.en");
assert.equal(setup.available, true, setup.detail);
const transcript = await youtube.fetchYoutubeTranscriptWithWhisper(
	"https://www.youtube.com/watch?v=dXAs6lQD7tk",
	"en",
	{ whisperModel: "base.en", maxDurationSeconds: 30 },
);
assert.equal(transcript.videoId, "dXAs6lQD7tk");
assert.ok(transcript.segments.length >= 3);
assert.ok(transcript.segments.every((segment) => segment.text.trim() && segment.duration > 0));
assert.ok(transcript.segments.some((segment) => /sherlock|winter|morning/i.test(segment.text)));

console.log(JSON.stringify({
	setup: setup.detail,
	title: transcript.title,
	segments: transcript.segments,
}, null, 2));
