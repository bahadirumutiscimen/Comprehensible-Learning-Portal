export type TranslationBackend = "codex" | "opencode" | "pi" | "google" | "antigravity" | "openai" | "anthropic" | "ollama";
export type AgentCliBackend = "opencode" | "pi";

/** Product-level Codex model. Local Codex config must not change learning output. */
export const CODEX_LEARNING_MODEL = "gpt-5.4-mini";

export interface TranslationSettings {
	backend: TranslationBackend;
	sourceLanguage: string;
	targetLanguage: string;
	/** Empty means auto-detect the Codex executable from PATH/common locations. */
	codexCommand: string;
	/** Fixed to CODEX_LEARNING_MODEL whenever Codex is the selected backend. */
	codexModel: string;
	/** Empty means auto-detect ~/.opencode/bin/opencode and common PATH locations. */
	opencodeCommand: string;
	/** OpenCode model in provider/model form, selected from `opencode models`. */
	opencodeModel: string;
	/** Empty means auto-detect the globally installed pi executable. */
	piCommand: string;
	/** pi model in provider/model form, selected from `pi --list-models`. */
	piModel: string;
	/** Exact configured API-provider profile used by non-CLI translation backends. */
	apiProviderId: string;
	/** Antigravity's underlying Gemini model (Interactions API agent_config). */
	antigravityModel: "gemini-3.7-flash" | "gemini-3.6-flash" | "gemini-3.5-flash" | "gemini-3.5-flash-lite";
	/** Translation is intentionally low-reasoning; this remains configurable for difficult prose. */
	reasoningEffort: "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
	timeoutSeconds: number;
	batchCharacters: number;
	viewMode: "source" | "bilingual" | "target";
	bilingualLayout: "auto" | "horizontal" | "vertical";
}

export const DEFAULT_TRANSLATION_SETTINGS: TranslationSettings = {
	backend: "codex",
	sourceLanguage: "en",
	targetLanguage: "tr",
	codexCommand: "",
	codexModel: CODEX_LEARNING_MODEL,
	opencodeCommand: "",
	opencodeModel: "",
	piCommand: "",
	piModel: "google/gemini-3.5-flash",
	apiProviderId: "",
	antigravityModel: "gemini-3.7-flash",
	reasoningEffort: "none",
	timeoutSeconds: 120,
	batchCharacters: 12000,
	viewMode: "bilingual",
	bilingualLayout: "auto",
};
