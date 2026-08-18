import { App, FileSystemAdapter, Platform } from "obsidian";

export const LEGACY_PLUGIN_SOURCES = [
	{ id: "third-mind-reader", label: "Third Mind Reader" },
	{ id: "contextual-ai-reader", label: "Contextual AI Reader" },
	{ id: "epub-reading-importer", label: "EPUB Transfer" },
	{ id: "mouse-tooltip-translator", label: "Mouse Tooltip Translator" },
	{ id: "english-learning-assistant", label: "English Learning Assistant" },
	{ id: "english-study-system", label: "English Study System" },
] as const;

export interface MigrationVocabularyCandidate {
	sourcePlugin: string;
	sourceLabel: string;
	term: string;
	lemma: string;
	translation: string;
	context: string;
	ipa: string;
	partOfSpeech: string;
}

export interface MigrationAnnotationCandidate {
	sourcePlugin: string;
	sourceLabel: string;
	mode: string;
	quote: string;
	note: string;
	context: string;
	fingerprint: string;
}

export interface MigrationPluginReport {
	id: string;
	label: string;
	installed: boolean;
	vocabulary: number;
	annotations: number;
	skipped: number;
	warnings: string[];
}

export interface MigrationPreview {
	createdAt: number;
	vocabulary: MigrationVocabularyCandidate[];
	annotations: MigrationAnnotationCandidate[];
	plugins: MigrationPluginReport[];
	fingerprint: string;
}

export interface MigrationHistoryEntry {
	fingerprint: string;
	appliedAt: number;
	vocabularyImported: number;
	annotationsImported: number;
	verified: boolean;
}

const PRIVATE_PATH = /(?:api.?key|secret|token|password|credential|cache|model|prompt)/i;
const TRANSIENT_PATH = /(?:lookup.?history|translation.?log|recent|cache)/i;
const VOCAB_PATH = /(?:vocab|word.?book|saved.?words?|flashcard|learning.?words?)/i;
const ANNOTATION_PATH = /(?:annotation|highlight|callout|bookmark)/i;

/**
 * Read-only legacy inspection. It is deliberately called only from the
 * settings button's click handler: merely loading the plugin never opens a
 * source plugin's data. Only learning records are projected; credentials,
 * prompts, caches and arbitrary settings never enter the report.
 */
export async function buildMigrationPreview(app: App): Promise<MigrationPreview> {
	if (!Platform.isDesktopApp || !(app.vault.adapter instanceof FileSystemAdapter)) {
		throw new Error("Eski eklenti dry-run taraması yalnızca masaüstünde kullanılabilir.");
	}
	/* eslint-disable @typescript-eslint/no-require-imports -- Desktop-only, user-triggered local migration. */
	const fs = require("fs") as typeof import("fs");
	const path = require("path") as typeof import("path");
	/* eslint-enable @typescript-eslint/no-require-imports -- End desktop-only migration imports. */
	const root = app.vault.adapter.getBasePath();
	const vocabulary: MigrationVocabularyCandidate[] = [];
	const annotations: MigrationAnnotationCandidate[] = [];
	const plugins: MigrationPluginReport[] = [];

	for (const source of LEGACY_PLUGIN_SOURCES) {
		const report: MigrationPluginReport = {
			...source,
			installed: false,
			vocabulary: 0,
			annotations: 0,
			skipped: 0,
			warnings: [],
		};
		plugins.push(report);
		const dataPath = path.join(root, ".obsidian", "plugins", source.id, "data.json");
		if (!fs.existsSync(dataPath)) continue;
		report.installed = true;
		let data: unknown;
		try {
			data = JSON.parse(await fs.promises.readFile(dataPath, "utf8")) as unknown;
		} catch (error) {
			report.warnings.push(`data.json okunamadı: ${error instanceof Error ? error.message : String(error)}`);
			continue;
		}
		walkLearningData(data, "", source.id, source.label, vocabulary, annotations, report, new Set(), 0);
	}

	const dedupedVocabulary = uniqueVocabulary(vocabulary);
	const dedupedAnnotations = uniqueAnnotations(annotations);
	for (const report of plugins) {
		report.vocabulary = dedupedVocabulary.filter((item) => item.sourcePlugin === report.id).length;
		report.annotations = dedupedAnnotations.filter((item) => item.sourcePlugin === report.id).length;
	}
	const fingerprint = stableHash(JSON.stringify({
		vocabulary: dedupedVocabulary.map(vocabularyIdentity).sort(),
		annotations: dedupedAnnotations.map((item) => item.fingerprint).sort(),
	}));
	return {
		createdAt: Date.now(),
		vocabulary: dedupedVocabulary,
		annotations: dedupedAnnotations,
		plugins,
		fingerprint,
	};
}

