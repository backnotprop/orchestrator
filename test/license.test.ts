import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);
const packageDirs = [".", "packages/agent", "packages/cli", "packages/core"];
const packagePaths = packageDirs.map((dir) =>
  dir === "." ? "package.json" : `${dir}/package.json`,
);
const publishedPackageDirs = ["packages/agent", "packages/cli", "packages/core"];

test("packages declare the time-delayed Business Source License", async () => {
  const [license, ...packageFiles] = await Promise.all([
    readFile(new URL("LICENSE", root), "utf8"),
    ...packagePaths.map((path) => readFile(new URL(path, root), "utf8")),
  ]);

  assert.match(license, /Business Source License 1\.1/);
  assert.match(license, /Change Date:\s+2029-07-09/);
  assert.match(license, /Change License:\s+Apache License, Version 2\.0/);
  assert.match(license, /commercial hosted or managed agent-orchestration service/);

  for (const packageFile of packageFiles) {
    const manifest = JSON.parse(packageFile) as { license?: string };
    assert.equal(manifest.license, "BUSL-1.1");
  }

  const publishedLicenses = await Promise.all(
    publishedPackageDirs.map((dir) => readFile(new URL(`${dir}/LICENSE`, root), "utf8")),
  );
  for (const publishedLicense of publishedLicenses) {
    assert.equal(publishedLicense, license);
  }
});
