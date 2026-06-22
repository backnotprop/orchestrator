import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizeTaskUsage,
  selectTaskUsage,
  sumTaskUsage,
  usageWithUpdatedAt,
  type TaskUsage,
} from "@backnotprop/orchestrator-core/tasks";

test("usage selection keeps account and estimated usage out of task summaries", () => {
  const account = usage({
    totalTokens: 1000,
    source: "provider",
    scope: "account",
    final: true,
  });
  const estimated = usage({
    totalTokens: 900,
    source: "estimated",
    scope: "task",
    final: true,
  });
  const partial = usage({
    totalTokens: 100,
    source: "provider",
    scope: "turn",
    final: false,
  });
  const finalTask = usage({
    totalTokens: 150,
    source: "provider",
    scope: "task",
    final: true,
  });

  assert.equal(selectTaskUsage(undefined, account), undefined);
  assert.equal(selectTaskUsage(undefined, estimated), undefined);
  assert.equal(selectTaskUsage(account, undefined), undefined);
  assert.equal(selectTaskUsage(estimated, undefined), undefined);
  assert.equal(selectTaskUsage(partial, account), partial);
  assert.equal(selectTaskUsage(partial, estimated), partial);
  assert.equal(selectTaskUsage(account, partial), partial);
  assert.equal(selectTaskUsage(estimated, partial), partial);
  assert.equal(
    selectTaskUsage(
      usage({
        totalTokens: 1000,
        source: "provider",
        scope: "session",
        final: true,
      }),
      partial,
    ),
    partial,
  );
  assert.equal(selectTaskUsage(partial, finalTask), finalTask);
});

test("usage aggregation sums task usage before falling back to session usage", () => {
  const task = usage({
    totalTokens: 100,
    source: "provider",
    scope: "task",
    final: true,
  });
  const turn = usage({
    totalTokens: 25,
    source: "provider",
    scope: "turn",
    final: true,
  });
  const session = usage({
    totalTokens: 1000,
    source: "provider",
    scope: "session",
    final: true,
  });
  const estimated = usage({
    totalTokens: 500,
    source: "estimated",
    scope: "task",
    final: true,
  });

  assert.equal(sumTaskUsage([task, turn, session, estimated])?.totalTokens, 125);
  assert.equal(sumTaskUsage([session, estimated])?.totalTokens, 1000);
  assert.equal(sumTaskUsage([estimated]), undefined);
});

test("usage normalization accepts normalized camelCase and snake_case fields", () => {
  assert.deepEqual(
    normalizeTaskUsage({
      input_tokens: 10,
      output_tokens: 5,
      cache_read_tokens: 3,
      reasoning_tokens: 2,
      cost_usd: 0.01,
    }),
    {
      inputTokens: 10,
      outputTokens: 5,
      cacheReadTokens: 3,
      reasoningTokens: 2,
      totalTokens: 15,
      costUsd: 0.01,
    },
  );
});

test("usage normalization leaves provider-specific aliases to runtime adapters", () => {
  assert.equal(
    normalizeTaskUsage({
      cached_input_tokens: 3,
      reasoning_output_tokens: 2,
      total_cost_usd: 0.01,
    }),
    undefined,
  );
});

function usage(input: Omit<TaskUsage, "updatedAt">): TaskUsage {
  return usageWithUpdatedAt(input, "2026-06-19T12:00:00.000Z");
}
