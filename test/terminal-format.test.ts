import assert from "node:assert/strict";
import test from "node:test";
import {
  formatTokenUsageCompact,
  formatTokenUsageLabel,
} from "../packages/cli/src/terminal-format.ts";

test("token usage formatting shows live values plainly and marks estimated values", () => {
  assert.equal(formatTokenUsageCompact({ totalTokens: 1500, final: false }), "1.5k");
  assert.equal(formatTokenUsageLabel({ totalTokens: 1500, final: false }), "1.5k");
  assert.equal(formatTokenUsageCompact({ totalTokens: 1500, source: "estimated" }), "~1.5k");
  assert.equal(formatTokenUsageLabel({ totalTokens: 1500, source: "estimated" }), "1.5k est");
});
