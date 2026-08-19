import { Platform, requestUrl } from "obsidian";
import JSZip from "jszip";
import type { AiProvider } from "./ai-client";
import { runTextPrompt, sourceHash, type TranslationPair, type TranslationUnit } from "./translation-service";
import type { TranslationSettings } from "./translation-settings";
import type { CaptionPreference } from "./youtube-settings";

export interface YoutubeCaptionSegment {
	start: number;
	duration: number;
	text: string;
}

export interface YoutubeParagraph extends TranslationUnit {
	start: number;
	duration: number;
}

export interface YoutubeTranscript {
	videoId: string;
	title: string;
	sourceLanguage: string;
	segments: YoutubeCaptionSegment[];
}

/** Caption tracks frequently omit punctuation. Keep the raw transcript
 * readable even when translation is disabled, and normalize the AI-restored
 * source before it is packaged into the EPUB. */
export function normalizeYoutubeEnglishText(text: string): string {
	let normalized = text.normalize("NFKC").replace(/\s+/g, " ").trim();
	if (!normalized) return normalized;
	normalized = normalized
		.replace(/\s+([,.;!?])/g, "$1")
		.replace(/([,;!?])(?=\S)/g, "$1 ");
	if (!/^[A-ZÀ-ÖØ-Þ]/.test(normalized)) normalized = normalized.charAt(0).toUpperCase() + normalized.slice(1);
	if (!/[.!?…]["'’”)]?$/.test(normalized)) normalized += ".";
	return normalized;
}

export interface YoutubeStoryCacheEntry {
	videoId: string;
	title: string;
	sourceLanguage: string;
	paragraphs: YoutubeParagraph[];
	createdAt: number;
}

export function youtubeStoryCacheKey(
	rawUrl: string,
	options: {
		sourceLanguage: string;
		captionPreference: CaptionPreference;
		pauseMode: "adaptive" | "custom";
		pauseSeconds: number;
		topicTransitions: boolean;
	},
): string {
	const videoId = parseYoutubeVideoId(rawUrl) ?? rawUrl.trim();
	// v3 invalidates older paragraph groupings so a re-import picks up the
	// sentence-aware boundary logic instead of reopening the stale story cache.
	return `youtube-story-v3:${sourceHash(JSON.stringify({ videoId, ...options }))}`;
}

export interface YoutubeFetchOptions {
	preferredLanguage?: string;
	captionPreference?: CaptionPreference;
}

export interface StoryParagraphOptions {
	pauseSeconds?: number;
	topicTransitions?: boolean;
	topicBoundaryStarts?: readonly number[];
}

export interface TopicBoundaryDetectionOptions {
	settings: TranslationSettings;
	provider?: AiProvider | null;
	signal?: AbortSignal;
}

interface CaptionTrack {
	baseUrl?: string;
	languageCode?: string;
	kind?: string;
}

interface PlayerResponse {
	videoDetails?: { title?: string };
	captions?: {
		playerCaptionsTracklistRenderer?: {
			captionTracks?: CaptionTrack[];
			audioTracks?: { audioTrackId?: string }[];
			defaultAudioTrackIndex?: number;
		};
	};
}

interface Json3Event {
	tStartMs?: number;
	dDurationMs?: number;
	aAppend?: number;
	segs?: { utf8?: string }[];
}

export interface YoutubeInputIdentity {
	videoId: string | null;
	playlistId: string | null;
}

export interface YoutubePlaylistEntry {
	videoId: string;
	title: string;
	index: number;
}

export function parseYoutubeInput(raw: string): YoutubeInputIdentity {
	const input = raw.trim();
	if (/^[A-Za-z0-9_-]{11}$/.test(input)) return { videoId: input, playlistId: null };
	try {
		const url = new URL(input);
		const playlist = url.searchParams.get("list");
		const playlistId = playlist && /^[A-Za-z0-9_-]+$/.test(playlist) ? playlist : null;
		if (url.hostname === "youtu.be") {
			const id = url.pathname.split("/").filter(Boolean)[0];
			return { videoId: id && /^[A-Za-z0-9_-]{11}$/.test(id) ? id : null, playlistId };
		}
		if (url.hostname.endsWith("youtube.com") || url.hostname.endsWith("youtube-nocookie.com")) {
			const id = url.searchParams.get("v")
				?? url.pathname.match(/\/(?:embed|shorts|live)\/([A-Za-z0-9_-]{11})/)?.[1];
			return { videoId: id && /^[A-Za-z0-9_-]{11}$/.test(id) ? id : null, playlistId };
		}
	} catch { return { videoId: null, playlistId: null }; }
	return { videoId: null, playlistId: null };
}

export function parseYoutubeVideoId(raw: string): string | null {
	return parseYoutubeInput(raw).videoId;
}

/** Parse yt-dlp's flat-playlist JSON separately from the network/tool call so
 *  the playlist identity and resume logic can be covered without downloading
 *  a real playlist in pure tests. */
export function parseYoutubePlaylistJson(raw: string): YoutubePlaylistEntry[] {
	let parsed: { entries?: unknown[] } | null = null;
	for (const line of raw.split(/\r?\n/).map((value) => value.trim()).filter(Boolean)) {
		try {
			const value = JSON.parse(line) as { entries?: unknown[] };
			if (Array.isArray(value.entries)) { parsed = value; break; }
		} catch { /* yt-dlp can interleave warnings; try the next line */ }
	}
	if (!parsed) {
		try {
			const value = JSON.parse(raw) as { entries?: unknown[] };
			if (Array.isArray(value.entries)) parsed = value;
		} catch { /* handled below */ }
	}
	if (!parsed?.entries) return [];
	const seen = new Set<string>();
	const entries: YoutubePlaylistEntry[] = [];
	for (const [index, rawEntry] of parsed.entries.entries()) {
		if (!rawEntry || typeof rawEntry !== "object") continue;
		const entry = rawEntry as { id?: unknown; url?: unknown; title?: unknown; playlist_index?: unknown };
		const videoId = typeof entry.id === "string" && /^[A-Za-z0-9_-]{11}$/.test(entry.id)
			? entry.id
			: typeof entry.url === "string" && /^[A-Za-z0-9_-]{11}$/.test(entry.url) ? entry.url : "";
		if (!videoId || seen.has(videoId)) continue;
		seen.add(videoId);
		entries.push({
			videoId,
			title: typeof entry.title === "string" && entry.title.trim() ? entry.title.trim() : `YouTube ${videoId}`,
			index: Number.isFinite(Number(entry.playlist_index)) ? Math.max(0, Number(entry.playlist_index) - 1) : index,
		});
	}
	return entries;
}

export async function fetchYoutubePlaylistEntries(
	rawUrl: string,
	configuredCommand = "",
	signal?: AbortSignal,
): Promise<YoutubePlaylistEntry[]> {
	if (!Platform.isDesktopApp) throw new Error("Playlist toplu işleme yalnızca masaüstünde çalışır.");
	/* eslint-disable @typescript-eslint/no-require-imports -- Desktop-only playlist discovery. */
	const childProcess = require("child_process") as typeof import("child_process");
	const fs = require("fs") as typeof import("fs");
	const os = require("os") as typeof import("os");
	const path = require("path") as typeof import("path");
	/* eslint-enable @typescript-eslint/no-require-imports -- End playlist discovery imports. */
	const command = resolveToolCommand(configuredCommand, "yt-dlp", fs, os, path);
	const result = await runTool(childProcess, command, [
		"--flat-playlist", "--dump-single-json", "--no-warnings", "--skip-download", rawUrl,
	], 10 * 60 * 1000, signal, localToolEnvironment(os, path));
	if (result.code !== 0) throw new Error(`Playlist videoları alınamadı: ${lastLines(result.stderr || result.stdout)}`);
	const entries = parseYoutubePlaylistJson(result.stdout);
	if (!entries.length) throw new Error("Playlist içinde işlenebilir video bulunamadı.");
	return entries;
}

export async function fetchYoutubeTranscript(rawUrl: string, options: YoutubeFetchOptions = {}): Promise<YoutubeTranscript> {
	const preferredLanguage = options.preferredLanguage ?? "en";
	const videoId = parseYoutubeVideoId(rawUrl);
	if (!videoId) throw new Error("YouTube video kimliği okunamadı.");
	const page = await requestUrl({
		url: `https://www.youtube.com/watch?v=${videoId}&hl=en`,
		headers: {
			"Accept-Language": "en-US,en;q=0.9",
			"User-Agent": "Mozilla/5.0 AppleWebKit/537.36 Chrome/126 Safari/537.36",
		},
		throw: false,
	});
	if (page.status < 200 || page.status >= 300) throw new Error(`YouTube HTTP ${page.status} döndürdü.`);
	const player = extractPlayerResponse(page.text);
	if (!player) throw new Error("YouTube oynatıcı bilgisi bulunamadı.");
	const renderer = player.captions?.playerCaptionsTracklistRenderer;
	const track = selectCaptionTrack(renderer?.captionTracks ?? [], preferredLanguage, options.captionPreference ?? "manual-first");
	if (!track?.baseUrl) throw new Error("Bu videoda erişilebilir İngilizce altyazı bulunamadı.");
	const captionUrl = `${track.baseUrl.replace(/([?&])fmt=[^&]*/g, "$1")}&fmt=json3`;
	const captions = await requestUrl({ url: captionUrl, throw: false });
	if (captions.status < 200 || captions.status >= 300) {
		throw new Error(`YouTube altyazısı HTTP ${captions.status} döndürdü.`);
	}
	return {
		videoId,
		title: player.videoDetails?.title?.trim() || `YouTube ${videoId}`,
		sourceLanguage: track.languageCode || preferredLanguage,
		segments: parseYoutubeJson3Captions(captions.text),
	};
}

/** Ask the configured learning backend for conservative topic/scene boundaries.
 * Candidate boundaries are chosen locally first, so the model sees compact
 * adjacent context rather than the complete transcript. Returned timestamps are
 * additive: pause, length and sentence-completion boundaries remain authoritative. */
export async function detectTopicBoundaryStarts(
	segments: YoutubeCaptionSegment[],
	options: TopicBoundaryDetectionOptions,
): Promise<number[]> {
	type Candidate = { id: string; index: number; start: number; before: string; after: string };
	const candidates: Candidate[] = [];
	for (let index = 1; index < segments.length; index++) {
		const previous = segments[index - 1];
		const current = segments[index];
		const gap = current.start - (previous.start + previous.duration);
		if (gap < 0.35 && !/[.!?]["'’”)]?$/.test(previous.text) && !looksLikeTopicShift(current.text)) continue;
		const before = segments.slice(Math.max(0, index - 2), index).map((segment) => segment.text).join(" ");
		const after = segments.slice(index, Math.min(segments.length, index + 2)).map((segment) => segment.text).join(" ");
		candidates.push({
			id: `b${String(index).padStart(5, "0")}`,
			index,
			start: current.start,
			before: compactExcerpt(before, 240, "end"),
			after: compactExcerpt(after, 240, "start"),
		});
	}
	if (!candidates.length) return [];

	const selected = new Set<string>();
	for (let offset = 0; offset < candidates.length; offset += 36) {
		throwIfAborted(options.signal);
		const batch = candidates.slice(offset, offset + 36);
		const prompt = [
			"You identify topic, scene, speaker-purpose, or major time-step transitions in an English learning transcript.",
			"Choose a boundary only when the AFTER passage clearly begins a new subject, scene, argument, or narrative step.",
			"Do not choose ordinary sentence continuation, examples, or minor elaboration. Be conservative.",
			'Output strict JSON only: {"boundaryIds":["b00012"]}. Use only ids provided below.',
			"",
			...batch.map((candidate) => [
				`ID ${candidate.id}`,
				`BEFORE: ${candidate.before}`,
				`AFTER: ${candidate.after}`,
			].join("\n")),
		].join("\n\n");
		const response = await runTextPrompt(prompt, options.settings, options.provider, options.signal);
		for (const id of parseTopicBoundaryIds(response.content)) {
			if (batch.some((candidate) => candidate.id === id)) selected.add(id);
		}
	}
	return candidates.filter((candidate) => selected.has(candidate.id)).map((candidate) => candidate.start);
}

export function buildStoryParagraphs(segments: YoutubeCaptionSegment[], options: StoryParagraphOptions = {}): YoutubeParagraph[] {
	if (!segments.length) return [];
	const positiveGaps = segments.slice(1)
		.map((segment, index) => segment.start - (segments[index].start + segments[index].duration))
		.filter((gap) => gap > 0.15)
		.sort((a, b) => a - b);
	const typicalGap = positiveGaps[Math.floor(positiveGaps.length * 0.7)] ?? 0.8;
	const pauseThreshold = options.pauseSeconds ?? clamp(typicalGap * 2.5, 1.8, 5.5);
	const aiTopicStarts = new Set((options.topicBoundaryStarts ?? []).map((start) => Math.round(start * 100)));
	const paragraphs: YoutubeParagraph[] = [];
	let current: YoutubeCaptionSegment[] = [];

	const flush = (): void => {
		if (!current.length) return;
		const start = current[0].start;
		const end = Math.max(...current.map((segment) => segment.start + segment.duration));
		const text = current.map((segment) => segment.text).join(" ").replace(/\s+/g, " ").trim();
		if (text) {
			const id = `yt-p${String(paragraphs.length + 1).padStart(4, "0")}`;
			paragraphs.push({ id, text, sourceHash: sourceHash(text), start, duration: Math.max(0.5, end - start) });
		}
		current = [];
	};

	for (const segment of segments) {
		if (!current.length) { current.push(segment); continue; }
		const previous = current[current.length - 1];
		const gap = segment.start - (previous.start + previous.duration);
		const text = current.map((item) => item.text).join(" ");
		const duration = previous.start + previous.duration - current[0].start;
		const aiTopicShift = aiTopicStarts.has(Math.round(segment.start * 100));
		const sentenceEnded = /[.!?]["'’”)]?$/.test(previous.text.trim());
		const topicShift = options.topicTransitions !== false
			&& text.length >= 120
			&& (aiTopicShift || looksLikeTopicShift(segment.text));
		// Prefer a completed sentence as the paragraph boundary. The old hard
		// character limit could cut a spoken sentence in half, especially when a
		// caption track omitted punctuation. A conservative hard ceiling remains
		// for malformed/Whisper captions that contain one very long unpunctuated
		// segment, but normal YouTube text now stays sentence-aligned.
		const completeThought = sentenceEnded && text.length >= 260;
		const lengthBoundary = text.length >= 560 && sentenceEnded;
		const hardCeiling = text.length >= 820 && (sentenceEnded || gap >= pauseThreshold);
		if (gap >= pauseThreshold || topicShift || completeThought || lengthBoundary || hardCeiling || duration >= 55) flush();
		current.push(segment);
	}
	flush();
	return paragraphs;
}

export function renderYoutubeStoryMarkdown(
	transcript: YoutubeTranscript,
	paragraphs: YoutubeParagraph[],
	translations: Record<string, TranslationPair>,
): string {
	const lines = [
		"---",
		"clp-type: youtube-story",
		`title: ${yamlQuote(transcript.title)}`,
		`youtube-id: ${transcript.videoId}`,
		`source-language: ${yamlQuote(transcript.sourceLanguage)}`,
		"target-language: tr",
		`source-url: ${yamlQuote(`https://www.youtube.com/watch?v=${transcript.videoId}`)}`,
		`created: ${new Date().toISOString()}`,
		"---",
		"",
		`# ${transcript.title}`,
		"",
		`![](https://www.youtube.com/watch?v=${transcript.videoId})`,
		"",
	];
	for (const paragraph of paragraphs) {
		const pair = translations[paragraph.id];
		const translation = pair?.translation ?? "";
		const source = normalizeYoutubeEnglishText(pair?.sourceText ?? paragraph.text);
		lines.push(
			`<div class="clp-youtube-story-pair" data-pair-id="${paragraph.id}" data-source-hash="${paragraph.sourceHash}">`,
			"",
			`[${formatTimestamp(paragraph.start)}](https://www.youtube.com/watch?v=${transcript.videoId}&t=${Math.floor(paragraph.start)}s)`,
			"",
			`<div class="clp-youtube-story-source" lang="en">${escapeHtml(source)}</div>`,
			"",
			`<div class="clp-youtube-story-translation" lang="tr">${escapeHtml(translation)}</div>`,
			"",
			"</div>",
			"",
		);
	}
	return lines.join("\n");
}

/** Package the bilingual transcript as the canonical YouTube output: a small,
 *  standards-compliant EPUB that uses the same reader/ToC/translation controls
 *  as books. The Markdown renderer remains only for legacy notes and tests. */
export async function renderYoutubeStoryEpub(
	transcript: YoutubeTranscript,
	paragraphs: YoutubeParagraph[],
	translations: Record<string, TranslationPair>,
): Promise<Uint8Array> {
	const title = escapeXml(transcript.title || `YouTube ${transcript.videoId}`);
	const bookId = `youtube-${transcript.videoId}`;
	const sourceUrl = `https://www.youtube.com/watch?v=${encodeURIComponent(transcript.videoId)}`;
	const chapterHref = "text/story.xhtml";
	const paragraphMarkup = paragraphs.map((paragraph) => {
		const timestamp = formatTimestamp(paragraph.start);
		const timestampUrl = `${sourceUrl}&t=${Math.floor(paragraph.start)}s`;
		const pair = translations[paragraph.id];
		const translation = pair?.translation ?? "";
		const source = normalizeYoutubeEnglishText(pair?.sourceText ?? paragraph.text);
		return [
			`<div class="clp-bilingual-pair clp-youtube-book-pair" id="${escapeXml(paragraph.id)}">`,
			`<p class="clp-bilingual-source" lang="en"><a class="clp-youtube-timestamp" href="${escapeXml(timestampUrl)}">${escapeXml(timestamp)}</a> ${escapeXml(source)}</p>`,
			`<p class="clp-bilingual-translation" lang="tr">${escapeXml(translation)}</p>`,
			"</div>",
		].join("\n");
	}).join("\n");
	const chapter = `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="en">
<head><title>${title}</title><link rel="stylesheet" type="text/css" href="../styles.css" /></head>
<body>
<h1>${title}</h1>
<p class="clp-youtube-book-source"><a href="${escapeXml(sourceUrl)}">Open this video on YouTube</a></p>
${paragraphMarkup}
</body>
</html>`;
	const nav = `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="en">
<head><title>${title}</title></head>
<body><nav epub:type="toc" id="toc"><h1>Contents</h1><ol><li><a href="${chapterHref}">${title}</a></li></ol></nav></body>
</html>`;
	const opf = `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" unique-identifier="BookId" version="3.0">
<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
<dc:identifier id="BookId">${bookId}</dc:identifier>
<dc:title>${title}</dc:title>
<dc:language>${escapeXml(transcript.sourceLanguage || "en")}</dc:language>
<dc:creator>Comprehensible Learning Portal</dc:creator>
<meta property="dcterms:modified">${new Date().toISOString().replace(/\.\d{3}Z$/, "Z")}</meta>
</metadata>
<manifest>
<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav" />
<item id="story" href="${chapterHref}" media-type="application/xhtml+xml" />
<item id="styles" href="styles.css" media-type="text/css" />
</manifest>
<spine><itemref idref="story" /></spine>
</package>`;
	const container = `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
<rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml" /></rootfiles>
</container>`;
	const css = `.clp-youtube-book-pair{break-inside:avoid}.clp-youtube-timestamp{font-variant-numeric:tabular-nums;text-decoration:none;margin-inline-end:.35em}.clp-youtube-book-source{margin-bottom:2em}`;
	const zip = new JSZip();
	zip.file("mimetype", "application/epub+zip", { compression: "STORE" });
	zip.file("META-INF/container.xml", container);
	zip.file("OEBPS/content.opf", opf);
	zip.file("OEBPS/nav.xhtml", nav);
	zip.file("OEBPS/styles.css", css);
	zip.file(`OEBPS/${chapterHref}`, chapter);
	return zip.generateAsync({ type: "uint8array", mimeType: "application/epub+zip", platform: "UNIX" });
}

function extractPlayerResponse(html: string): PlayerResponse | null {
	for (const marker of ["ytInitialPlayerResponse =", "var ytInitialPlayerResponse =", '"playerResponse":']) {
		const markerIndex = html.indexOf(marker);
		if (markerIndex < 0) continue;
		const start = html.indexOf("{", markerIndex + marker.length);
		if (start < 0) continue;
		const json = balancedJsonObject(html, start);
		if (!json) continue;
		try {
			const parsed = JSON.parse(json) as PlayerResponse | string;
			const value = typeof parsed === "string" ? JSON.parse(parsed) as PlayerResponse : parsed;
			if (value.videoDetails || value.captions) return value;
		} catch { /* try next marker */ }
	}
	return null;
}

function balancedJsonObject(text: string, start: number): string | null {
	let depth = 0;
	let quoted = false;
	let escaped = false;
	for (let index = start; index < text.length; index++) {
		const char = text[index];
		if (quoted) {
			if (escaped) escaped = false;
			else if (char === "\\") escaped = true;
			else if (char === '"') quoted = false;
			continue;
		}
		if (char === '"') quoted = true;
		else if (char === "{") depth++;
		else if (char === "}" && --depth === 0) return text.slice(start, index + 1);
	}
	return null;
}

function selectCaptionTrack(
	tracks: CaptionTrack[],
	preferredLanguage: string,
	preference: CaptionPreference,
): CaptionTrack | undefined {
	const target = preferredLanguage.toLowerCase();
	const base = target.split("-")[0];
	const languageMatches = (track: CaptionTrack): boolean => {
		const language = track.languageCode?.toLowerCase() ?? "";
		return language === target || language === base || language.startsWith(base + "-");
	};
	const preferredKind = preference === "automatic-first"
		? tracks.find((track) => languageMatches(track) && track.kind === "asr")
		: tracks.find((track) => languageMatches(track) && track.kind !== "asr");
	const otherKind = preference === "automatic-first"
		? tracks.find((track) => languageMatches(track) && track.kind !== "asr")
		: tracks.find((track) => languageMatches(track) && track.kind === "asr");
	return preferredKind ?? otherKind ?? tracks.find((track) => track.kind !== "asr") ?? tracks[0];
}

export async function fetchYoutubeTranscriptWithYtDlp(
	rawUrl: string,
	preferredLanguage: string,
	configuredCommand = "",
): Promise<YoutubeTranscript> {
	if (!Platform.isDesktopApp) throw new Error("yt-dlp altyazı fallback'i yalnızca masaüstünde çalışır.");
	const videoId = parseYoutubeVideoId(rawUrl);
	if (!videoId) throw new Error("YouTube video kimliği okunamadı.");
	/* eslint-disable @typescript-eslint/no-require-imports -- Desktop fallback lazily loads Node modules. */
	const childProcess = require("child_process") as typeof import("child_process");
	const fs = require("fs") as typeof import("fs");
	const fsp = require("fs/promises") as typeof import("fs/promises");
	const os = require("os") as typeof import("os");
	const path = require("path") as typeof import("path");
	/* eslint-enable @typescript-eslint/no-require-imports -- End desktop-only fallback imports. */
	const command = resolveToolCommand(configuredCommand, "yt-dlp", fs, os, path);
	const env = localToolEnvironment(os, path);
	const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "clp-youtube-"));
	const output = path.join(tempDir, "caption.%(ext)s");
	try {
		const baseLanguage = preferredLanguage.toLowerCase().split("-")[0];
		const subtitleLanguages = [
			`${preferredLanguage}.*`,
			preferredLanguage,
			`${baseLanguage}-orig`,
			`${baseLanguage}.*`,
			baseLanguage,
		].filter((language, index, all) => all.indexOf(language) === index).join(",");
		const result = await runTool(childProcess, command, [
			"--skip-download", "--no-simulate", "--no-playlist", "--write-subs", "--write-auto-subs",
			"--sub-langs", subtitleLanguages,
			"--sub-format", "json3", "--print", "%(title)s", "-o", output, rawUrl,
		], 120000, undefined, env);
		if (result.code !== 0) throw new Error(lastLines(result.stderr || result.stdout));
		const files = await fsp.readdir(tempDir);
		const captionFile = files.find((name) => name.endsWith(".json3"));
		if (!captionFile) throw new Error("yt-dlp erişilebilir bir altyazı dosyası bulamadı.");
		const segments = parseYoutubeJson3Captions(await fsp.readFile(path.join(tempDir, captionFile), "utf8"));
		return {
			videoId,
			title: result.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)[0] || `YouTube ${videoId}`,
			sourceLanguage: preferredLanguage,
			segments,
		};
	} finally {
		await fsp.rm(tempDir, { recursive: true, force: true });
	}
}

export interface WhisperFallbackOptions {
	ytDlpCommand?: string;
	ffmpegCommand?: string;
	whisperCommand?: string;
	whisperModel?: string;
	signal?: AbortSignal;
	/** Optional acceptance/diagnostic limit; production imports leave this unset. */
	maxDurationSeconds?: number;
}

/** Desktop-only, explicitly consent-gated no-caption fallback. Temporary audio
 * is downloaded, converted to mono 16 kHz WAV, transcribed locally, and always
 * deleted in finally. Supports both OpenAI's Python `whisper` CLI and
 * whisper.cpp's `whisper-cli`. */
export async function fetchYoutubeTranscriptWithWhisper(
	rawUrl: string,
	preferredLanguage: string,
	options: WhisperFallbackOptions = {},
): Promise<YoutubeTranscript> {
	if (!Platform.isDesktopApp) throw new Error("Whisper fallback'i yalnızca masaüstünde çalışır.");
	const videoId = parseYoutubeVideoId(rawUrl);
	if (!videoId) throw new Error("YouTube video kimliği okunamadı.");
	/* eslint-disable @typescript-eslint/no-require-imports -- Desktop-only, consent-gated audio pipeline. */
	const childProcess = require("child_process") as typeof import("child_process");
	const fs = require("fs") as typeof import("fs");
	const fsp = require("fs/promises") as typeof import("fs/promises");
	const os = require("os") as typeof import("os");
	const path = require("path") as typeof import("path");
	/* eslint-enable @typescript-eslint/no-require-imports -- End local Whisper pipeline imports. */
	const ytDlp = resolveToolCommand(options.ytDlpCommand ?? "", "yt-dlp", fs, os, path);
	const ffmpeg = resolveToolCommand(options.ffmpegCommand ?? "", "ffmpeg", fs, os, path);
	const whisper = resolveToolCommand(options.whisperCommand ?? "", "whisper", fs, os, path);
	const env = localToolEnvironment(os, path);
	const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "clp-whisper-"));
	const audioPattern = path.join(tempDir, "source.%(ext)s");
	const wavPath = path.join(tempDir, "audio.wav");
	try {
		throwIfAborted(options.signal);
		const baseDownloadArgs = [
			"--no-playlist", "--no-simulate", "-f", "bestaudio/best", "--print", "%(title)s", "-o", audioPattern, rawUrl,
		];
		let download = await runTool(childProcess, ytDlp, baseDownloadArgs, 15 * 60 * 1000, options.signal, env);
		if (download.code !== 0) {
			// YouTube's current default client can return GVS 403 without a PO
			// token. The public embedded client remains a no-cookie fallback for
			// many videos; retry it automatically before asking the learner to
			// troubleshoot yt-dlp authentication.
			for (const name of await fsp.readdir(tempDir)) {
				if (name.endsWith(".part") || name.startsWith("source.")) {
					await fsp.rm(path.join(tempDir, name), { force: true });
				}
			}
			download = await runTool(childProcess, ytDlp, [
				"--extractor-args", "youtube:player_client=web_embedded",
				...baseDownloadArgs,
			], 15 * 60 * 1000, options.signal, env);
		}
		if (download.code !== 0) throw new Error(`Ses indirilemedi: ${lastLines(download.stderr || download.stdout)}`);
		const audioFile = (await fsp.readdir(tempDir))
			.map((name) => path.join(tempDir, name))
			.find((candidate) => candidate !== wavPath && !candidate.endsWith(".part"));
		if (!audioFile) throw new Error("yt-dlp geçici ses dosyası oluşturmadı.");
		const conversionArgs = [
			"-hide_banner", "-loglevel", "error", "-y", "-i", audioFile,
		];
		if ((options.maxDurationSeconds ?? 0) > 0) {
			conversionArgs.push("-t", String(Math.max(1, options.maxDurationSeconds!)));
		}
		conversionArgs.push("-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", wavPath);
		const converted = await runTool(childProcess, ffmpeg, conversionArgs, 10 * 60 * 1000, options.signal, env);
		if (converted.code !== 0) throw new Error(`Ses dönüştürülemedi: ${lastLines(converted.stderr || converted.stdout)}`);

		const commandName = path.basename(whisper).toLowerCase();
		const cpp = commandName.includes("whisper-cli") || commandName === "main" || commandName === "whisper.cpp";
		let jsonPath: string;
		if (cpp) {
			const modelPath = resolveWhisperModel(options.whisperModel ?? "base.en", fs, os, path);
			if (!modelPath) {
				throw new Error("whisper.cpp için ayarlarda geçerli bir model dosyası seçilmelidir.");
			}
			const outputBase = path.join(tempDir, "transcript");
			const whisperArgs = [
				"-m", modelPath, "-f", wavPath, "-l", preferredLanguage, "-oj", "-of", outputBase,
			];
			let transcribed = await runTool(childProcess, whisper, whisperArgs, 60 * 60 * 1000, options.signal, env);
			if (transcribed.code !== 0) {
				// Metal can fail to allocate a buffer on otherwise supported Macs.
				// Retry the exact WAV/model on CPU before surfacing an error.
				transcribed = await runTool(
					childProcess,
					whisper,
					[...whisperArgs, "-ng"],
					60 * 60 * 1000,
					options.signal,
					env,
				);
			}
			if (transcribed.code !== 0) throw new Error(`Whisper başarısız: ${lastLines(transcribed.stderr || transcribed.stdout)}`);
			jsonPath = `${outputBase}.json`;
		} else {
			const model = (options.whisperModel ?? "base.en").trim() || "base.en";
			const transcribed = await runTool(childProcess, whisper, [
				wavPath, "--language", preferredLanguage, "--model", model,
				"--output_format", "json", "--output_dir", tempDir,
			], 60 * 60 * 1000, options.signal, env);
			if (transcribed.code !== 0) throw new Error(`Whisper başarısız: ${lastLines(transcribed.stderr || transcribed.stdout)}`);
			jsonPath = path.join(tempDir, "audio.json");
		}
		const segments = parseWhisperJson(JSON.parse(await fsp.readFile(jsonPath, "utf8")));
		if (!segments.length) throw new Error("Whisper okunabilir segment üretmedi.");
		return {
			videoId,
			title: download.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)[0] || `YouTube ${videoId}`,
			sourceLanguage: preferredLanguage,
			segments,
		};
	} finally {
		await fsp.rm(tempDir, { recursive: true, force: true });
	}
}

