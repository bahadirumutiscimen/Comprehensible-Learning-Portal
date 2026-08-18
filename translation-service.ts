import { Platform } from "obsidian";
import { chat, chatGoogleAntigravity, type AiProvider, type ChatMessage } from "./ai-client";
import {
	CODEX_LEARNING_MODEL,
	type AgentCliBackend,
	type TranslationSettings,
} from "./translation-settings";

export interface TranslationUnit {
	id: string;
	text: string;
	sourceHash: string;
}

export interface TranslationPair extends TranslationUnit {
	translation: string;
}

export interface TranslationCacheEntry {
	translation: string;
	createdAt: number;
	backend: string;
}

export interface TokenUsage {
	input: number;
	cachedInput: number;
	output: number;
	reasoningOutput: number;
}

export interface TranslationRunResult {
	pairs: TranslationPair[];
	usage: TokenUsage;
	cacheHits: number;
}

export interface TranslationRunOptions {
	settings: TranslationSettings;
	cache: Record<string, TranslationCacheEntry>;
	/** The source surface gets a small prompt specialization. EPUB reading text
	 *  and spoken YouTube transcript units have different punctuation/voice
	 *  expectations; neither surface uses the Gloss/Contextual-AI prompts. */
	context?: "epub" | "youtube";
	provider?: AiProvider | null;
	signal?: AbortSignal;
	onProgress?: (completed: number, total: number, usage: TokenUsage) => void;
	/** Persist the cache/checkpoint after each successful remote/CLI batch. */
	onCheckpoint?: (completed: number, total: number, usage: TokenUsage) => void | Promise<void>;
}

export interface TextPromptResult {
	content: string;
	usage: TokenUsage;
}

const EMPTY_USAGE: TokenUsage = { input: 0, cachedInput: 0, output: 0, reasoningOutput: 0 };

export function normalizeSourceText(text: string): string {
	return text.normalize("NFKC").replace(/\s+/g, " ").trim();
}

/** Stable, portable FNV-1a hash. It is an integrity key, not a security primitive. */
export function sourceHash(text: string): string {
	let value = 2166136261;
	for (const char of normalizeSourceText(text)) {
		value ^= char.codePointAt(0) ?? 0;
		value = Math.imul(value, 16777619);
	}
	return (value >>> 0).toString(36);
}

export function translationCacheKey(
	settings: TranslationSettings,
	hash: string,
	context?: "epub" | "youtube",
): string {
	const backend = settings.backend === "codex"
		? `codex:${CODEX_LEARNING_MODEL}`
		: settings.backend === "opencode"
			? `opencode:${settings.opencodeModel.trim()}`
			: settings.backend === "pi"
				? `pi:${settings.piModel.trim()}`
				: settings.backend === "antigravity"
					? `antigravity:${settings.antigravityModel}`
		: `${settings.backend}:${settings.apiProviderId}`;
	const surface = context ? `:${context}` : "";
	return `translation-v2:${backend}:${settings.sourceLanguage}:${settings.targetLanguage}${surface}:${hash}`;
}

export interface AgentCliProbeResult {
	available: boolean;
	detail: string;
	models: string[];
}

export async function probeAgentCli(
	backend: AgentCliBackend,
	settings: TranslationSettings,
): Promise<AgentCliProbeResult> {
	if (!Platform.isDesktopApp) return { available: false, detail: "Yerel ajan CLI'leri yalnızca masaüstünde çalışır.", models: [] };
	/* eslint-disable @typescript-eslint/no-require-imports -- Desktop-only diagnostics. */
	const childProcess = require("child_process") as typeof import("child_process");
	const fs = require("fs") as typeof import("fs");
	const os = require("os") as typeof import("os");
	const path = require("path") as typeof import("path");
	/* eslint-enable @typescript-eslint/no-require-imports -- End desktop-only diagnostics. */
	const configured = backend === "opencode" ? settings.opencodeCommand : settings.piCommand;
	const command = resolveAgentCliCommand(backend, configured, fs, os, path);
	const env = desktopCliEnvironment(os, path);
	try {
		const version = await spawnProcess(childProcess, command, ["--version"], "", 10000, undefined, env, backend === "opencode" ? "OpenCode" : "pi");
		if (version.code !== 0) throw new Error(lastProcessLines(version.stderr || version.stdout));
		const listed = await spawnProcess(
			childProcess,
			command,
			backend === "opencode" ? ["models"] : ["--list-models"],
			"",
			30000,
			undefined,
			env,
			backend === "opencode" ? "OpenCode" : "pi",
		);
		const models = backend === "opencode" ? parseOpenCodeModels(listed.stdout) : parsePiModels(listed.stdout);
		const versionText = (version.stdout || version.stderr).trim();
		return {
			available: listed.code === 0,
			detail: `${versionText || "sürüm bilinmiyor"} · ${command}`,
			models,
		};
	} catch (error) {
		return { available: false, detail: error instanceof Error ? error.message : String(error), models: [] };
	}
}

