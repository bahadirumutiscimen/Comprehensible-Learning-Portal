import assert from "node:assert/strict";
import { build } from "esbuild";
import { posix, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));

async function loadModule(entry, obsidianOverride) {
	const result = await build({
		entryPoints: [resolve(root, entry)],
		bundle: true,
		format: "esm",
		platform: "node",
		write: false,
		plugins: [{
			name: "obsidian-test-shim",
			setup(api) {
			api.onResolve({ filter: /^obsidian$/ }, () => ({ path: "obsidian", namespace: "test-shim" }));
			api.onLoad({ filter: /.*/, namespace: "test-shim" }, () => ({
					contents: obsidianOverride ?? [
						"export class App {}",
						"export class FileSystemAdapter {}",
						"export class ItemView {}",
						"export class Notice {}",
						"export class WorkspaceLeaf {}",
						"export const Platform={isDesktopApp:false,isMobileApp:false};",
						"export async function requestUrl(){throw new Error('network is not available in pure tests')}",
						"export function setIcon(){}",
					].join("\n"),
					loader: "js",
				}));
			},
		}],
	});
	const moduleUrl = `data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`;
	return import(moduleUrl);
}

const jobs = await loadModule("import-jobs.ts");
const job = jobs.createImportJob("epub", "Library/Books/Test.epub", "Test");
assert.equal(job.status, "queued");
assert.equal(job.stage, "validating");
assert.deepEqual(job.checkpoint, {});
const running = jobs.patchImportJob(job, {
	status: "running",
	stage: "translating",
	completed: 4,
	total: 10,
	checkpoint: { sourceFingerprint: "abc", nextChapter: 2 },
});
assert.equal(running.id, job.id);
assert.equal(running.checkpoint.nextChapter, 2);
assert.equal(running.status, "running");
assert.ok(running.updatedAt >= job.updatedAt);
assert.equal(jobs.canStartImportJob(job), true);
assert.equal(jobs.canStartImportJob(jobs.patchImportJob(job, { status: "cancelled" })), false);

const translation = await loadModule("translation-service.ts");
const translationSettingsModule = await loadModule("translation-settings.ts");
assert.equal(translationSettingsModule.CODEX_LEARNING_MODEL, "gpt-5.4-mini");
assert.equal(translationSettingsModule.DEFAULT_TRANSLATION_SETTINGS.codexModel, "gpt-5.4-mini");
const fakeFs = {
	existsSync: (value) => value === "/Users/test/.local/bin/codex",
	readdirSync: () => [],
};
const fakeOs = { homedir: () => "/Users/test" };
assert.equal(translation.resolveCodexCommand("", fakeFs, fakeOs, posix), "/Users/test/.local/bin/codex");
assert.equal(translation.resolveCodexCommand("codex", fakeFs, fakeOs, posix), "/Users/test/.local/bin/codex");
assert.equal(translation.resolveCodexCommand("/custom/codex", fakeFs, fakeOs, posix), "/custom/codex");
assert.deepEqual(
	translation.parseOpenCodeModels("google/gemini-3.6-flash\nopencode/deepseek-v4-flash-free\ninvalid line"),
	["google/gemini-3.6-flash", "opencode/deepseek-v4-flash-free"],
);
assert.deepEqual(
	translation.parsePiModels("provider model context max-out\ngoogle gemini-3.5-flash 1M 65K\nopenai-codex gpt-5.4-mini 272K 128K"),
	["google/gemini-3.5-flash", "openai-codex/gpt-5.4-mini"],
);
assert.equal(
	translation.parseOpenCodeResponse('{"type":"text","part":{"text":"Merhaba"}}\n{"type":"step_finish"}'),
	"Merhaba",
);
assert.equal(
	translation.resolveAgentCliCommand("opencode", "", fakeFs, fakeOs, posix),
	"opencode",
);

