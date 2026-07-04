import readline from "node:readline";

const mode = process.env.FAKE_CODEX_APP_SERVER_MODE ?? "success";
const rl = readline.createInterface({ input: process.stdin });
let threadId = process.env.FAKE_CODEX_APP_SERVER_THREAD_ID ?? "thread-fake-1";
let turnId;
let turnCounter = 0;
let approvalSent = false;
let resumeRequested = false;
let currentGoal =
  mode === "goal-existing-active"
    ? {
        threadId,
        objective: "existing unfinished goal",
        status: "active",
        tokenBudget: null,
        tokensUsed: 0,
        timeUsedSeconds: 0,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }
    : undefined;

process.on("SIGTERM", () => {
  process.stderr.write("fake codex app-server got sigterm\n");
  process.exit(143);
});

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function respond(id, result) {
  send({ id, result });
}

function respondError(id, message) {
  send({ id, error: { code: -32000, message } });
}

function notify(method, params) {
  send({ method, params });
}

function sendApprovalRequest() {
  approvalSent = true;
  send({
    id: "approval-1",
    method: "item/commandExecution/requestApproval",
    params: {
      threadId,
      turnId,
      command: "printf fake",
    },
  });
}

function sendTokenUsage() {
  notify("thread/tokenUsage/updated", {
    threadId,
    turnId,
    tokenUsage: {
      last: {
        inputTokens: 10,
        cachedInputTokens: 2,
        outputTokens: 4,
        reasoningOutputTokens: 1,
        totalTokens: 15,
      },
      total: {
        inputTokens: 100,
        cachedInputTokens: 20,
        outputTokens: 40,
        reasoningOutputTokens: 10,
        totalTokens: 150,
      },
    },
  });
}

function goalRecord(objective, status, tokenBudget) {
  return {
    threadId,
    objective,
    status,
    tokenBudget: tokenBudget ?? null,
    tokensUsed: status === "active" ? 0 : 15,
    timeUsedSeconds: status === "active" ? 0 : 1,
    createdAt: currentGoal?.createdAt ?? Date.now(),
    updatedAt: Date.now(),
  };
}

function notifyGoalUpdated(goal) {
  notify("thread/goal/updated", {
    threadId,
    goal,
  });
}

function startTurn(id) {
  turnCounter += 1;
  turnId = resumeRequested ? `turn-fake-resumed-${turnCounter}` : `turn-fake-${turnCounter}`;
  respond(id, {
    turn: {
      id: turnId,
      status: "inProgress",
    },
  });
  notify("turn/started", {
    threadId,
    turn: {
      id: turnId,
      status: "inProgress",
    },
  });
  notify("item/agentMessage/delta", {
    threadId,
    turnId,
    itemId: "item-agent-1",
    delta: "Hello ",
  });
}

function finishSuccess() {
  const completedTurnId = turnId;
  notify("item/completed", {
    threadId,
    turnId: completedTurnId,
    item: {
      id: "item-agent-1",
      type: "agentMessage",
      text: "Hello from fake Codex.",
    },
  });
  sendTokenUsage();
  notify("turn/completed", {
    threadId,
    turn: {
      id: completedTurnId,
      status: "completed",
    },
  });
  turnId = undefined;
  approvalSent = false;
}

function finishEmpty() {
  const completedTurnId = turnId;
  notify("item/completed", {
    threadId,
    turnId: completedTurnId,
    item: {
      id: "item-agent-1",
      type: "agentMessage",
      text: "",
    },
  });
  notify("turn/completed", {
    threadId,
    turn: {
      id: completedTurnId,
      status: "completed",
    },
  });
  turnId = undefined;
  approvalSent = false;
}

function finishFailure() {
  const completedTurnId = turnId;
  notify("turn/completed", {
    threadId,
    turn: {
      id: completedTurnId,
      status: "failed",
      error: {
        message: "fake turn failure",
      },
    },
  });
  turnId = undefined;
  approvalSent = false;
}

function finishInterrupted() {
  const completedTurnId = turnId;
  notify("turn/completed", {
    threadId,
    turn: {
      id: completedTurnId,
      status: "interrupted",
    },
  });
  turnId = undefined;
  approvalSent = false;
}

function startGoalTurn() {
  turnCounter += 1;
  turnId = `turn-fake-goal-${turnCounter}`;
  notify("turn/started", {
    threadId,
    turn: {
      id: turnId,
      status: "inProgress",
    },
  });
  notify("item/agentMessage/delta", {
    threadId,
    turnId,
    itemId: "item-agent-goal-1",
    delta: "Goal ",
  });
}

function finishGoal(status = process.env.FAKE_CODEX_APP_SERVER_GOAL_STATUS ?? "complete") {
  const completedTurnId = turnId;
  notify("item/completed", {
    threadId,
    turnId: completedTurnId,
    item: {
      id: "item-agent-goal-1",
      type: "agentMessage",
      text: `Goal ${status} from fake Codex.`,
    },
  });
  sendTokenUsage();
  notify("turn/completed", {
    threadId,
    turn: {
      id: completedTurnId,
      status: "completed",
    },
  });
  turnId = undefined;
  approvalSent = false;
  if (currentGoal) {
    currentGoal = goalRecord(currentGoal.objective, status, currentGoal.tokenBudget);
    notifyGoalUpdated(currentGoal);
  }
}

