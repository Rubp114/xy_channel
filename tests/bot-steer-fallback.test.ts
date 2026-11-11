import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  tryDirectSteer: vi.fn(),
  activeSdkRun: vi.fn(),
  loadNativeImages: vi.fn(),
  downloadFiles: vi.fn(),
  updateModel: vi.fn(),
  createXYReplyDispatcher: vi.fn(),
  dispatchReplyFromConfig: vi.fn(),
  sendStatusUpdate: vi.fn(),
  sendA2AResponse: vi.fn(),
  log: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/agent-harness-runtime", () => ({
  callGatewayTool: vi.fn(),
  resolveActiveEmbeddedRunSessionId: mocks.activeSdkRun,
  abortAgentHarnessRun: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/conversation-runtime", () => ({
  resolveRuntimeConversationBindingRoute: ({ route }) => ({ route }),
}));

vi.mock("openclaw/plugin-sdk/session-store-runtime", () => ({
  updateSessionStoreEntry: mocks.updateModel,
  updateSessionStore: vi.fn(),
  resolveStorePath: vi.fn(),
}));

vi.mock("../src/runtime.js", () => ({
  getXYRuntime: () => ({
    channel: {
      routing: {
        resolveAgentRoute: () => ({
          sessionKey: "agent:main:direct:session-steer",
          accountId: "default",
        }),
      },
      reply: {
        resolveEnvelopeFormatOptions: () => ({}),
        formatAgentEnvelope: ({ body }) => body,
        finalizeInboundContext: (ctx) => ctx,
        withReplyDispatcher: async ({ run }) => await run(),
        dispatchReplyFromConfig: mocks.dispatchReplyFromConfig,
      },
    },
  }),
}));

vi.mock("../src/dispatch/reply-dispatcher.js", () => ({
  createXYReplyDispatcher: mocks.createXYReplyDispatcher,
}));

vi.mock("../src/file-download.js", () => ({
  downloadFilesFromParts: mocks.downloadFiles,
}));
vi.mock("../src/native-images.js", () => ({
  loadNativeImages: mocks.loadNativeImages,
  NATIVE_IMAGE_MAX_BYTES: 6 * 1024 * 1024,
  NativeImageInputError: class extends Error {},
}));

vi.mock("../src/config.js", () => ({
  resolveXYConfig: () => ({ pinnedSessionIds: [], terminalFrameDelayMs: 0 }),
}));

vi.mock("../src/formatter.js", () => ({
  sendStatusUpdate: mocks.sendStatusUpdate,
  sendClearContextResponse: vi.fn(),
  sendTasksCancelResponse: vi.fn(),
  sendA2AResponse: mocks.sendA2AResponse,
}));

vi.mock("../src/self-evolution-keyword.js", () => ({
  appendSelfEvolutionKeywordNudge: (text) => ({ text, appended: false }),
  shouldNudgeForSelfEvolutionKeyword: () => false,
}));

vi.mock("../src/tools/session-manager.js", () => ({
  runWithSessionContext: (_ctx, fn) => fn(),
}));

vi.mock("../src/utils/config-manager.js", () => ({
  configManager: { updatePushId: vi.fn() },
}));

vi.mock("../src/utils/pushid-manager.js", () => ({ addPushId: vi.fn() }));
vi.mock("../src/utils/pushdata-manager.js", () => ({ getPushDataById: vi.fn() }));
vi.mock("../src/utils/self-evolution-manager.js", () => ({
  selfEvolutionManager: { isEnabled: async () => false },
}));
vi.mock("../src/utils/runtime-manager.js", () => ({ saveRuntimeInfo: async () => undefined }));
vi.mock("../src/utils/tool-call-nudge-manager.js", () => ({
  toolCallNudgeManager: { tryMarkKeywordNudge: vi.fn() },
}));
vi.mock("../src/conversation/steer-service.js", () => ({
  tryDirectSteer: mocks.tryDirectSteer,
}));
vi.mock("../src/approval-bridge.js", () => ({ clearPendingApproval: vi.fn() }));
vi.mock("../src/utils/logger.js", () => ({
  logger: {
    withContext: () => ({ log: mocks.log, warn: mocks.warn, error: mocks.error }),
    log: mocks.log,
    warn: mocks.warn,
    error: mocks.error,
  },
}));

