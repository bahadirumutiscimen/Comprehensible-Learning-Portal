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
		name: "obsidian-live-smoke-shim",
		setup(api) {
			api.onResolve({ filter: /^obsidian$/ }, () => ({ path: "obsidian", namespace: "test-shim" }));
			api.onLoad({ filter: /.*/, namespace: "test-shim" }, () => ({
				contents: "export const Platform={isDesktopApp:true,isMobileApp:false}; export async function requestUrl(){throw new Error('cloud providers are disabled in this Codex smoke test')}",
				loader: "js",
			}));
		},
	}],
});

const module = { exports: {} };
const nativeRequire = createRequire(import.meta.url);
new Function("module", "exports", "require", result.outputFiles[0].text)(module, module.exports, nativeRequire);
const translation = module.exports;

const settings = {
	backend: "codex",
	sourceLanguage: "en",
	targetLanguage: "tr",
	codexCommand: "",
	codexModel: "gpt-5.4-mini",
	reasoningEffort: "low",
	timeoutSeconds: 120,
	batchCharacters: 4000,
	viewMode: "bilingual",
	bilingualLayout: "auto",
};
const units = [
	{ id: "p1", text: "Renewable energy can reduce carbon emissions.", sourceHash: translation.sourceHash("Renewable energy can reduce carbon emissions.") },
	{ id: "p2", text: "The scientist carefully recorded the results in her notebook.", sourceHash: translation.sourceHash("The scientist carefully recorded the results in her notebook.") },
];
const cache = {};
const first = await translation.translateUnits(units, { settings, cache });
assert.equal(first.pairs.length, units.length);
assert.deepEqual(first.pairs.map((pair) => pair.id), units.map((unit) => unit.id));
assert.ok(first.pairs.every((pair) => pair.translation.trim().length > 0));
assert.equal(Object.keys(cache).length, units.length);
assert.ok(first.usage.input > 0);
assert.ok(first.usage.output > 0);

const second = await translation.translateUnits(units, { settings, cache });
assert.equal(second.cacheHits, units.length);
assert.deepEqual(second.pairs, first.pairs);

console.log(JSON.stringify({
	command: translation.resolveCodexCommand("", nativeRequire("node:fs"), nativeRequire("node:os"), nativeRequire("node:path")),
	pairs: first.pairs.map(({ id, text, translation: translated }) => ({ id, source: text, translation: translated })),
	usage: first.usage,
	cacheHitsOnSecondRun: second.cacheHits,
}, null, 2));