export function parseOpenCodeModels(output: string): string[] {
	return uniqueSorted(output.split(/\r?\n/)
		.map((line) => line.trim())
		.filter((line) => /^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._:/-]*$/i.test(line)));
}

export function parsePiModels(output: string): string[] {
	const models: string[] = [];
	for (const raw of output.split(/\r?\n/)) {
		const columns = raw.trim().split(/\s+/);
		if (columns.length < 2 || columns[0] === "provider" || /^-+$/.test(columns[0])) continue;
		if (!/^[a-z0-9][a-z0-9._-]*$/i.test(columns[0])) continue;
		if (!/^[a-z0-9][a-z0-9._:/-]*$/i.test(columns[1])) continue;
		models.push(`${columns[0]}/${columns[1]}`);
	}
	return uniqueSorted(models);
}

export async function probeCodexCommand(settings: TranslationSettings): Promise<{ available: boolean; detail: string }> {
	if (!Platform.isDesktopApp) return { available: false, detail: "Codex CLI yalnızca masaüstünde çalışır." };
	/* eslint-disable @typescript-eslint/no-require-imports -- Diagnostics lazily load desktop-only Node modules. */
	const childProcess = require("child_process") as typeof import("child_process");
	const fs = require("fs") as typeof import("fs");
	const os = require("os") as typeof import("os");
	const path = require("path") as typeof import("path");
	/* eslint-enable @typescript-eslint/no-require-imports -- End desktop-only diagnostic imports. */
	const command = resolveCodexCommand(settings.codexCommand, fs, os, path);
	try {
		const result = await spawnProcess(childProcess, command, ["--version"], "", 10000, undefined, codexEnvironment(os, path));
		const version = (result.stdout || result.stderr).trim();
		const detail = version ? `${version} · ${command}` : command;
		return { available: result.code === 0, detail };
	} catch (error) {
		return { available: false, detail: error instanceof Error ? error.message : String(error) };
	}
}

export async function translateUnits(
	units: TranslationUnit[],
	options: TranslationRunOptions,
): Promise<TranslationRunResult> {
	const { settings, cache, signal, onProgress, onCheckpoint, context } = options;
	const pairs = new Map<string, TranslationPair>();
	const missing: TranslationUnit[] = [];
	let cacheHits = 0;
	let usage = { ...EMPTY_USAGE };

	for (const unit of units) {
		const cached = cache[translationCacheKey(settings, unit.sourceHash, context)];
		if (cached?.translation.trim()) {
			pairs.set(unit.id, { ...unit, translation: cached.translation.trim() });
			cacheHits++;
		} else {
			missing.push(unit);
		}
	}

	let finished = cacheHits;
	onProgress?.(finished, units.length, usage);
	for (const batch of batchUnits(missing, Math.max(2000, settings.batchCharacters))) {
		throwIfAborted(signal);
		const result = settings.backend === "codex"
			? await translateWithCodex(batch, settings, signal, context)
			: settings.backend === "opencode" || settings.backend === "pi"
				? await translateWithAgentCli(batch, settings, signal, context)
				: settings.backend === "antigravity"
					? await translateWithAntigravity(batch, settings, options.provider, context)
				: await translateWithProvider(batch, settings, options.provider, signal, context);
		usage = addUsage(usage, result.usage);
		validateTranslations(batch, result.translations);
		for (const unit of batch) {
			const translation = result.translations[unit.id].trim();
			pairs.set(unit.id, { ...unit, translation });
			cache[translationCacheKey(settings, unit.sourceHash, context)] = {
				translation,
				createdAt: Date.now(),
				backend: settings.backend,
			};
		}
		finished += batch.length;
		onProgress?.(finished, units.length, usage);
		await onCheckpoint?.(finished, units.length, usage);
	}

	return {
		pairs: units.map((unit) => pairs.get(unit.id)!).filter(Boolean),
		usage,
		cacheHits,
	};
}

