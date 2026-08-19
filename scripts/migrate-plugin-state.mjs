import fs from "node:fs/promises";
import path from "node:path";

const vault = path.resolve(process.argv[2] ?? "");
const dryRun = process.argv.includes("--dry-run");
if (!vault) throw new Error("Usage: node migrate-plugin-state.mjs <vault-path> [--dry-run]");

const pluginDir = path.join(vault, ".obsidian", "plugins", "comprehensible-learning-portal");
const dataPath = path.join(pluginDir, "data.json");
const stateRoot = path.join(vault, "Library", ".clp");
const contentRoot = path.join(stateRoot, "content");
const youtubeRoot = path.join(stateRoot, "youtube-cache");

function stableHash(value) {
	let hash = 2166136261;
	for (const char of value) {
		hash ^= char.codePointAt(0) ?? 0;
		hash = Math.imul(hash, 16777619);
	}
	return (hash >>> 0).toString(36);
}

async function writeAtomic(filePath, text) {
	if (dryRun) return;
	await fs.mkdir(path.dirname(filePath), { recursive: true });
	const temp = `${filePath}.tmp-${process.pid}`;
	await fs.writeFile(temp, text, "utf8");
	await fs.rename(temp, filePath);
}

const raw = await fs.readFile(dataPath, "utf8");
const data = JSON.parse(raw);
const bilingualBooks = data.bilingualBooks ?? {};
const bookPositions = data.bookPositions ?? {};
const libraryOverrides = data.libraryOverrides ?? {};
const translationCache = data.translationCache ?? {};
const youtubeStoryCache = data.youtubeStoryCache ?? {};

const contentPaths = new Set([
	...Object.keys(bilingualBooks),
	...Object.keys(bookPositions),
	...Object.keys(libraryOverrides),
]);

console.log(JSON.stringify({
	vault,
	dryRun,
	contentStates: contentPaths.size,
	translationCacheEntries: Object.keys(translationCache).length,
	youtubeCacheEntries: Object.keys(youtubeStoryCache).length,
}, null, 2));

for (const sourcePath of contentPaths) {
	const record = {
		version: 1,
		sourcePath,
		kind: /\/YouTube\//i.test(sourcePath) ? "youtube" : /\.pdf$/i.test(sourcePath) ? "pdf" : "epub",
		...(bilingualBooks[sourcePath] ? { bilingualBook: bilingualBooks[sourcePath] } : {}),
		...(bookPositions[sourcePath] ? { bookPosition: bookPositions[sourcePath] } : {}),
		...(libraryOverrides[sourcePath] ? { libraryOverride: libraryOverrides[sourcePath] } : {}),
		updatedAt: 0,
	};
	await writeAtomic(path.join(contentRoot, `${stableHash(sourcePath)}.json`), `${JSON.stringify(record, null, 2)}\n`);
}

await writeAtomic(path.join(stateRoot, "translation-cache.json"), `${JSON.stringify(translationCache)}\n`);
for (const [key, entry] of Object.entries(youtubeStoryCache)) {
	await writeAtomic(path.join(youtubeRoot, `${stableHash(key)}.json`), `${JSON.stringify({ key, entry })}\n`);
}

const migrated = { ...data };
delete migrated.bilingualBooks;
delete migrated.bookPositions;
delete migrated.libraryOverrides;
delete migrated.translationCache;
delete migrated.youtubeStoryCache;

if (!dryRun) {
	await writeAtomic(dataPath, `${JSON.stringify(migrated, null, 2)}\n`);
}

console.log(dryRun ? "Dry-run tamamlandı; hiçbir dosya değiştirilmedi." : "Migration tamamlandı.");