export function parseWhisperJson(value: unknown): YoutubeCaptionSegment[] {
	if (!value || typeof value !== "object") return [];
	const parsed = value as {
		segments?: { start?: number; end?: number; text?: string }[];
		transcription?: { offsets?: { from?: number; to?: number }; text?: string }[];
	};
	if (Array.isArray(parsed.segments)) {
		return parsed.segments.map((segment) => {
			const start = Math.max(0, Number(segment.start) || 0);
			const end = Math.max(start, Number(segment.end) || start);
			return {
				start,
				duration: Math.max(0.1, end - start),
				text: (segment.text ?? "").replace(/\s+/g, " ").trim(),
			};
		}).filter((segment) => segment.text.length > 0);
	}
	if (Array.isArray(parsed.transcription)) {
		return parsed.transcription.map((segment) => {
			const start = Math.max(0, (Number(segment.offsets?.from) || 0) / 1000);
			const end = Math.max(start, (Number(segment.offsets?.to) || 0) / 1000);
			return {
				start,
				duration: Math.max(0.1, end - start),
				text: (segment.text ?? "").replace(/\s+/g, " ").trim(),
			};
		}).filter((segment) => segment.text.length > 0);
	}
	return [];
}

export async function captureYoutubeFrame(
	videoId: string,
	time: number,
	ytDlpCommand = "",
	ffmpegCommand = "",
): Promise<ArrayBuffer> {
	if (!Platform.isDesktopApp) throw new Error("Video karesi yakalama yalnızca masaüstünde çalışır.");
	if (!/^[A-Za-z0-9_-]{11}$/.test(videoId)) throw new Error("Geçersiz YouTube video kimliği.");
	/* eslint-disable @typescript-eslint/no-require-imports -- User-triggered desktop screenshot pipeline. */
	const childProcess = require("child_process") as typeof import("child_process");
	const fs = require("fs") as typeof import("fs");
	const fsp = require("fs/promises") as typeof import("fs/promises");
	const os = require("os") as typeof import("os");
	const path = require("path") as typeof import("path");
	/* eslint-enable @typescript-eslint/no-require-imports -- End screenshot pipeline imports. */
	const ytDlp = resolveToolCommand(ytDlpCommand, "yt-dlp", fs, os, path);
	const ffmpeg = resolveToolCommand(ffmpegCommand, "ffmpeg", fs, os, path);
	const env = localToolEnvironment(os, path);
	const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "clp-frame-"));
	const outputPattern = path.join(tempDir, "video.%(ext)s");
	const spritePath = path.join(tempDir, "storyboard.jpg");
	const framePath = path.join(tempDir, "frame.jpg");
	const start = Math.max(0, time - 1);
	try {
		// YouTube increasingly protects direct media streams with short-lived PO
		// tokens. Public storyboard images remain purpose-built for time previews,
		// are tiny, and avoid downloading video merely to save one learning image.
		// Ask yt-dlp for a bounded set of format objects, choose the largest
		// storyboard, then crop the cell nearest to the requested timestamp.
		const metadataArgs = ["--no-playlist", "--skip-download"];
		for (let index = 0; index < 8; index++) metadataArgs.push("--print", `%(formats.${index})j`);
		metadataArgs.push(`https://www.youtube.com/watch?v=${videoId}`);
		const metadata = await runTool(childProcess, ytDlp, metadataArgs, 2 * 60 * 1000, undefined, env);
		if (metadata.code === 0) {
			try {
				const storyboard = selectYoutubeStoryboardFrame(metadata.stdout, time);
				const sprite = await requestUrl({ url: storyboard.url, headers: storyboard.headers, throw: false });
				if (sprite.status >= 200 && sprite.status < 300) {
					await fsp.writeFile(spritePath, new Uint8Array(sprite.arrayBuffer));
					const cropped = await runTool(childProcess, ffmpeg, [
						"-hide_banner", "-loglevel", "error", "-y", "-i", spritePath,
						"-vf", `crop=${storyboard.width}:${storyboard.height}:${storyboard.x}:${storyboard.y}`,
						"-frames:v", "1", "-q:v", "2", framePath,
					], 2 * 60 * 1000, undefined, env);
					if (cropped.code === 0) return fileArrayBuffer(await fsp.readFile(framePath));
				}
			} catch { /* no usable storyboard; fall back to a short media section */ }
		}

		const downloadArgs = [
			"--no-playlist", "--download-sections", `*${start}-${start + 4}`,
			"--force-keyframes-at-cuts", "-f", "best[height<=720][ext=mp4]/best[height<=720]/best",
			"-o", outputPattern,
		];
		downloadArgs.push("--ffmpeg-location", ffmpeg);
		downloadArgs.push(`https://www.youtube.com/watch?v=${videoId}`);
		const downloaded = await runTool(childProcess, ytDlp, downloadArgs, 10 * 60 * 1000, undefined, env);
		if (downloaded.code !== 0) throw new Error(`Video karesi indirilemedi: ${lastLines(downloaded.stderr || downloaded.stdout)}`);
		const media = (await fsp.readdir(tempDir))
			.map((name) => path.join(tempDir, name))
			.find((candidate) => candidate !== framePath && !candidate.endsWith(".part"));
		if (!media) throw new Error("yt-dlp kare için geçici video üretmedi.");
		const captured = await runTool(childProcess, ffmpeg, [
			"-hide_banner", "-loglevel", "error", "-y", "-ss", "1", "-i", media,
			"-frames:v", "1", "-q:v", "2", framePath,
		], 2 * 60 * 1000, undefined, env);
		if (captured.code !== 0) throw new Error(`Video karesi üretilemedi: ${lastLines(captured.stderr || captured.stdout)}`);
		return fileArrayBuffer(await fsp.readFile(framePath));
	} finally {
		await fsp.rm(tempDir, { recursive: true, force: true });
	}
}