function batchUnits(units: TranslationUnit[], maxCharacters: number): TranslationUnit[][] {
	const batches: TranslationUnit[][] = [];
	let current: TranslationUnit[] = [];
	let size = 0;
	for (const unit of units) {
		const next = unit.text.length + unit.id.length + 40;
		if (current.length && size + next > maxCharacters) {
			batches.push(current);
			current = [];
			size = 0;
		}
		current.push(unit);
		size += next;
	}
	if (current.length) batches.push(current);
	return batches;
}


function buildPrompt(
	units: TranslationUnit[],
	settings: TranslationSettings,
	context: "epub" | "youtube" | undefined = "epub",
): string {
	const surface = context === "youtube"
		? [
			"You are translating a spoken YouTube transcript for an English learner.",
			"Treat each item as one time-coded reading unit: keep item boundaries, sentence order, and names intact; do not merge or split items.",
			"Keep the translation natural and add normal Turkish punctuation even when the source captions are unpunctuated.",
		]
		: [
			"You are translating literary EPUB reading text for an English learner.",
			"Treat each item as one paragraph: preserve its meaning, tone, emphasis, and paragraph boundary.",
		];
	return [
		"You are a precise literary translation engine.",
		...surface,
		`Translate every item from ${settings.sourceLanguage} to ${settings.targetLanguage}.`,
		"Preserve paragraph meaning, tone, punctuation, names, and emphasis. Do not summarize or split/merge items.",
		"Return only a valid JSON array. Each item must be {\"id\": string, \"translation\": string} in the same order.",
		JSON.stringify(units.map(({ id, text }) => ({ id, text }))),
	].join("\n\n");
}

async function translateWithProvider(
	units: TranslationUnit[],
	settings: TranslationSettings,
	provider: AiProvider | null | undefined,
	signal?: AbortSignal,
	context?: "epub" | "youtube",
): Promise<{ translations: Record<string, string>; usage: TokenUsage }> {
	if (!provider?.defaultModel) {
		throw new Error(`${settings.backend} için kullanılabilir bir AI sağlayıcısı ve model ayarlanmamış.`);
	}
	const messages: ChatMessage[] = [{ role: "user", content: buildPrompt(units, settings, context) }];
	const response = await chat(provider, provider.defaultModel, {
		messages,
		maxTokens: Math.max(2048, Math.ceil(units.reduce((n, u) => n + u.text.length, 0) / 2)),
		stream: false,
		signal,
	});
	return { translations: parseTranslationResponse(response.content, units), usage: usageFromRaw(response.raw) };
}

async function translateWithCodex(
	units: TranslationUnit[],
	settings: TranslationSettings,
	signal?: AbortSignal,
	context?: "epub" | "youtube",
): Promise<{ translations: Record<string, string>; usage: TokenUsage }> {
	const result = await runCodexTextPrompt(buildPrompt(units, settings, context), settings, signal);
	return { translations: parseTranslationResponse(result.content, units), usage: result.usage };
}

async function translateWithAgentCli(
	units: TranslationUnit[],
	settings: TranslationSettings,
	signal?: AbortSignal,
	context?: "epub" | "youtube",
): Promise<{ translations: Record<string, string>; usage: TokenUsage }> {
	const result = await runAgentCliTextPrompt(settings.backend as AgentCliBackend, buildPrompt(units, settings, context), settings, signal);
	return { translations: parseTranslationResponse(result.content, units), usage: result.usage };
}

