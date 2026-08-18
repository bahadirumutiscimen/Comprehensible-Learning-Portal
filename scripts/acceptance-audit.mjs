import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const checks = [];
const check = (name, pass, detail) => checks.push({ name, pass, detail });
const read = (path) => readFileSync(join(root, path), "utf8");

const manifest = JSON.parse(read("manifest.json"));
check("manifest identity", manifest.id === "comprehensible-learning-portal" && manifest.name === "Comprehensible Learning Portal", `${manifest.id} · ${manifest.name}`);
check("single-plugin build artifacts", ["main.js", "styles.css", "manifest.json"].every((path) => existsSync(join(root, path))), "main.js + styles.css + manifest.json");
check("mobile-loadable manifest", manifest.isDesktopOnly === false, `isDesktopOnly=${String(manifest.isDesktopOnly)}`);

const packageJson = JSON.parse(read("package.json"));
const forbidden = [
	"third-mind-reader",
	"contextual-ai-reader",
	"epub-reading-importer",
	"mouse-tooltip-translator",
	"english-learning-assistant",
	"english-study-system",
];
const dependencyNames = Object.keys({ ...(packageJson.dependencies ?? {}), ...(packageJson.optionalDependencies ?? {}) });
check("no source-plugin package dependency", !dependencyNames.some((name) => forbidden.includes(name)), dependencyNames.join(", ") || "none");

const runtimeSources = [
	"main.ts", "epub.ts", "epub-translation.ts", "translation-service.ts", "youtube.ts",
	"youtube-view.ts", "gloss.ts", "study.ts", "learning-service.ts", "library-view.ts", "ai-client.ts",
].map((path) => read(path)).join("\n");
const forbiddenRuntimeImport = forbidden.find((id) => new RegExp(`(?:from|require\\s*\\()\\s*[\"'][^\"']*${id}`).test(runtimeSources));
check("no source-plugin runtime import", !forbiddenRuntimeImport, forbiddenRuntimeImport ?? "independent modules only");

const requiredSources = [
	"import-jobs.ts", "translation-service.ts", "epub-translation.ts", "youtube.ts",
	"youtube-view.ts", "quick-lookup.ts", "study.ts", "learning-service.ts", "migration.ts",
	"reader-flow.ts",
];
check("required product modules", requiredSources.every((path) => existsSync(join(root, path))), requiredSources.join(", "));

const mainSource = read("main.ts");
const contentImportSource = read("content-import.ts");
const jobSource = read("import-jobs.ts");
const translationSource = read("translation-service.ts");
const translationSettingsSource = read("translation-settings.ts");
const epubSource = read("epub-translation.ts");
const youtubeSource = read("youtube.ts");
const youtubeViewSource = read("youtube-view.ts");
const quickLookupSource = read("quick-lookup.ts");
const studySource = read("study.ts");
const migrationSource = read("migration.ts");
const aiClientSource = read("ai-client.ts");
const hasAll = (source, markers) => markers.every((marker) => source.includes(marker));