interface StoryboardFormat {
	format_note?: string;
	width?: number;
	height?: number;
	fps?: number;
	rows?: number;
	columns?: number;
	fragments?: { url?: string; duration?: number }[];
	http_headers?: Record<string, string>;
}

export interface YoutubeStoryboardFrame {
	url: string;
	headers: Record<string, string>;
	width: number;
	height: number;
	x: number;
	y: number;
}

export function selectYoutubeStoryboardFrame(rawFormats: string, time: number): YoutubeStoryboardFrame {
	const formats: StoryboardFormat[] = [];
	for (const line of rawFormats.split(/\r?\n/).map((value) => value.trim()).filter(Boolean)) {
		try {
			const value = JSON.parse(line) as StoryboardFormat;
			if (value.format_note === "storyboard" && value.fragments?.length) formats.push(value);
		} catch { /* yt-dlp can interleave a warning; ignore non-JSON lines */ }
	}
	const format = formats
		.filter((value) => (value.width ?? 0) > 0 && (value.height ?? 0) > 0
			&& (value.rows ?? 0) > 0 && (value.columns ?? 0) > 0 && (value.fps ?? 0) > 0)
		.sort((left, right) => (right.width ?? 0) - (left.width ?? 0))[0];
	if (!format?.fragments?.length) throw new Error("Video için storyboard karesi bulunamadı.");
	const rows = format.rows!;
	const columns = format.columns!;
	const framesPerSprite = rows * columns;
	const globalFrame = Math.max(0, Math.floor(Math.max(0, time) * format.fps!));
	const fragmentIndex = Math.min(format.fragments.length - 1, Math.floor(globalFrame / framesPerSprite));
	const cell = globalFrame % framesPerSprite;
	const fragment = format.fragments[fragmentIndex];
	if (!fragment?.url) throw new Error("Storyboard görsel adresi bulunamadı.");
	return {
		url: fragment.url,
		headers: format.http_headers ?? {},
		width: format.width!,
		height: format.height!,
		x: (cell % columns) * format.width!,
		y: Math.floor(cell / columns) * format.height!,
	};
}