async function translateWithAntigravity(
	units: TranslationUnit[],
	settings: TranslationSettings,
	provider: AiProvider | null | undefined,
	context?: "epub" | "youtube",
): Promise<{ translations: Record<string, string>; usage: TokenUsage }> {
	if (!provider) throw new Error("Google Antigravity için Google Gemini sağlayıcı profili ve API anahtarı gerekli.");
	const response = await chatGoogleAntigravity(provider, settings.antigravityModel, buildPrompt(units, settings, context));
	return { translations: parseTranslationResponse(response.content, units), usage: usageFromRaw(response.raw) };
}

/** Run a product-owned learning prompt through the configured translation
 * backend. This keeps vocabulary/grammar/shadowing on Codex by default too,
 * instead of requiring a second provider configuration. */
export async function runTextPrompt(
	prompt: string,
	settings: TranslationSettings,
	provider?: AiProvider | null,
	signal?: AbortSignal,
): Promise<TextPromptResult> {
	if (settings.backend === "codex") return runCodexTextPrompt(prompt, settings, signal);
	if (settings.backend === "opencode" || settings.backend === "pi") {
		return runAgentCliTextPrompt(settings.backend, prompt, settings, signal);
	}
	if (settings.backend === "antigravity") {
		if (!provider) throw new Error("Google Antigravity için Google Gemini sağlayıcı profili ve API anahtarı gerekli.");
		const response = await chatGoogleAntigravity(provider, settings.antigravityModel, prompt);
		return { content: response.content, usage: usageFromRaw(response.raw) };
	}
	if (!provider?.defaultModel) throw new Error(`${settings.backend} için kullanılabilir bir AI sağlayıcısı ve model ayarlanmamış.`);
	const response = await chat(provider, provider.defaultModel, {
		messages: [{ role: "user", content: prompt }],
		maxTokens: 2400,
		stream: false,
		signal,
	});
	return { content: response.content, usage: usageFromRaw(response.raw) };
}

async function runAgentCliTextPrompt(
	backend: AgentCliBackend,
	prompt: string,
	settings: TranslationSettings,
	signal?: AbortSignal,
): Promise<TextPromptResult> {
	if (!Platform.isDesktopApp) {
		throw new Error("OpenCode ve pi öğrenme işlemleri masaüstünde çalışır. İçeriği masaüstünde hazırlayıp mobilde okuyabilirsin.");
	}
	/* eslint-disable @typescript-eslint/no-require-imports -- Desktop-only Node process adapter. */
	const childProcess = require("child_process") as typeof import("child_process");
	const fs = require("fs") as typeof import("fs");
	const fsp = require("fs/promises") as typeof import("fs/promises");
	const os = require("os") as typeof import("os");
	const path = require("path") as typeof import("path");
	/* eslint-enable @typescript-eslint/no-require-imports -- End desktop-only adapter. */
	const configured = backend === "opencode" ? settings.opencodeCommand : settings.piCommand;
	const model = (backend === "opencode" ? settings.opencodeModel : settings.piModel).trim();
	if (!model) throw new Error(`${backend === "opencode" ? "OpenCode" : "pi"} için önce bir model seç.`);
	const command = resolveAgentCliCommand(backend, configured, fs, os, path);
	const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), `clp-${backend}-`));
	try {
		let args: string[];
		if (backend === "opencode") {
			// Project-local deny-all policy plus --pure prevents a translation
			// prompt from invoking tools, plugins, skills or external directories.
			await fsp.writeFile(path.join(tempDir, "opencode.json"), JSON.stringify({ permission: "deny" }), "utf8");
			args = ["run", "--pure", "--format", "json", "--model", model];
			// OpenCode calls the provider-specific reasoning selector a variant.
			// `none` deliberately omits it so the selected model's normal fast
			// path is used; the other values are understood by reasoning models.
			if (settings.reasoningEffort !== "none") args.push("--variant", settings.reasoningEffort);
			args.push("--dir", tempDir, prompt);
		} else {
			const thinking = settings.reasoningEffort === "none" ? "off" : settings.reasoningEffort;
			args = [
				"--no-session", "--no-tools", "--no-extensions", "--no-skills",
				"--no-prompt-templates", "--no-themes", "--no-context-files",
				"--mode", "text", "--thinking", thinking, "--model", model, "--print", prompt,
			];
		}
		const label = backend === "opencode" ? "OpenCode" : "pi";
		const result = await spawnProcess(
			childProcess,
			command,
			args,
			"",
			Math.max(10, settings.timeoutSeconds) * 1000,
			signal,
			desktopCliEnvironment(os, path),
			label,
		);
		if (result.code !== 0) throw new Error(lastProcessLines(result.stderr || result.stdout));
		const content = backend === "opencode" ? parseOpenCodeResponse(result.stdout) : result.stdout.trim();
		if (!content) throw new Error(`${label} boş yanıt verdi.`);
		return { content, usage: { ...EMPTY_USAGE } };
	} finally {
		await fsp.rm(tempDir, { recursive: true, force: true });
	}
}

