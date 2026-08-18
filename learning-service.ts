import type { AiProvider } from "./ai-client";
import type { TranslationSettings } from "./translation-settings";
import { runTextPrompt } from "./translation-service";

export interface VocabularyAnalysis {
	lemma: string;
	ipa: string;
	partOfSpeech: string;
	turkish: string;
	explanation: string;
}

export interface GrammarAnalysis {
	title: string;
	explanation: string;
	grammarPoints: string[];
	syntaxTree: string;
}

interface LearningOptions {
	settings: TranslationSettings;
	provider?: AiProvider | null;
	signal?: AbortSignal;
}

export async function analyzeVocabulary(
	term: string,
	context: string,
	options: LearningOptions,
): Promise<VocabularyAnalysis> {
	const prompt = [
		"You are the vocabulary engine of an English-to-Turkish learning application.",
		"Analyze the selected English word or phrase in its exact context.",
		"Return only one JSON object with string fields: lemma, ipa, partOfSpeech, turkish, explanation.",
		"turkish must be the concise contextual Turkish meaning. explanation must be one short Turkish sentence about usage/collocation.",
		`Selection: ${JSON.stringify(term)}`,
		`Context: ${JSON.stringify(context)}`,
	].join("\n\n");
	const response = await runTextPrompt(prompt, options.settings, options.provider, options.signal);
	const value = parseObject(response.content);
	return {
		lemma: stringField(value, "lemma") || term,
		ipa: stringField(value, "ipa"),
		partOfSpeech: stringField(value, "partOfSpeech"),
		turkish: stringField(value, "turkish"),
		explanation: stringField(value, "explanation"),
	};
}

export async function analyzeGrammar(
	text: string,
	options: LearningOptions,
): Promise<GrammarAnalysis> {
	const prompt = [
		"You are the grammar and syntax engine of an English-to-Turkish learning application.",
		"Analyze the supplied English sentence or paragraph. Explain in clear Turkish for an intermediate learner.",
		"Return only one JSON object with: title (string), explanation (string), grammarPoints (array of short Turkish strings), syntaxTree (string).",
		"syntaxTree must be a compact, plain-text indented constituent/dependency tree; do not use Markdown fences or Mermaid.",
		"Do not translate the whole passage unless needed to explain the structure.",
		`Text: ${JSON.stringify(text)}`,
	].join("\n\n");
	const response = await runTextPrompt(prompt, options.settings, options.provider, options.signal);
	const value = parseObject(response.content);
	const points = Array.isArray(value.grammarPoints)
		? value.grammarPoints.filter((item): item is string => typeof item === "string").slice(0, 12)
		: [];
	return {
		title: stringField(value, "title") || "Grammar analysis",
		explanation: stringField(value, "explanation"),
		grammarPoints: points,
		syntaxTree: stringField(value, "syntaxTree"),
	};
}

function parseObject(raw: string): Record<string, unknown> {
	const cleaned = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
	const start = cleaned.indexOf("{");
	const end = cleaned.lastIndexOf("}");
	if (start < 0 || end < start) throw new Error("AI öğrenme yanıtında JSON nesnesi bulunamadı.");
	let value: unknown;
	try { value = JSON.parse(cleaned.slice(start, end + 1)); }
	catch { throw new Error("AI öğrenme yanıtı geçerli JSON değil."); }
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("AI öğrenme yanıtı nesne değil.");
	return value as Record<string, unknown>;
}

function stringField(value: Record<string, unknown>, key: string): string {
	return typeof value[key] === "string" ? value[key].trim() : "";
}