process.stderr.write("fake codex app-server ready\n");

rl.on("line", (line) => {
  const message = JSON.parse(line);

  if (message.id === "approval-1") {
    if (!message.result || message.result.decision !== "accept") {
      finishFailure();
      return;
    }
    finishSuccess();
    return;
  }

  switch (message.method) {
    case "initialize":
      respond(message.id, {
        serverInfo: {
          name: "fake-codex-app-server",
          version: "0.0.0-test",
        },
      });
      break;
    case "initialized":
      break;
    case "thread/start": {
      const ephemeral = message.params?.ephemeral === true;
      respond(message.id, {
        thread: {
          id: threadId,
          cwd: message.params?.cwd,
          path: `/tmp/fake-codex/${threadId}`,
          status: "idle",
          ephemeral,
        },
      });
      notify("thread/started", { threadId });
      break;
    }
    case "thread/read":
      respond(message.id, {
        thread: {
          id: threadId,
          cwd: message.params?.cwd,
          path: `/tmp/fake-codex/${threadId}`,
          status: turnId ? "busy" : "idle",
          ephemeral: false,
        },
      });
      break;
    case "thread/goal/get":
      respond(message.id, {
        goal: currentGoal ?? null,
      });
      break;
    case "thread/goal/clear":
      currentGoal = undefined;
      respond(message.id, {});
      notify("thread/goal/cleared", { threadId });
      break;
    case "thread/goal/set": {
      const objective = message.params?.objective ?? currentGoal?.objective;
      if (!objective) {
        respondError(message.id, "goal objective is required");
        break;
      }
      if (mode === "goal-complete-without-turn") {
        currentGoal = goalRecord(objective, "complete", message.params?.tokenBudget);
        respond(message.id, {
          goal: currentGoal,
        });
        notifyGoalUpdated(currentGoal);
        break;
      }
      currentGoal = goalRecord(
        objective,
        message.params?.status ?? "active",
        message.params?.tokenBudget,
      );
      respond(message.id, {
        goal: currentGoal,
      });
      notifyGoalUpdated(currentGoal);
      if (currentGoal.status === "active") {
        startGoalTurn();
        if (mode === "goal-delay") {
          const delayMs = Number(process.env.FAKE_CODEX_APP_SERVER_GOAL_DELAY_MS ?? "150");
          setTimeout(() => finishGoal(), delayMs);
        } else if (mode !== "goal-hang") {
          finishGoal();
        }
      }
      break;
    }
    case "thread/resume":
      resumeRequested = true;
      threadId = message.params?.threadId ?? threadId;
      respond(message.id, {
        thread: {
          id: threadId,
          cwd: message.params?.cwd,
          path: `/tmp/fake-codex/${threadId}`,
          status: "idle",
          ephemeral: false,
        },
      });
      notify("thread/resumed", { threadId });
      break;
    case "turn/start":
      if (mode === "slow-turn-start") {
        // Leave the turn/start request pending so tests can interrupt before a turn id exists.
        break;
      }
      if (mode === "late-turn-start") {
        setTimeout(() => {
          startTurn(message.id);
        }, 150);
        break;
      }
      startTurn(message.id);
      if (mode === "failed") {
        finishFailure();
      } else if (mode === "empty") {
        finishEmpty();
      } else if (mode === "hang") {
        // Wait for turn/interrupt.
      } else if (mode === "steer-delay" || mode === "steer-turn-mismatch") {
        // Wait for turn/steer or turn/interrupt.
      } else if (mode === "usage-hang") {
        sendTokenUsage();
        // Keep the turn active so ps --watch can observe live usage.
      } else if (mode === "ignore-interrupt") {
        // Wait for turn/interrupt, but do not respond.
      } else if (mode === "interrupt-no-complete") {
        // Acknowledge interrupt later, but never send turn/completed.
      } else if (!approvalSent) {
        sendApprovalRequest();
      }
      break;
    case "turn/interrupt":
      if (mode === "ignore-interrupt") {
        break;
      }
      if (mode === "interrupt-no-complete") {
        respond(message.id, { ok: true });
        break;
      }
      respond(message.id, { ok: true });
      finishInterrupted();
      break;
    case "turn/steer":
      if (!turnId) {
        respondError(message.id, "no active turn");
        break;
      }
      if (mode === "steer-delay") {
        break;
      }
      if (mode === "steer-turn-mismatch") {
        respond(message.id, {
          turn: {
            id: "turn-fake-other",
            status: "inProgress",
          },
        });
        break;
      }
      if (message.params?.expectedTurnId !== turnId) {
        respondError(message.id, "expected turn id mismatch");
        break;
      }
      respond(message.id, {
        turn: {
          id: turnId,
          status: "inProgress",
        },
      });
      break;
    default:
      respondError(message.id, `unknown method ${message.method}`);
  }
});

rl.on("close", () => process.exit(0));