export function parseOpenCodeResponse(output: string): string {
	const chunks: string[] = [];
	for (const raw of output.split(/\r?\n/)) {
		if (!raw.trim()) continue;
		try {
			const event = JSON.parse(raw) as Record<string, unknown>;
			if (event.type !== "text") continue;
			const part = event.part && typeof event.part === "object" ? event.part as Record<string, unknown> : {};
			const text = typeof part.text === "string" ? part.text
				: typeof event.text === "string" ? event.text
					: typeof event.content === "string" ? event.content : "";
			if (text) chunks.push(text);
		} catch { /* JSON event streams may include a diagnostic line. */ }
	}
	return chunks.join("").trim();
}

async function runCodexTextPrompt(
	prompt: string,
	settings: TranslationSettings,
	signal?: AbortSignal,
): Promise<TextPromptResult> {
	if (!Platform.isDesktopApp) {
		throw new Error("Codex CLI öğrenme işlemleri masaüstünde çalışır. İçeriği masaüstünde hazırlayıp mobilde okuyabilirsin.");
	}
	/* eslint-disable @typescript-eslint/no-require-imports -- Node is loaded lazily so the mobile bundle can start. */
	const childProcess = require("child_process") as typeof import("child_process");
	const fs = require("fs") as typeof import("fs");
	const fsp = require("fs/promises") as typeof import("fs/promises");
	const os = require("os") as typeof import("os");
	const path = require("path") as typeof import("path");
	/* eslint-enable @typescript-eslint/no-require-imports -- End desktop-only lazy Node imports. */
	const command = resolveCodexCommand(settings.codexCommand, fs, os, path);
	const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "clp-codex-"));
	const outputFile = path.join(tempDir, "result.txt");
	const args = [
		"exec", "--ignore-user-config", "--ignore-rules", "--ephemeral",
		"--skip-git-repo-check", "--color", "never", "--json",
		"--disable", "plugins", "--disable", "tool_suggest", "--disable", "multi_agent",
		"--disable", "browser_use", "--disable", "computer_use",
		"--disable", "image_generation", "--disable", "workspace_dependencies",
		"-C", os.tmpdir(), "-s", "read-only",
	];
	// Deliberately override the user's global Codex default. Portal learning
	// output must remain on the product-tested model across installations.
	args.push("-m", CODEX_LEARNING_MODEL);
	args.push("-c", `model_reasoning_effort="${settings.reasoningEffort}"`, "-o", outputFile, "-");

	try {
		const processResult = await spawnProcess(
			childProcess,
			command,
			args,
			prompt,
			Math.max(10, settings.timeoutSeconds) * 1000,
			signal,
			codexEnvironment(os, path),
		);
		if (processResult.code !== 0) throw new Error(lastProcessLines(processResult.stderr || processResult.stdout));
		const content = await fsp.readFile(outputFile, "utf8");
		return { content, usage: parseCodexUsage(processResult.stdout) };
	} finally {
		await fsp.rm(tempDir, { recursive: true, force: true });
	}
}

