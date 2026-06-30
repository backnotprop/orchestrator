import readline from "node:readline";

const mode = process.env.FAKE_CODEX_APP_SERVER_MODE ?? "success";
const rl = readline.createInterface({ input: process.stdin });
let threadId = "thread-fake-1";
let turnId = "turn-fake-1";
let approvalSent = false;

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

function finishSuccess() {
  notify("item/completed", {
    threadId,
    turnId,
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
      id: turnId,
      status: "completed",
    },
  });
}

function finishEmpty() {
  notify("item/completed", {
    threadId,
    turnId,
    item: {
      id: "item-agent-1",
      type: "agentMessage",
      text: "",
    },
  });
  notify("turn/completed", {
    threadId,
    turn: {
      id: turnId,
      status: "completed",
    },
  });
}

function finishFailure() {
  notify("turn/completed", {
    threadId,
    turn: {
      id: turnId,
      status: "failed",
      error: {
        message: "fake turn failure",
      },
    },
  });
}

function finishInterrupted() {
  notify("turn/completed", {
    threadId,
    turn: {
      id: turnId,
      status: "interrupted",
    },
  });
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
    case "thread/start":
      respond(message.id, {
        thread: {
          id: threadId,
          cwd: message.params?.cwd,
        },
      });
      notify("thread/started", { threadId });
      break;
    case "turn/start":
      if (mode === "slow-turn-start") {
        // Leave the turn/start request pending so tests can interrupt before a turn id exists.
        break;
      }
      turnId = "turn-fake-1";
      respond(message.id, {
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
      if (mode === "failed") {
        finishFailure();
      } else if (mode === "empty") {
        finishEmpty();
      } else if (mode === "hang") {
        // Wait for turn/interrupt.
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
    default:
      respondError(message.id, `unknown method ${message.method}`);
  }
});

rl.on("close", () => process.exit(0));