const aiClient = await loadModule("ai-client.ts");
assert.equal(aiClient.starterModel("google"), "gemini-3.6-flash");
const antigravityClient = await loadModule("ai-client.ts", `
	export async function requestUrl(options) {
		globalThis.__clpAntigravityRequest = options;
		return { status: 200, text: "", json: {
			status: "completed",
			steps: [{ type: "model_output", content: [{ type: "text", text: "AGENT_OK" }] }],
			usage: { total_input_tokens: 4, total_output_tokens: 2, total_thought_tokens: 1 }
		} };
	}
`);
const antigravityResponse = await antigravityClient.chatGoogleAntigravity(
	{ id: "Google", kind: "google", apiKey: "test-key" },
	"gemini-3.7-flash",
	"Explain this sentence.",
);
assert.equal(antigravityResponse.content, "AGENT_OK");
const antigravityBody = JSON.parse(globalThis.__clpAntigravityRequest.body);
assert.equal(antigravityBody.agent, "antigravity-preview-05-2026");
assert.deepEqual(antigravityBody.tools, []);
assert.equal(antigravityBody.store, false);
assert.equal(antigravityBody.agent_config.model, "gemini-3.7-flash");
assert.equal(antigravityBody.agent_config.max_total_tokens, 20000);
delete globalThis.__clpAntigravityRequest;

const epubTranslation = await loadModule("epub-translation.ts");
const epubProgress = epubTranslation.epubTranslationProgress([
	{ spineIndex: 0, href: "cover.xhtml", label: "Cover", units: [] },
	{ spineIndex: 1, href: "chapter-1.xhtml", label: "Chapter 1", units: [{ id: "s1-p0", text: "Energy", sourceHash: "a" }] },
	{ spineIndex: 2, href: "chapter-2.xhtml", label: "Chapter 2", units: [{ id: "s2-p0", text: "Solar", sourceHash: "b" }] },
], [0, 1, 99]);
assert.deepEqual(epubProgress, { total: 2, completed: 1, validTranslatedChapters: [1] });

const study = await loadModule("study.ts");
const exact = study.compareShadowing("Future energy is clean.", "future energy is clean");
assert.equal(exact.score, 100);
assert.deepEqual(exact.differences, []);
const mismatch = study.compareShadowing("Future energy is clean", "Future power was dirty");
assert.ok(mismatch.score < 100 && mismatch.score >= 0);
assert.ok(mismatch.differences.length > 0);

const source = { kind: "epub", path: "Library/Books/Test.epub", label: "Test", context: "Future energy is clean." };
const markdown = study.renderStudyMarkdown({
	vocabulary: [{
		id: "v1", term: "clean | energy", lemma: "clean energy", translation: "temiz enerji", source,
		seen: 2, status: "learning", createdAt: 1, updatedAt: 1,
	}],
	grammar: [{
		id: "g1", title: "Present simple", content: "Genel gerçek anlatır.", grammarPoints: ["Subject + verb"],
		syntaxTree: "S\n├─ NP\n└─ VP", source, createdAt: 1, updatedAt: 1,
	}],
	mistakes: [{
		id: "m1", original: "was", correction: "is", category: "word", explanation: "Zaman uyumu", status: "open",
		source, createdAt: 1, updatedAt: 1,
	}],
	shadowing: [{
		id: "s1", text: "Future energy is clean.", source, attempts: [exact], createdAt: 1, updatedAt: 1,
	}],
});
for (const heading of ["## Vocabulary", "## Grammar", "## Mistakes", "## Shadowing"]) assert.ok(markdown.includes(heading));
assert.ok(markdown.includes("clean \\| energy"), "Markdown table cells must escape pipes");
assert.ok(markdown.includes("%100"));

