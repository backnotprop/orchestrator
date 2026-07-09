import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const skillDir = new URL("../skills/orchestrator/", import.meta.url);

test("Orchestrator skill ships optional preferences beside its instructions", async () => {
  const [skill, preferences] = await Promise.all([
    readFile(new URL("SKILL.md", skillDir), "utf8"),
    readFile(new URL("PREFERENCES.md", skillDir), "utf8"),
  ]);

  assert.match(skill, /Read `PREFERENCES\.md` beside this file/);
  assert.match(skill, /explicit instructions in the current request/);
  assert.match(skill, /orchestrator models <runtime> --json --compact/);
  assert.match(skill, /Do not sort version-like names or guess from memory/);
  assert.match(skill, /orchestrator limits --json --compact/);
  assert.match(preferences, /resolves them against live\s+runtime catalogs and aliases/);
  assert.match(preferences, /## User Preferences\s+No preferences set\./);
});

test("README presents the model-first skill path and links the operator contract", async () => {
  const [readme, operatorGuide] = await Promise.all([
    readFile(new URL("../README.md", import.meta.url), "utf8"),
    readFile(new URL("../doc/operator-guide.md", import.meta.url), "utf8"),
  ]);

  assert.match(readme, /dead-simple skill built on a powerful local CLI/);
  assert.match(readme, /You speak in models and outcomes/);
  assert.match(readme, /\[Operator Guide\]\(doc\/operator-guide\.md\)/);
  assert.match(operatorGuide, /## Task Lifecycle/);
  assert.match(operatorGuide, /## JSON Control Contract/);
  assert.match(operatorGuide, /## Model Discovery/);
  assert.match(operatorGuide, /## Diagnostics/);
});
