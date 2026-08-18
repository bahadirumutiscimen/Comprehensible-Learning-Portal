import assert from "node:assert/strict";
import { build } from "esbuild";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { posix } from "node:path";
import JSZip from "jszip";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const result = await build({
	entryPoints: [resolve(root, "youtube.ts")],
	bundle: true,
	format: "esm",
	platform: "node",
	write: false,
	plugins: [{
		name: "obsidian-test-shim",
		setup(api) {
			api.onResolve({ filter: /^obsidian$/ }, () => ({ path: "obsidian", namespace: "test-shim" }));
			api.onLoad({ filter: /.*/, namespace: "test-shim" }, () => ({
				contents: "export const Platform={isDesktopApp:false,isMobileApp:false}; export async function requestUrl(){throw new Error('network is not available in pure tests')}",
				loader: "js",
			}));
		},
	}],
});
const moduleUrl = `data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`;
const youtube = await import(moduleUrl);

const videoId = "dXAs6lQD7tk";
const playlistId = "PLA1HFinRcKT4HQqb6-WaLWzWPouDHZAns";
for (const input of [
	videoId,
	`https://www.youtube.com/watch?v=${videoId}`,
	`https://youtu.be/${videoId}`,
	`https://www.youtube.com/shorts/${videoId}`,
	`https://www.youtube-nocookie.com/embed/${videoId}`,
]) {
	assert.equal(youtube.parseYoutubeInput(input).videoId, videoId, `video id: ${input}`);
}
assert.deepEqual(
	youtube.parseYoutubeInput(`https://www.youtube.com/watch?v=${videoId}&list=${playlistId}`),
	{ videoId, playlistId },
);
assert.deepEqual(
	youtube.parseYoutubeInput(`https://www.youtube.com/playlist?list=${playlistId}`),
	{ videoId: null, playlistId },
);
assert.deepEqual(youtube.parseYoutubeInput("https://example.com/watch?v=dXAs6lQD7tk"), { videoId: null, playlistId: null });

const parsedPlaylist = youtube.parseYoutubePlaylistJson(JSON.stringify({ entries: [
	{ id: videoId, title: "First video", playlist_index: 1 },
	{ url: "secondVideo1", title: "invalid id" },
	{ id: "AbC12345678", title: "Second video", playlist_index: 3 },
	{ id: videoId, title: "duplicate" },
] }));
assert.deepEqual(parsedPlaylist, [
	{ videoId, title: "First video", index: 0 },
	{ videoId: "AbC12345678", title: "Second video", index: 2 },
]);

const fakeFs = { existsSync: (value) => value === "/Users/test/.local/bin/whisper" };
const fakeOs = { homedir: () => "/Users/test" };
assert.equal(youtube.resolveToolCommand("", "whisper", fakeFs, fakeOs, posix), "/Users/test/.local/bin/whisper");
assert.equal(youtube.resolveToolCommand("/custom/yt-dlp", "yt-dlp", fakeFs, fakeOs, posix), "/custom/yt-dlp");
const modelFs = { existsSync: (value) => value === "/Users/test/Library/Application Support/Comprehensible Learning Portal/Models/ggml-base.en.bin" };
assert.equal(
	youtube.resolveWhisperModel("base.en", modelFs, fakeOs, posix),
	"/Users/test/Library/Application Support/Comprehensible Learning Portal/Models/ggml-base.en.bin",
);

const storyboard = youtube.selectYoutubeStoryboardFrame(JSON.stringify({
	format_note: "storyboard", width: 320, height: 180, fps: 0.1, rows: 3, columns: 3,
	fragments: [{ url: "https://img/0.jpg", duration: 90 }, { url: "https://img/1.jpg", duration: 90 }],
	http_headers: { "User-Agent": "test" },
}), 125);
assert.deepEqual(storyboard, {
	url: "https://img/1.jpg", headers: { "User-Agent": "test" },
	width: 320, height: 180, x: 0, y: 180,
});

assert.deepEqual(youtube.parseWhisperJson({
	segments: [{ start: 1.25, end: 3.5, text: " Python Whisper " }],
}), [{ start: 1.25, duration: 2.25, text: "Python Whisper" }]);
assert.deepEqual(youtube.parseWhisperJson({
	transcription: [{ offsets: { from: 2280, to: 5800 }, text: " whisper.cpp " }],
}), [{ start: 2.28, duration: 3.52, text: "whisper.cpp" }]);

const parsedCaptions = youtube.parseYoutubeJson3Captions(JSON.stringify({ events: [
	{ tStartMs: 0, dDurationMs: 900, segs: [{ utf8: "Hello" }] },
	{ tStartMs: 900, dDurationMs: 900, segs: [{ utf8: "world." }] },
	{ tStartMs: 950, dDurationMs: 900, segs: [{ utf8: "world." }] },
	{ tStartMs: 1800, dDurationMs: 900, aAppend: 1, segs: [{ utf8: "ignored rolling append" }] },
] }));
assert.equal(parsedCaptions[0].text, "Hello world.");
assert.ok(parsedCaptions.every((segment) => !segment.text.includes("ignored")));
assert.throws(() => youtube.parseYoutubeJson3Captions("not-json"), /altyazı biçimi/);

