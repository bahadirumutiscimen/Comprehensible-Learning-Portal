import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const vault = await mkdtemp(join(tmpdir(), "clp-clean-vault-"));
const pluginId = "comprehensible-learning-portal";
const pluginDir = join(vault, ".obsidian", "plugins", pluginId);
const artifacts = ["main.js", "manifest.json", "styles.css"];
const digest = (buffer) => createHash("sha256").update(buffer).digest("hex");

try {
	await mkdir(pluginDir, { recursive: true });
	for (const artifact of artifacts) await copyFile(join(root, artifact), join(pluginDir, artifact));
	await writeFile(join(vault, ".obsidian", "community-plugins.json"), JSON.stringify([pluginId], null, 2));

	assert.deepEqual((await readdir(join(vault, ".obsidian", "plugins"))).sort(), [pluginId]);
	assert.deepEqual((await readdir(pluginDir)).sort(), [...artifacts].sort());
	const enabled = JSON.parse(await readFile(join(vault, ".obsidian", "community-plugins.json"), "utf8"));
	assert.deepEqual(enabled, [pluginId]);

	const manifest = JSON.parse(await readFile(join(pluginDir, "manifest.json"), "utf8"));
	assert.equal(manifest.id, pluginId);
	assert.equal(manifest.isDesktopOnly, false);
	for (const artifact of artifacts) {
		assert.equal(
			digest(await readFile(join(root, artifact))),
			digest(await readFile(join(pluginDir, artifact))),
			`${artifact} clean-install hash`,
		);
	}

	console.log(JSON.stringify({
		passed: 8,
		checks: ["only Portal enabled", "only production artifacts installed", "no data.json copied", "mobile-loadable manifest", "SHA-256 artifact equality"],
	}, null, 2));
} finally {
	await rm(vault, { recursive: true, force: true });
}