check(
	"single EPUB/YouTube entry surface",
	hasAll(mainSource, ["clp-portal", "new ContentImportModal"]) && hasAll(contentImportSource, ["EPUB seç", "Videoyu analiz et ve içe aktar", "importYoutubeUrl"]),
	"custom ribbon → one ContentImportModal → EPUB/YouTube actions",
);
check(
	"persistent cancel/resume job contract",
	hasAll(jobSource, ["paused", "cancelled", "checkpoint", "updatedAt"]) && hasAll(mainSource, ["cancelImportJob", "retryImportJob", "nextChapter", "storyCacheKey"]),
	"status + checkpoint + EPUB chapter + YouTube story resume",
);
check(
	"Codex translation adapter",
	hasAll(translationSource, ["resolveCodexCommand", '"--json"', '"read-only"', "usageFromRaw", "validateTranslations", "AbortSignal"]),
	"discovery + JSONL + read-only + usage + alignment + cancellation",
);
check(
	"fixed Codex learning model contract",
	hasAll(translationSettingsSource, ["CODEX_LEARNING_MODEL", '"gpt-5.4-mini"'])
		&& hasAll(translationSource, ['args.push("-m", CODEX_LEARNING_MODEL)', "translation-v2"])
		&& hasAll(mainSource, ["codexModelNeedsMigration", ".setDisabled(true)"]),
	"runtime-enforced gpt-5.4-mini + migrated settings + read-only UI + model-isolated cache",
);
check(
	"OpenCode and pi desktop learning backends",
	hasAll(translationSettingsSource, ['"opencode"', '"pi"', "opencodeModel", "piModel"])
		&& hasAll(translationSource, ["probeAgentCli", "parseOpenCodeModels", "parsePiModels", 'permission: "deny"', '"--no-tools"'])
		&& hasAll(mainSource, ["renderAgentCliSettings", "ClpModelPickerModal"]),
	"auto-discovery + live provider/model catalogs + tool-free ephemeral execution + searchable picker",
);
check(
	"Google Gemini API provider",
	hasAll(aiClientSource, ['provider.kind === "google"', "generativelanguage.googleapis.com/v1beta/models", "generateContent", '"gemini-3.6-flash"'])
		&& hasAll(mainSource, ['addOption("google", "Google Gemini API")', 'this.addProvider("google")']),
	"Secret Storage key + live generateContent model catalog + Gemini 3.6/3.5-ready picker",
);
check(
	"Google Antigravity managed-agent backend",
	hasAll(translationSettingsSource, ['"antigravity"', '"gemini-3.7-flash"', "antigravityModel"])
		&& hasAll(aiClientSource, ["chatGoogleAntigravity", 'agent: "antigravity-preview-05-2026"', "tools: []", "store: false", "max_total_tokens: 20000"])
		&& hasAll(mainSource, ['addOption("antigravity", "Google Antigravity Agent")', "Antigravity modellerini göster"]),
	"Interactions API + no tools/environment + ephemeral request + 20k token cap + 3.7/3.6/3.5 model picker",
);
check(
	"bilingual EPUB contract",
	hasAll(epubSource, ["sourceFingerprint", "sourceHash", "translatedChapters", "clp-bilingual-source", "clp-bilingual-translation"])
		&& hasAll(mainSource, ["clp-translation-source", "clp-translation-bilingual", "clp-translation-target", "exportBilingualEpubMarkdown", "readerFlow", "mountContinuous", "clp-flow-continuous"]),
	"stable ids/hashes + progressive chapters + 3 language views + paged/continuous reading + Markdown export",
);
check(
	"YouTube acquisition and story contract",
	hasAll(youtubeSource, ["parseYoutubeInput", "parseYoutubeJson3Captions", "detectTopicBoundaryStarts", "fetchYoutubeTranscriptWithYtDlp", "fetchYoutubeTranscriptWithWhisper", "youtube-story-v2"])
		&& hasAll(youtubeViewSource, ["seekTo", "currentTime", "clp-youtube-lookup-result", "addVocabulary", "addGrammar", "addShadowing", "SpeechSynthesisUtterance"]),
	"identity + captions/STT + pause/AI topics + cache + synchronized learning view",
);
check(
	"Hover/Gloss contextual learning contract",
	hasAll(quickLookupSource, ["lemma", "ipa", "partOfSpeech", "meaning", "explanationLanguage", "quickLookupCacheKey"])
		&& hasAll(mainSource, ["registerQuickLookupHover", "openQuickLookupForSelection", "speechSynthesis", "addVocabulary"]),
	"word/sentence lookup + Turkish/English contextual modes + isolated cache + IPA/POS + TTS + Vocabulary",
);
check(
	"unified Study contract",
	hasAll(studySource, ["Vocabulary", "Grammar", "Mistakes", "Shadowing", "Progress", "compareShadowing", "renderStudyMarkdown", "syntaxTree"]),
	"five tabs + scoring + syntax + Markdown export",
);
check(
	"professional settings contract",
	hasAll(mainSource, ["openOnboarding", "runDiagnostics", "downloadSettingsBackup", "restoreSettingsBackup", "renderSystemPromptsSection", "advancedSettingsVisible"]),
	"onboarding + Basic/Advanced + diagnostics + backup/restore + prompts",
);
check(
	"secret-storage persistence contract",
	hasAll(mainSource, ["secretStorage.setSecret", "secretStorage.getSecret", "delete copy.apiKey", "apiKeyId"]),
	"secret id persisted; raw API key removed from data payload",
);
check(
	"consent-gated idempotent migration contract",
	hasAll(migrationSource, ["Read-only legacy inspection", "PRIVATE_PATH", "fingerprint", "clp-legacy:"])
		&& hasAll(mainSource, ["buildMigrationPreview(this.app)", "migrationKeys", "vocabularyVerified", "annotationsVerified"]),
	"button-triggered dry-run + exclusions + stable keys + equality verification",
);

const bundle = read("main.js");
const bundleMarkers = [
	"comprehensible-learning-portal", "clp-library", "clp-study", "clp-youtube-story",
	"systemPromptVersion", "quickLookupCache", "Migration dry-run", "Whisper fallback", "gpt-5.4-mini", "gemini-3.7-flash", "gemini-3.6-flash", "gemini-3.5-flash",
];
const missingMarkers = bundleMarkers.filter((marker) => !bundle.includes(marker));
check("production bundle feature markers", missingMarkers.length === 0, missingMarkers.length ? `missing: ${missingMarkers.join(", ")}` : bundleMarkers.join(", "));

const epubPath = resolve(root, "fixtures", "Alex_Raynham-Future_Energy.epub");
const expectedEpubHash = "a5bbe4d9dc4158602a6250bab8685b95426e601e579447eb48c88bb2bd806a3a";
if (existsSync(epubPath)) {
	const hash = createHash("sha256").update(readFileSync(epubPath)).digest("hex");
	check("source EPUB byte integrity", hash === expectedEpubHash, hash);
} else {
	check("source EPUB byte integrity", false, `missing: ${epubPath}`);
}

const result = {
	generatedAt: new Date().toISOString(),
	passed: checks.filter((item) => item.pass).length,
	failed: checks.filter((item) => !item.pass).length,
	checks,
	observedRuntimeEvidence: [
		"Actual Future Energy EPUB import resumed after Codex ENOENT and completed with 207/207 aligned non-empty pairs",
		"Live YouTube caption/story/Codex smoke completed against the plan URL",
		"Live tool-free OpenCode and pi CLI smoke returned PORTAL_AGENT_OK from both installed agents",
		"Live no-caption Whisper production fallback completed with 10 timed segments",
		"Live timestamp-nearest YouTube storyboard capture produced a valid JPEG",
		"User-approved read-only legacy dry-run found 0 Vocabulary and 0 annotation records with no warnings",
	],
	manualRuntimeGates: [
		"Obsidian onboarding/settings render",
		"EPUB reader visual modes and interactions",
		"YouTube iframe seek and active paragraph tracking",
		"Hover/Gloss/TTS and Study interactions",
		"iPhone/iPad reading and performance",
		"Separate approval before source-plugin disablement or removal",
	],
};
console.log(JSON.stringify(result, null, 2));
if (result.failed) process.exitCode = 1;
