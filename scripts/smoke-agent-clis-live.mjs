import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const result = await build({
	entryPoints: [resolve(root, "translation-service.ts")],
	bundle: true,
	format: "cjs",
	platform: "node",
	write: false,
	plugins: [{
		name: "obsidian-agent-smoke-shim",
		setup(api) {
			api.onResolve({ filter: /^obsidian$/ }, () => ({ path: "obsidian", namespace: "test-shim" }));
			api.onLoad({ filter: /.*/, namespace: "test-shim" }, () => ({
				contents: "export const Platform={isDesktopApp:true,isMobileApp:false}; export async function requestUrl(){throw new Error('API providers are disabled in this CLI smoke test')}",
				loader: "js",
			}));
		},
	}],
});

const module = { exports: {} };
const nativeRequire = createRequire(import.meta.url);
new Function("module", "exports", "require", result.outputFiles[0].text)(module, module.exports, nativeRequire);
const translation = module.exports;

const base = {
	sourceLanguage: "en",
	targetLanguage: "tr",
	codexCommand: "",
	codexModel: "gpt-5.4-mini",
	opencodeCommand: "",
	opencodeModel: "opencode/deepseek-v4-flash-free",
	piCommand: "",
	piModel: "openai-codex/gpt-5.4-mini",
	apiProviderId: "",
	reasoningEffort: "none",
	timeoutSeconds: 120,
	batchCharacters: 4000,
	viewMode: "bilingual",
	bilingualLayout: "auto",
};

const checks = [];
for (const backend of ["opencode", "pi"]) {
	const settings = { ...base, backend };
	const probe = await translation.probeAgentCli(backend, settings);
	assert.equal(probe.available, true, `${backend} probe failed: ${probe.detail}`);
	const model = backend === "opencode" ? settings.opencodeModel : settings.piModel;
	assert.ok(probe.models.includes(model), `${model} is not available in ${backend}`);
	const response = await translation.runTextPrompt(
		"Return only this exact text and nothing else: PORTAL_AGENT_OK",
		settings,
	);
	assert.equal(response.content.trim(), "PORTAL_AGENT_OK");
	checks.push({ backend, model, detail: probe.detail, response: response.content.trim() });
}

console.log(JSON.stringify({ passed: checks.length, checks }, null, 2));