const cacheOptions = {
	sourceLanguage: "en",
	captionPreference: "manual-first",
	pauseMode: "adaptive",
	pauseSeconds: 2.8,
	topicTransitions: true,
};
assert.equal(
	youtube.youtubeStoryCacheKey(`https://youtu.be/${videoId}`, cacheOptions),
	youtube.youtubeStoryCacheKey(`https://www.youtube.com/watch?v=${videoId}`, cacheOptions),
);

const longOpening = "Renewable energy changes how cities produce and distribute electricity while lowering emissions and improving long-term resilience.";
const segments = [
	{ start: 0, duration: 2, text: longOpening },
	{ start: 2.1, duration: 2, text: "Solar and wind systems are the first examples." },
	{ start: 4.2, duration: 2, text: "The story now moves to a completely different historical scene." },
	{ start: 6.3, duration: 2, text: "A researcher opens an old laboratory notebook." },
];
const aiSplit = youtube.buildStoryParagraphs(segments, {
	pauseSeconds: 5,
	topicTransitions: true,
	topicBoundaryStarts: [4.2],
});
assert.equal(aiSplit.length, 2, "AI topic boundary should add a paragraph split");
assert.equal(aiSplit[1].start, 4.2);
assert.equal(aiSplit[0].id, "yt-p0001");
assert.ok(aiSplit.every((paragraph) => paragraph.sourceHash));

const pauseSplit = youtube.buildStoryParagraphs([
	{ start: 0, duration: 1, text: "First idea continues here without a topic signal" },
	{ start: 4.5, duration: 1, text: "Second idea begins after a long pause" },
], { pauseSeconds: 2, topicTransitions: false });
assert.equal(pauseSplit.length, 2, "long pause should remain an independent boundary");

const translations = Object.fromEntries(aiSplit.map((paragraph) => [paragraph.id, { ...paragraph, translation: `TR ${paragraph.id}` }]));
const markdown = youtube.renderYoutubeStoryMarkdown({
	videoId,
	title: "Acceptance Story",
	sourceLanguage: "en",
	segments,
}, aiSplit, translations);
assert.equal((markdown.match(/clp-youtube-story-source/g) ?? []).length, aiSplit.length);
assert.equal((markdown.match(/clp-youtube-story-translation/g) ?? []).length, aiSplit.length);
assert.ok(markdown.includes(`youtube-id: ${videoId}`));

const epubBytes = await youtube.renderYoutubeStoryEpub({
	videoId,
	title: "Acceptance EPUB",
	sourceLanguage: "en",
	segments,
}, aiSplit, translations);
const epubZip = await JSZip.loadAsync(epubBytes);
assert.equal(await epubZip.file("mimetype").async("string"), "application/epub+zip");
assert.ok((await epubZip.file("OEBPS/content.opf").async("string")).includes("application/xhtml+xml"));
assert.ok((await epubZip.file("OEBPS/text/story.xhtml").async("string")).includes("clp-bilingual-translation"));

let liveFixtureSegments = null;
let liveFixtureParagraphs = null;
if (process.env.CLP_JSON3_FIXTURE) {
	const liveSegments = youtube.parseYoutubeJson3Captions(await readFile(process.env.CLP_JSON3_FIXTURE, "utf8"));
	assert.ok(liveSegments.length > 100, "live caption fixture should contain a substantial transcript");
	assert.ok(liveSegments.every((segment, index) => index === 0 || segment.start >= liveSegments[index - 1].start));
	assert.ok(liveSegments.every((segment) => segment.text.trim() && segment.duration > 0));
	const liveParagraphs = youtube.buildStoryParagraphs(liveSegments, { topicTransitions: true });
	assert.ok(liveParagraphs.length >= 10 && liveParagraphs.length < liveSegments.length);
	assert.ok(liveParagraphs.every((paragraph) => paragraph.text.length > 0 && paragraph.duration > 0));
	liveFixtureSegments = liveSegments.length;
	liveFixtureParagraphs = liveParagraphs.length;
}

console.log(JSON.stringify({
	passed: 24,
	checks: ["video/playlist identity", "flat playlist JSON parsing", "desktop tool/model discovery", "storyboard frame selection", "Python/whisper.cpp JSON", "JSON3 rolling-caption cleanup", "cache identity", "AI topic boundary", "pause boundary", "bilingual Markdown alignment", "bilingual EPUB packaging"],
	liveFixtureSegments,
	liveFixtureParagraphs,
}, null, 2));