function fileArrayBuffer(bytes: Buffer): ArrayBuffer {
	return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

export async function probeLocalTool(
	kind: "yt-dlp" | "ffmpeg" | "whisper",
	configuredCommand = "",
): Promise<{ available: boolean; detail: string }> {
	if (!Platform.isDesktopApp) return { available: false, detail: `${kind} yalnızca masaüstünde sınanabilir.` };
	/* eslint-disable @typescript-eslint/no-require-imports -- Diagnostics lazily load desktop-only Node modules. */
	const childProcess = require("child_process") as typeof import("child_process");
	const fs = require("fs") as typeof import("fs");
	const os = require("os") as typeof import("os");
	const path = require("path") as typeof import("path");
	/* eslint-enable @typescript-eslint/no-require-imports -- End desktop-only diagnostic imports. */
	const command = resolveToolCommand(configuredCommand, kind, fs, os, path);
	try {
		const versionArgs = kind === "whisper" ? ["--help"] : kind === "ffmpeg" ? ["-version"] : ["--version"];
		const result = await runTool(
			childProcess,
			command,
			versionArgs,
			10000,
			undefined,
			localToolEnvironment(os, path),
		);
		return { available: result.code === 0, detail: (result.stdout || result.stderr).split(/\r?\n/)[0].trim() || command };
	} catch (error) {
		return { available: false, detail: error instanceof Error ? error.message : String(error) };
	}
}

export async function probeWhisperSetup(
	configuredCommand = "",
	configuredModel = "base.en",
): Promise<{ available: boolean; detail: string }> {
	const commandProbe = await probeLocalTool("whisper", configuredCommand);
	if (!commandProbe.available || !Platform.isDesktopApp) return commandProbe;
	/* eslint-disable @typescript-eslint/no-require-imports -- Desktop-only model diagnostic. */
	const fs = require("fs") as typeof import("fs");
	const os = require("os") as typeof import("os");
	const path = require("path") as typeof import("path");
	/* eslint-enable @typescript-eslint/no-require-imports -- End desktop-only model diagnostic. */
	const command = resolveToolCommand(configuredCommand, "whisper", fs, os, path);
	const commandName = path.basename(command).toLowerCase();
	const cpp = commandName.includes("whisper-cli") || commandName === "main" || commandName === "whisper.cpp";
	if (!cpp) return commandProbe;
	const model = resolveWhisperModel(configuredModel, fs, os, path);
	return model
		? { available: true, detail: `${commandProbe.detail} · model ${model}` }
		: { available: false, detail: `${commandProbe.detail} · whisper.cpp modeli bulunamadı` };
}

export function resolveWhisperModel(
	configured: string,
	fs: typeof import("fs"),
	os: typeof import("os"),
	path: typeof import("path"),
): string | null {
	const value = configured.trim() || "base.en";
	if (fs.existsSync(value)) return value;
	const fileName = value.endsWith(".bin")
		? value
		: `ggml-${value.replace(/^ggml-/, "")}.bin`;
	const home = os.homedir();
	const candidates = [
		path.join(home, "Library", "Application Support", "Comprehensible Learning Portal", "Models", fileName),
		path.join(home, ".cache", "whisper", fileName),
		path.join(home, ".local", "share", "whisper.cpp", "models", fileName),
		path.join("/opt/homebrew/share/whisper-cpp/models", fileName),
		path.join("/usr/local/share/whisper-cpp/models", fileName),
	];
	return candidates.find((candidate) => fs.existsSync(candidate)) ?? null;
}

export function resolveToolCommand(
	configured: string,
	kind: "yt-dlp" | "ffmpeg" | "whisper",
	fs: typeof import("fs"),
	os: typeof import("os"),
	path: typeof import("path"),
): string {
	if (configured.trim()) return configured.trim();
	const executable = process.platform === "win32" ? `${kind}.exe` : kind;
	const home = os.homedir();
	const candidates = process.platform === "win32"
		? [executable, kind]
		: kind === "whisper"
			? [
				path.join(home, ".local", "bin", "whisper"),
				path.join(home, ".local", "bin", "whisper-cli"),
				"/opt/homebrew/bin/whisper", "/usr/local/bin/whisper",
				"/opt/homebrew/bin/whisper-cli", "/usr/local/bin/whisper-cli",
				"whisper", "whisper-cli",
			]
			: [
				path.join(home, ".local", "bin", kind),
				`/opt/homebrew/bin/${kind}`, `/usr/local/bin/${kind}`, `/usr/bin/${kind}`, kind,
			];
	return candidates.find((candidate) => !candidate.includes(path.sep) || fs.existsSync(candidate)) ?? executable;
}

function localToolEnvironment(
	os: typeof import("os"),
	path: typeof import("path"),
): NodeJS.ProcessEnv {
	const extra = process.platform === "win32" ? [] : [
		path.join(os.homedir(), ".local", "bin"),
		path.join(os.homedir(), ".cargo", "bin"),
		"/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin",
	];
	const existing = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
	return {
		...process.env,
		PATH: [...extra, ...existing].filter((value, index, all) => all.indexOf(value) === index).join(path.delimiter),
	};
}

function runTool(
	childProcess: typeof import("child_process"),
	command: string,
	args: string[],
	timeoutMs: number,
	signal?: AbortSignal,
	env: NodeJS.ProcessEnv = process.env,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
	return new Promise((resolve, reject) => {
		const shell = process.platform === "win32" && (/\.(cmd|bat)$/i.test(command) || !/[\\/]/.test(command));
		const child = childProcess.spawn(command, args, { env, shell, windowsHide: true });
		let stdout = "";
		let stderr = "";
		let timedOut = false;
		const timer = setTimeout(() => { timedOut = true; child.kill("SIGTERM"); }, timeoutMs);
		const abort = (): void => { child.kill("SIGTERM"); };
		signal?.addEventListener("abort", abort, { once: true });
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => { stdout += chunk; });
		child.stderr.on("data", (chunk: string) => { stderr += chunk; });
		child.on("error", (error) => { clearTimeout(timer); signal?.removeEventListener("abort", abort); reject(error); });
		child.on("close", (code) => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", abort);
			if (signal?.aborted) { reject(new DOMException("Durduruldu", "AbortError")); return; }
			if (timedOut) reject(new Error(`${command} zaman aşımına uğradı.`));
			else resolve({ code, stdout, stderr });
		});
	});
}

