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
  assert.match(skill, /orchestrator limits --json --compact/);
  assert.match(preferences, /## User Preferences\s+No preferences set\./);
});

test("README presents the skill-first path and links the operator contract", async () => {
  const [readme, operatorGuide] = await Promise.all([
    readFile(new URL("../README.md", import.meta.url), "utf8"),
    readFile(new URL("../doc/operator-guide.md", import.meta.url), "utf8"),
  ]);

  assert.match(readme, /portable skill backed by a local CLI/);
  assert.match(readme, /\[Operator Guide\]\(doc\/operator-guide\.md\)/);
  assert.match(operatorGuide, /## Task Lifecycle/);
  assert.match(operatorGuide, /## JSON Control Contract/);
  assert.match(operatorGuide, /## Diagnostics/);
});