import { handleXYMessage } from "../src/dispatch/bot.js";
import {
  bindSessionKey,
  completeTask,
  getWaitState,
  markSubagentSpawned,
  deleteSession,
  getCurrentTaskId,
  listSessions,
  registerTask,
} from "../src/conversation/conversation-manager.js";

const message = {
  method: "message/stream",
  id: "message-new",
  params: {
    sessionId: "session-steer",
    id: "task-new",
    message: { role: "user", parts: [{ kind: "text", text: "还有体育新闻" }] },
  },
} as any;

describe("bot steer fallback sequencing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.activeSdkRun.mockReset();
    mocks.loadNativeImages.mockReset();
    mocks.downloadFiles.mockImplementation(async (parts) => parts.map((file) => ({ ...file, path: "/tmp/picture.png" })));
    mocks.updateModel.mockResolvedValue({});
    mocks.sendStatusUpdate.mockResolvedValue(undefined);
    mocks.sendA2AResponse.mockResolvedValue(undefined);
    mocks.createXYReplyDispatcher.mockReturnValue({
      dispatcher: {},
      replyOptions: {},
      markDispatchIdle: vi.fn(),
      startStatusInterval: vi.fn(),
    });
    mocks.dispatchReplyFromConfig.mockResolvedValue({ queuedFinal: true });
    registerTask("session-steer", "task-old", "message-old");
    bindSessionKey("agent:main:direct:session-steer", "session-steer", "task-old", "message-old");
  });

  afterEach(() => {
    vi.useRealTimers();
    for (const session of listSessions()) {
      deleteSession(session.sessionId);
    }
  });

  it("queue rejection waits for the old turn before dispatching unmodified user text", async () => {
    const order: string[] = [];
    mocks.tryDirectSteer.mockReturnValue({ ok: false, reason: "queue-rejected" });
    mocks.dispatchReplyFromConfig.mockImplementation(async ({ ctx }) => {
      order.push("dispatch");
      expect(ctx.RawBody).toBe("还有体育新闻");
      expect(ctx.RawBody).not.toContain("忽略");
      expect(getCurrentTaskId("session-steer")).toBe("task-new");
      return { queuedFinal: true };
    });

    await handleXYMessage({
      cfg: {},
      runtime: { error: mocks.error },
      message,
      accountId: "default",
      waitForPreviousTurn: async () => {
        order.push("wait-old-turn");
        expect(getCurrentTaskId("session-steer")).toBe("task-old");
      },
    });

    expect(order).toEqual(["wait-old-turn", "dispatch"]);
    expect(mocks.tryDirectSteer).toHaveBeenCalledWith(expect.objectContaining({
      text: "还有体育新闻",
      source: "user",
    }));
  });

  it("direct success closes the previous device task without a replacement dispatch", async () => {
    mocks.tryDirectSteer.mockReturnValue({ ok: true, mode: "direct" });
    const waitForPreviousTurn = vi.fn();

    await handleXYMessage({
      cfg: {},
      runtime: { error: mocks.error },
      message,
      accountId: "default",
      waitForPreviousTurn,
    });

    expect(mocks.sendA2AResponse).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: "session-steer",
      taskId: "task-old",
      messageId: "message-old",
      text: "",
      append: true,
      final: true,
    }));
    expect(waitForPreviousTurn).not.toHaveBeenCalled();
    expect(mocks.dispatchReplyFromConfig).not.toHaveBeenCalled();
    expect(getCurrentTaskId("session-steer")).toBe("task-new");
  });
  const image = { type: "image", data: "abc", mimeType: "image/png" };
  const imageMessage = {
    ...message,
    sessionId: "distribution-session",
    params: {
      ...message.params,
      message: { role: "user", parts: [
        { kind: "file", file: { name: "picture.png", mimeType: "image/png", uri: "https://example.invalid/img" } },
        { kind: "data", data: { variables: { clientVariables: {
          modelName: "Vision", modelInput: ["text", "image"],
        } } } },
      ] },
    },
  };

  it("dispatches a pure image only after the old task settles, with new task heartbeat", async () => {
    vi.useFakeTimers();
    mocks.loadNativeImages.mockResolvedValue([image]);
    const pending = handleXYMessage({
      cfg: { messages: { queue: { mode: "steer" } } }, runtime: {}, message: imageMessage,
      accountId: "default", webSocketSessionId: "outer-ws",
    });
    await vi.advanceTimersByTimeAsync(100);
    expect(getCurrentTaskId("session-steer")).toBe("task-old");
    expect(mocks.updateModel).not.toHaveBeenCalled();
    expect(mocks.createXYReplyDispatcher).not.toHaveBeenCalled();
    expect(mocks.tryDirectSteer).not.toHaveBeenCalled();

    completeTask("session-steer", "task-old");
    await vi.advanceTimersByTimeAsync(100);
    await pending;
    expect(getCurrentTaskId("session-steer")).toBe("task-new");
    expect(mocks.updateModel).toHaveBeenCalledTimes(1);
    expect(mocks.createXYReplyDispatcher).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: "session-steer", taskId: "task-new", messageId: "message-new",
    }));
    expect(mocks.dispatchReplyFromConfig).toHaveBeenCalledWith(expect.objectContaining({
      ctx: expect.objectContaining({ RawBody: "", MediaPaths: ["/tmp/picture.png"] }),
      cfg: expect.objectContaining({
        messages: { queue: { mode: "followup", byChannel: { "xiaoyi-channel": "followup" } } },
        tools: { media: { image: { enabled: false } } },
      }),
      replyOptions: { images: [image], imageOrder: ["inline"] },
    }));
  });

  it.each(["sdk", "subagent"])("closes only the rejected image task when the %s is still busy", async (busy) => {
    vi.useFakeTimers();
    mocks.loadNativeImages.mockResolvedValue([image]);
    if (busy === "sdk") {
      completeTask("session-steer", "task-old");
      mocks.activeSdkRun.mockReturnValue("sdk-run");
    } else {
      markSubagentSpawned("agent:main:direct:session-steer");
    }

    const pending = handleXYMessage({ cfg: {}, runtime: {}, message: imageMessage, accountId: "default" });
    await vi.advanceTimersByTimeAsync(30_000);
    await pending;

    if (busy === "subagent") {
      expect(getCurrentTaskId("session-steer")).toBe("task-old");
      expect(getWaitState("session-steer", "task-old")?.expectedCompletions).toBe(1);
    }
    expect(mocks.updateModel).not.toHaveBeenCalled();
    expect(mocks.tryDirectSteer).not.toHaveBeenCalled();
    expect(mocks.dispatchReplyFromConfig).not.toHaveBeenCalled();
    expect(mocks.sendStatusUpdate).toHaveBeenLastCalledWith(expect.objectContaining({
      taskId: "task-new", messageId: "message-new", state: "failed",
    }));
    expect(mocks.sendA2AResponse).toHaveBeenCalledTimes(1);
    expect(mocks.sendA2AResponse).toHaveBeenCalledWith(expect.objectContaining({
      taskId: "task-new", messageId: "message-new", final: true,
    }));
  });

  it("reports a failed attachment without replacing the old task or model", async () => {
    mocks.downloadFiles.mockResolvedValueOnce([]);
    await handleXYMessage({ cfg: {}, runtime: {}, message: imageMessage, accountId: "default" });

    expect(mocks.loadNativeImages).not.toHaveBeenCalled();
    expect(mocks.updateModel).not.toHaveBeenCalled();
    expect(mocks.dispatchReplyFromConfig).not.toHaveBeenCalled();
    expect(getCurrentTaskId("session-steer")).toBe("task-old");
    expect(mocks.sendA2AResponse).toHaveBeenCalledTimes(1);
    expect(mocks.sendA2AResponse).toHaveBeenCalledWith(expect.objectContaining({
      taskId: "task-new", messageId: "message-new", final: true,
    }));
  });

});