function throwIfAborted(signal?: AbortSignal): void {
	if (signal?.aborted) throw new DOMException("Durduruldu", "AbortError");
}

function lastLines(text: string): string {
	return text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).slice(-4).join(" ") || "yt-dlp bilinmeyen bir hata verdi.";
}

export function parseYoutubeJson3Captions(raw: string): YoutubeCaptionSegment[] {
	let parsed: { events?: Json3Event[] };
	try { parsed = JSON.parse(raw) as { events?: Json3Event[] }; }
	catch { throw new Error("YouTube desteklenmeyen bir altyazı biçimi döndürdü."); }
	const source = (parsed.events ?? [])
		.filter((event) => event.aAppend !== 1 && event.segs?.length)
		.map((event) => ({
			start: Math.max(0, (event.tStartMs ?? 0) / 1000),
			duration: Math.max(0.1, (event.dDurationMs ?? 0) / 1000),
			text: cleanCaption(event.segs?.map((segment) => segment.utf8 ?? "").join("") ?? ""),
		}))
		.filter((segment) => segment.text.length > 0)
		.filter((segment, index, all) => index === 0 || segment.text !== all[index - 1].text || Math.abs(segment.start - all[index - 1].start) > 0.25);

	const combined: YoutubeCaptionSegment[] = [];
	let current: YoutubeCaptionSegment | null = null;
	for (const segment of source) {
		if (!current) { current = { ...segment }; continue; }
		const currentEnd = current.start + current.duration;
		const gap = segment.start - currentEnd;
		if (/[.!?]["'’”)]?$/.test(current.text) || current.text.length >= 180 || current.duration >= 14 || gap > 2.2) {
			combined.push(current);
			current = { ...segment };
			continue;
		}
		current.text = joinCaptionText(current.text, segment.text);
		current.duration = Math.max(currentEnd, segment.start + segment.duration) - current.start;
	}
	if (current) combined.push(current);
	return combined;
}

function cleanCaption(text: string): string {
	return text
		.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
		.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/<[^>]+>/g, "")
		.replace(/\s+/g, " ").trim();
}