function walkLearningData(
	value: unknown,
	path: string,
	sourcePlugin: string,
	sourceLabel: string,
	vocabulary: MigrationVocabularyCandidate[],
	annotations: MigrationAnnotationCandidate[],
	report: MigrationPluginReport,
	seen: Set<object>,
	depth: number,
): void {
	if (depth > 12 || value === null || typeof value !== "object") return;
	if (seen.has(value)) return;
	seen.add(value);
	if (Array.isArray(value)) {
		for (const item of value) walkLearningData(item, path, sourcePlugin, sourceLabel, vocabulary, annotations, report, seen, depth + 1);
		return;
	}
	const object = value as Record<string, unknown>;
	if (!PRIVATE_PATH.test(path)) {
		const vocabularyItem = parseVocabulary(object, path, sourcePlugin, sourceLabel);
		if (vocabularyItem) vocabulary.push(vocabularyItem);
		const annotation = parseAnnotation(object, path, sourcePlugin, sourceLabel);
		if (annotation) annotations.push(annotation);
	}
	for (const [key, child] of Object.entries(object)) {
		const childPath = path ? `${path}.${key}` : key;
		if (PRIVATE_PATH.test(childPath)) {
			report.skipped++;
			continue;
		}
		walkLearningData(child, childPath, sourcePlugin, sourceLabel, vocabulary, annotations, report, seen, depth + 1);
	}
}

function parseVocabulary(
	object: Record<string, unknown>,
	path: string,
	sourcePlugin: string,
	sourceLabel: string,
): MigrationVocabularyCandidate | null {
	if (TRANSIENT_PATH.test(path) || !VOCAB_PATH.test(path)) return null;
	const term = field(object, ["term", "word", "phrase", "expression", "front", "sourceText", "source"]);
	if (!term || term.length > 240) return null;
	const translation = field(object, ["translation", "meaning", "turkish", "definition", "back", "targetText", "translatedText"]);
	const context = field(object, ["context", "sentence", "example", "sourceSentence", "quote"]);
	return {
		sourcePlugin,
		sourceLabel,
		term,
		lemma: field(object, ["lemma", "base", "root"]) || term,
		translation,
		context,
		ipa: field(object, ["ipa", "phonetic", "pronunciation"]),
		partOfSpeech: field(object, ["partOfSpeech", "pos", "type"]),
	};
}

function parseAnnotation(
	object: Record<string, unknown>,
	path: string,
	sourcePlugin: string,
	sourceLabel: string,
): MigrationAnnotationCandidate | null {
	if (!ANNOTATION_PATH.test(path)) return null;
	const quote = field(object, ["quote", "selectedText", "selection", "sourceText", "highlightedText"]);
	const note = field(object, ["note", "annotation", "comment", "userText", "content"]);
	if (!quote && !note) return null;
	if (quote.length > 5000 || note.length > 10000) return null;
	const mode = field(object, ["mode", "type", "category"]) || "legacy";
	const context = field(object, ["context", "chapter", "title", "source"]);
	return {
		sourcePlugin,
		sourceLabel,
		mode,
		quote,
		note,
		context,
		fingerprint: stableHash(`${sourcePlugin}\n${mode}\n${quote}\n${note}\n${context}`),
	};
}

function field(object: Record<string, unknown>, names: string[]): string {
	for (const name of names) {
		const value = object[name];
		if (typeof value === "string") return value.normalize("NFKC").replace(/\s+/g, " ").trim();
	}
	return "";
}

export function vocabularyIdentity(item: MigrationVocabularyCandidate): string {
	return `${item.term.toLocaleLowerCase("en")}\n${item.context.toLocaleLowerCase("en")}`;
}

function uniqueVocabulary(items: MigrationVocabularyCandidate[]): MigrationVocabularyCandidate[] {
	const seen = new Set<string>();
	return items.filter((item) => {
		const key = `${item.sourcePlugin}\n${vocabularyIdentity(item)}`;
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
}

function uniqueAnnotations(items: MigrationAnnotationCandidate[]): MigrationAnnotationCandidate[] {
	const seen = new Set<string>();
	return items.filter((item) => {
		if (seen.has(item.fingerprint)) return false;
		seen.add(item.fingerprint);
		return true;
	});
}

export function renderLegacyAnnotations(items: MigrationAnnotationCandidate[], migrationFingerprint: string): string {
	const body = items.map(renderLegacyAnnotationBlock).join("\n\n");
	return [
		"---",
		"clp_document: legacy-annotations",
		`migration_fingerprint: ${migrationFingerprint}`,
		"---",
		"",
		"# Eski eklentilerden taşınan anotasyonlar",
		"",
		"Bu dosya göç önizlemesi onaylandıktan sonra Comprehensible Learning Portal tarafından oluşturuldu.",
		"",
		body,
		"",
	].join("\n");
}

export function renderLegacyAnnotationBlock(item: MigrationAnnotationCandidate): string {
	return [
		`<!-- clp-legacy:${item.fingerprint} -->`,
		`> [!note] ${escapeLine(item.mode)} · ${escapeLine(item.sourceLabel)}`,
		...(item.quote ? [`> > ${escapeLine(item.quote)}`] : []),
		...(item.note ? [`>`, `> ${escapeLine(item.note)}`] : []),
		...(item.context ? [`>`, `> Kaynak bağlamı: ${escapeLine(item.context)}`] : []),
	].join("\n");
}

function escapeLine(value: string): string {
	return value.replace(/\r?\n/g, " ").replace(/<!--/g, "&lt;!--");
}

export function stableHash(value: string): string {
	let hash = 2166136261;
	for (const char of value) {
		hash ^= char.codePointAt(0) ?? 0;
		hash = Math.imul(hash, 16777619);
	}
	return (hash >>> 0).toString(36);
}
