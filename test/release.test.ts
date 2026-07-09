import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

interface Manifest {
  readonly version?: string;
  readonly license?: string;
  readonly private?: boolean;
  readonly publishConfig?: { readonly access?: string };
  readonly repository?: { readonly url?: string } | string;
}

async function readJson(path: string): Promise<Manifest> {
  return JSON.parse(await readFile(new URL(path, root), "utf8")) as Manifest;
}

test("release manifests stay synchronized and publishable", async () => {
  const [workspace, core, agent, cli, codexPlugin, claudePlugin, claudeMarketplace] =
    await Promise.all([
      readJson("package.json"),
      readJson("packages/core/package.json"),
      readJson("packages/agent/package.json"),
      readJson("packages/cli/package.json"),
      readJson(".codex-plugin/plugin.json"),
      readJson(".claude-plugin/plugin.json"),
      readJson(".claude-plugin/marketplace.json"),
    ]);

  assert.match(workspace.version ?? "", /^\d+\.\d+\.\d+$/);
  assert.notEqual(workspace.version, "0.0.0");

  for (const manifest of [core, agent, cli]) {
    assert.equal(manifest.version, workspace.version);
    assert.equal(manifest.license, "BUSL-1.1");
    assert.equal(manifest.publishConfig?.access, "public");
    assert.match(
      typeof manifest.repository === "string"
        ? manifest.repository
        : (manifest.repository?.url ?? ""),
      /github\.com\/backnotprop\/orchestrator/,
    );
  }

  assert.equal(codexPlugin.version, workspace.version);
  assert.equal(codexPlugin.license, "BUSL-1.1");
  assert.equal(claudePlugin.version, workspace.version);
  assert.equal(claudePlugin.license, "BUSL-1.1");

  const marketplacePlugins = (claudeMarketplace as { plugins?: Manifest[] }).plugins ?? [];
  assert.equal(marketplacePlugins[0]?.license, "BUSL-1.1");
});