function joinCaptionText(left: string, right: string): string {
	if (!left) return right;
	if (!right) return left;
	if (left.endsWith("-") && /^[a-z]/.test(right)) return left.slice(0, -1) + right;
	if (/^[,.;:!?，。！？；：'’]/.test(right)) return left + right;
	return `${left} ${right}`;
}

function compactExcerpt(text: string, limit: number, side: "start" | "end"): string {
	const compact = text.replace(/\s+/g, " ").trim();
	if (compact.length <= limit) return compact;
	return side === "start" ? `${compact.slice(0, limit).trimEnd()}…` : `…${compact.slice(-limit).trimStart()}`;
}

function parseTopicBoundaryIds(raw: string): string[] {
	const start = raw.indexOf("{");
	const end = raw.lastIndexOf("}");
	if (start < 0 || end <= start) throw new Error("AI konu sınırlarını JSON biçiminde döndürmedi.");
	let parsed: unknown;
	try { parsed = JSON.parse(raw.slice(start, end + 1)); }
	catch { throw new Error("AI konu sınırı JSON'u okunamadı."); }
	if (!parsed || typeof parsed !== "object" || !Array.isArray((parsed as { boundaryIds?: unknown }).boundaryIds)) {
		throw new Error("AI konu sınırı yanıtında boundaryIds dizisi yok.");
	}
	return (parsed as { boundaryIds: unknown[] }).boundaryIds
		.filter((id): id is string => typeof id === "string" && /^b\d{5}$/.test(id));
}

function looksLikeTopicShift(text: string): boolean {
	return /^(however|meanwhile|later|afterward|next|now|on the other hand|in contrast|eventually|the next (?:day|morning|week)|but then)\b/i.test(text.trim());
}

function formatTimestamp(seconds: number): string {
	const total = Math.max(0, Math.floor(seconds));
	const hours = Math.floor(total / 3600);
	const minutes = Math.floor((total % 3600) / 60);
	const remainder = total % 60;
	return hours > 0
		? `${hours}:${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`
		: `${minutes}:${String(remainder).padStart(2, "0")}`;
}

function yamlQuote(text: string): string { return JSON.stringify(text); }
function escapeXml(text: string): string {
	return text
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&apos;");
}
function escapeHtml(text: string): string {
	return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
function clamp(value: number, min: number, max: number): number { return Math.min(max, Math.max(min, value)); }