export function resolveCodexCommand(
	command: string,
	fs: typeof import("fs"),
	os: typeof import("os"),
	path: typeof import("path"),
): string {
	const configured = command.trim();
	if (configured && configured !== "codex") return configured;
	const home = os.homedir();
	const nvmBinCandidates: string[] = [];
	if (process.platform !== "win32") {
		const versionsRoot = path.join(home, ".nvm", "versions", "node");
		try {
			for (const version of fs.readdirSync(versionsRoot).sort().reverse()) {
				nvmBinCandidates.push(path.join(versionsRoot, version, "bin", "codex"));
			}
		} catch { /* NVM is optional. */ }
	}
	const candidates = process.platform === "win32"
		? ["codex.cmd", "codex.exe", "codex"]
		: [
			"/Applications/Codex.app/Contents/Resources/codex",
			path.join(home, ".local", "bin", "codex"),
			path.join(home, ".cargo", "bin", "codex"),
			"/opt/homebrew/bin/codex",
			"/usr/local/bin/codex",
			...nvmBinCandidates,
			"codex",
		];
	return candidates.find((candidate) => candidate === "codex" || fs.existsSync(candidate)) ?? "codex";
}

export function resolveAgentCliCommand(
	backend: AgentCliBackend,
	command: string,
	fs: typeof import("fs"),
	os: typeof import("os"),
	path: typeof import("path"),
): string {
	const binary = backend === "opencode" ? "opencode" : "pi";
	const configured = command.trim();
	if (configured && configured !== binary) return configured;
	const home = os.homedir();
	const nvmCandidates: string[] = [];
	if (process.platform !== "win32") {
		try {
			const versionsRoot = path.join(home, ".nvm", "versions", "node");
			for (const version of fs.readdirSync(versionsRoot).sort().reverse()) {
				nvmCandidates.push(path.join(versionsRoot, version, "bin", binary));
			}
		} catch { /* NVM is optional. */ }
	}
	const candidates = process.platform === "win32"
		? [`${binary}.cmd`, `${binary}.exe`, binary]
		: [
			...(backend === "opencode" ? [path.join(home, ".opencode", "bin", "opencode")] : []),
			path.join(home, ".local", "bin", binary),
			"/opt/homebrew/bin/" + binary,
			"/usr/local/bin/" + binary,
			...nvmCandidates,
			binary,
		];
	return candidates.find((candidate) => candidate === binary || fs.existsSync(candidate)) ?? binary;
}

function codexEnvironment(os: typeof import("os"), path: typeof import("path")): NodeJS.ProcessEnv {
	return {
		...desktopCliEnvironment(os, path),
		CODEX_HOME: process.env.CODEX_HOME || path.join(os.homedir(), ".codex"),
	};
}

function desktopCliEnvironment(os: typeof import("os"), path: typeof import("path")): NodeJS.ProcessEnv {
	const extra = process.platform === "win32"
		? []
		: [
			path.join(os.homedir(), ".opencode", "bin"),
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

function spawnProcess(
	childProcess: typeof import("child_process"),
	command: string,
	args: string[],
	stdin: string,
	timeoutMs: number,
	signal: AbortSignal | undefined,
	env: NodeJS.ProcessEnv,
	label = "Codex",
): Promise<{ code: number | null; stdout: string; stderr: string }> {
	return new Promise((resolve, reject) => {
		throwIfAborted(signal);
		const shell = process.platform === "win32" && (/\.(cmd|bat)$/i.test(command) || !/[\\/]/.test(command));
		const child = childProcess.spawn(command, args, { env, shell, windowsHide: true });
		let stdout = "";
		let stderr = "";
		let timedOut = false;
		let aborted = false;
		const kill = (): void => {
			child.kill("SIGTERM");
			setTimeout(() => {
				try { child.kill("SIGKILL"); } catch { /* already closed */ }
			}, 1000);
		};
		const onAbort = (): void => { aborted = true; kill(); };
		signal?.addEventListener("abort", onAbort, { once: true });
		const timer = setTimeout(() => { timedOut = true; kill(); }, timeoutMs);
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => { stdout += chunk; });
		child.stderr.on("data", (chunk: string) => { stderr += chunk; });
		child.on("error", (error) => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
			const processError = error as NodeJS.ErrnoException;
			if (processError.code === "ENOENT") {
				reject(new Error(`${label} çalıştırılamadı: ${command} bulunamadı. Ayarlar → Çeviri bölümünde komutu sınayabilir veya tam dosya yolunu girebilirsin.`));
			} else {
				reject(error);
			}
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
			if (aborted) reject(new DOMException("İşlem kullanıcı tarafından durduruldu.", "AbortError"));
			else if (timedOut) reject(new Error(`${label} ${Math.round(timeoutMs / 1000)} saniye içinde yanıt vermedi.`));
			else resolve({ code, stdout, stderr });
		});
		child.stdin.end(stdin);
	});
}

