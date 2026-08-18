import type { AiProvider } from "./ai-client";
import { CODEX_LEARNING_MODEL, type TranslationSettings } from "./translation-settings";
import { runTextPrompt, sourceHash } from "./translation-service";

export type QuickLookupTrigger = "selection" | "double-click";
export type QuickLookupScope = "auto" | "word" | "sentence";
export type QuickLookupLayout = "auto" | "vertical" | "horizontal";
export type QuickLookupExplanationLanguage = "tr" | "en";

export interface QuickLookupSettings {
	enabled: boolean;
	trigger: QuickLookupTrigger;
	delayMs: number;
	scope: QuickLookupScope;
	layout: QuickLookupLayout;
	explanationLanguage: QuickLookupExplanationLanguage;
	autoSpeak: boolean;
	stopSpeechOnClose: boolean;
	voiceLocale: "en-US" | "en-GB";
	/** Exact system TTS voice name; empty lets the reader choose a natural match. */
	voiceName: string;
	speechRate: number;
}

export const DEFAULT_QUICK_LOOKUP_SETTINGS: QuickLookupSettings = {
	enabled: true,
	trigger: "double-click",
	delayMs: 450,
	scope: "auto",
	layout: "auto",
	explanationLanguage: "tr",
	autoSpeak: false,
	stopSpeechOnClose: true,
	voiceLocale: "en-US",
	voiceName: "",
	speechRate: 0.92,
};

export interface QuickLookupRequest {
	text: string;
	context: string;
	kind: "word" | "phrase" | "sentence";
}

export interface QuickLookupResult {
	source: string;
	kind: QuickLookupRequest["kind"];
	lemma: string;
	ipa: string;
	partOfSpeech: string;
	meaning: string;
	explanationLanguage: QuickLookupExplanationLanguage;
	explanation: string;
}

export interface QuickLookupCacheEntry {
	result: QuickLookupResult;
	createdAt: number;
	backend: string;
}

interface QuickLookupOptions {
	settings: TranslationSettings;
	explanationLanguage: QuickLookupExplanationLanguage;
	provider?: AiProvider | null;
	signal?: AbortSignal;
}

export function quickLookupCacheKey(
	settings: TranslationSettings,
	request: QuickLookupRequest,
	explanationLanguage: QuickLookupExplanationLanguage,
): string {
	return [
		"lookup-v3",
		settings.backend,
		settings.backend === "codex" ? CODEX_LEARNING_MODEL
			: settings.backend === "opencode" ? settings.opencodeModel
				: settings.backend === "pi" ? settings.piModel
					: settings.backend === "antigravity" ? settings.antigravityModel
					: settings.apiProviderId || "provider-model",
		settings.sourceLanguage,
		settings.targetLanguage,
		explanationLanguage,
		sourceHash(`${request.kind}\n${request.text}\n${request.context}`),
	].join(":");
}

export function buildQuickLookupPrompt(
	request: QuickLookupRequest,
	explanationLanguage: QuickLookupExplanationLanguage,
): string {
	const languageRules = explanationLanguage === "en"
		? [
			"Use learner-friendly English only. Do not translate the selection into Turkish.",
			"meaning must be a concise monolingual English definition that fits this exact context.",
			"explanation must be one or two short English sentences about nuance, usage, collocation or sentence structure. Prefer clear B1-B2 language and do not merely repeat the definition.",
		]
		: [
			"Explain for a Turkish-speaking learner and use Turkish for meaning and explanation.",
			"meaning must be a concise, natural contextual Turkish translation.",
			"explanation must be one or two short Turkish sentences about nuance, usage, collocation or sentence structure. Do not repeat the translation.",
		];
	return [
		"You are the quick contextual lookup engine of an English-learning application.",
		"Explain the selected English text according to its exact context.",
		"Return only one JSON object with string fields: lemma, ipa, partOfSpeech, meaning, explanation.",
		...languageRules,
		"For a word or short phrase, include its dictionary lemma, IPA and part of speech. For a sentence, leave those three fields empty.",
		`Selection kind: ${request.kind}`,
		`Selection: ${JSON.stringify(request.text)}`,
		`Context: ${JSON.stringify(request.context)}`,
	].join("\n\n");
}

export async function analyzeQuickLookup(
	request: QuickLookupRequest,
	options: QuickLookupOptions,
): Promise<QuickLookupResult> {
	const prompt = buildQuickLookupPrompt(request, options.explanationLanguage);
	const response = await runTextPrompt(prompt, options.settings, options.provider, options.signal);
	const value = parseObject(response.content);
	return {
		source: request.text,
		kind: request.kind,
		lemma: stringField(value, "lemma") || (request.kind === "sentence" ? "" : request.text),
		ipa: stringField(value, "ipa"),
		partOfSpeech: stringField(value, "partOfSpeech"),
		meaning: stringField(value, "meaning"),
		explanationLanguage: options.explanationLanguage,
		explanation: stringField(value, "explanation"),
	};
}

function parseObject(raw: string): Record<string, unknown> {
	const cleaned = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
	const start = cleaned.indexOf("{");
	const end = cleaned.lastIndexOf("}");
	if (start < 0 || end < start) throw new Error("Hızlı çeviri yanıtında JSON nesnesi bulunamadı.");
	try {
		const value = JSON.parse(cleaned.slice(start, end + 1)) as unknown;
		if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
	} catch {
		// The user-facing error below is more useful than the raw JSON parser text.
	}
	throw new Error("Hızlı çeviri yanıtı geçerli JSON değil.");
}

function stringField(value: Record<string, unknown>, key: string): string {
	return typeof value[key] === "string" ? value[key].trim() : "";
}