const migration = await loadModule("migration.ts");
const candidate = {
	sourcePlugin: "legacy",
	sourceLabel: "Legacy",
	term: "Energy", lemma: "energy", translation: "enerji", context: "Clean Energy", ipa: "", partOfSpeech: "noun",
};
assert.equal(migration.vocabularyIdentity(candidate), "energy\nclean energy");
assert.equal(migration.stableHash("same"), migration.stableHash("same"));
assert.notEqual(migration.stableHash("same"), migration.stableHash("different"));
const annotation = {
	sourcePlugin: "legacy", sourceLabel: "Legacy", mode: "note", quote: "safe <!-- marker", note: "Açıklama", context: "Context",
	fingerprint: migration.stableHash("annotation"),
};
const legacyMarkdown = migration.renderLegacyAnnotations([annotation], "preview-fingerprint");
assert.ok(legacyMarkdown.includes(`<!-- clp-legacy:${annotation.fingerprint} -->`));
assert.ok(legacyMarkdown.includes("migration_fingerprint: preview-fingerprint"));
assert.ok(legacyMarkdown.includes("&lt;!--"), "legacy content must not inject an HTML comment");

const quickLookup = await loadModule("quick-lookup.ts");
const lookupRequest = { text: "sustainable", context: "Sustainable energy protects the climate.", kind: "word" };
const translationSettings = {
	backend: "codex", sourceLanguage: "en", targetLanguage: "tr", codexCommand: "", codexModel: "gpt-5.4-mini",
	opencodeCommand: "", opencodeModel: "", piCommand: "", piModel: "google/gemini-3.5-flash", apiProviderId: "",
	antigravityModel: "gemini-3.7-flash",
	reasoningEffort: "none", timeoutSeconds: 120, batchCharacters: 12000, viewMode: "bilingual", bilingualLayout: "auto",
};
const fixedModelCacheKey = translation.translationCacheKey(translationSettings, "source-hash");
assert.ok(fixedModelCacheKey.includes("codex:gpt-5.4-mini"));
assert.equal(
	fixedModelCacheKey,
	translation.translationCacheKey({ ...translationSettings, codexModel: "gpt-5.6-sol" }, "source-hash"),
	"A stale persisted model must not change the fixed Codex cache identity",
);
assert.notEqual(
	translation.translationCacheKey({ ...translationSettings, backend: "pi" }, "source-hash"),
	translation.translationCacheKey({ ...translationSettings, backend: "pi", piModel: "google/gemini-3.6-flash" }, "source-hash"),
	"pi model changes must invalidate translation cache identity",
);
assert.ok(
	translation.translationCacheKey({ ...translationSettings, backend: "antigravity" }, "source-hash")
		.includes("antigravity:gemini-3.7-flash"),
);
assert.notEqual(
	quickLookup.quickLookupCacheKey(translationSettings, lookupRequest, "tr"),
	quickLookup.quickLookupCacheKey(translationSettings, lookupRequest, "en"),
	"Turkish and English contextual explanations must not share a cache entry",
);
assert.ok(quickLookup.buildQuickLookupPrompt(lookupRequest, "tr").includes("use Turkish"));
assert.ok(quickLookup.buildQuickLookupPrompt(lookupRequest, "en").includes("Do not translate the selection into Turkish"));

const readerFlow = await loadModule("reader-flow.ts");
assert.equal(readerFlow.readerScrollOffset(0.5, 2000, 500), 750);
assert.equal(readerFlow.readerScrollFraction(750, 2000, 500), 0.5);
assert.equal(readerFlow.readerScrollFraction(0, 500, 500), 1);
assert.equal(readerFlow.readerSectionIndex(0.5, 10), 5);
assert.equal(readerFlow.readerSectionIndex(1, 10), 9);

console.log(JSON.stringify({
	passed: 53,
	checks: ["persistent import checkpoints", "cancelled queue guard", "fixed gpt-5.4-mini Codex model and cache identity", "OpenCode/pi model catalog parsing and response extraction", "Google Gemini starter model", "Antigravity REST body/tool/storage/token limits and response parsing", "CLI and Antigravity model cache isolation", "Codex ~/.local/bin discovery", "EPUB content-only progress", "shadowing score/differences", "Study Markdown sections/escaping", "migration identity/markers/escaping", "Turkish/English contextual lookup prompts and cache isolation", "continuous-reader scroll fraction and section mapping"],
}, null, 2));