function parseTranslationResponse(raw: string, units: TranslationUnit[]): Record<string, string> {
	const cleaned = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
	const start = cleaned.indexOf("[");
	const end = cleaned.lastIndexOf("]");
	if (start < 0 || end < start) throw new Error("Çeviri yanıtında JSON dizisi bulunamadı.");
	let value: unknown;
	try { value = JSON.parse(cleaned.slice(start, end + 1)); }
	catch { throw new Error("Çeviri yanıtı geçerli JSON değil."); }
	if (!Array.isArray(value)) throw new Error("Çeviri yanıtı bir dizi değil.");
	const translations: Record<string, string> = {};
	for (const item of value) {
		if (!item || typeof item !== "object") continue;
		const rawId = (item as { id?: unknown }).id;
		const id = typeof rawId === "string" ? rawId : "";
		const translation = (item as { translation?: unknown }).translation;
		if (id && typeof translation === "string") translations[id] = translation;
	}
	validateTranslations(units, translations);
	return translations;
}

function validateTranslations(units: TranslationUnit[], translations: Record<string, string>): void {
	for (const unit of units) {
		if (!translations[unit.id]?.trim()) throw new Error(`Paragraf çevirisi eksik: ${unit.id}`);
	}
}

function parseCodexUsage(jsonl: string): TokenUsage {
	let usage = { ...EMPTY_USAGE };
	for (const line of jsonl.split(/\r?\n/)) {
		try {
			const event = JSON.parse(line) as { type?: string; usage?: Record<string, number> };
			if (event.type !== "turn.completed" || !event.usage) continue;
			usage = {
				input: event.usage.input_tokens ?? 0,
				cachedInput: event.usage.cached_input_tokens ?? 0,
				output: event.usage.output_tokens ?? 0,
				reasoningOutput: event.usage.reasoning_output_tokens ?? 0,
			};
		} catch { /* non-JSON diagnostic line */ }
	}
	return usage;
}

function usageFromRaw(raw: unknown): TokenUsage {
	const obj = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
	const u = obj.usage && typeof obj.usage === "object" ? obj.usage as Record<string, number> : {};
	const google = obj.usageMetadata && typeof obj.usageMetadata === "object"
		? obj.usageMetadata as Record<string, number>
		: {};
	return {
		input: u.prompt_tokens ?? u.input_tokens ?? u.total_input_tokens ?? google.promptTokenCount ?? 0,
		cachedInput: u.cached_input_tokens ?? u.total_cached_tokens ?? google.cachedContentTokenCount ?? 0,
		output: u.completion_tokens ?? u.output_tokens ?? u.total_output_tokens ?? google.candidatesTokenCount ?? 0,
		reasoningOutput: u.reasoning_output_tokens ?? u.total_thought_tokens ?? google.thoughtsTokenCount ?? 0,
	};
}

function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
	return {
		input: a.input + b.input,
		cachedInput: a.cachedInput + b.cachedInput,
		output: a.output + b.output,
		reasoningOutput: a.reasoningOutput + b.reasoningOutput,
	};
}

function lastProcessLines(text: string): string {
	return text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).slice(-4).join(" ") || "Codex bilinmeyen bir hata verdi.";
}

function uniqueSorted(values: string[]): string[] {
	return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

function throwIfAborted(signal?: AbortSignal): void {
	if (signal?.aborted) throw new DOMException("İşlem kullanıcı tarafından durduruldu.", "AbortError");
}
