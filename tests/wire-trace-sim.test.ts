import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── 帧捕获 mocks：主 formatter(高版本)与 legacy formatter(低版本) ──
const mocks = vi.hoisted(() => ({
  createDispatcher: vi.fn(),
  sendA2AResponse: vi.fn(),
  sendStatusUpdate: vi.fn(),
  sendReasoningTextUpdate: vi.fn(),
  sendCommand: vi.fn(),
  sendExecuteStatusCard: vi.fn(),
  sendDisplayTaskCardData: vi.fn(),
  sendFileArtifacts: vi.fn(),
  legacy: {
    sendA2AResponse: vi.fn(),
    sendStatusUpdate: vi.fn(),
    sendReasoningTextUpdate: vi.fn(),
    sendCommand: vi.fn(),
  },
  log: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

vi.mock("../src/runtime.js", () => ({
  getXYRuntime: () => ({
    channel: {
      reply: {
        createReplyDispatcherWithTyping: mocks.createDispatcher,
        resolveHumanDelayConfig: () => undefined,
      },
    },
  }),
}));
vi.mock("../src/config.js", () => ({ resolveXYConfig: () => ({ terminalFrameDelayMs: 0 }) }));
vi.mock("../src/formatter.js", () => ({
  sendA2AResponse: mocks.sendA2AResponse,
  sendStatusUpdate: mocks.sendStatusUpdate,
  sendReasoningTextUpdate: mocks.sendReasoningTextUpdate,
  sendCommand: mocks.sendCommand,
  sendExecuteStatusCard: mocks.sendExecuteStatusCard,
  sendDisplayTaskCardData: mocks.sendDisplayTaskCardData,
  sendFileArtifacts: mocks.sendFileArtifacts,
}));
vi.mock("../src/legacy/formatter.js", () => ({
  sendA2AResponse: mocks.legacy.sendA2AResponse,
  sendStatusUpdate: mocks.legacy.sendStatusUpdate,
  sendReasoningTextUpdate: mocks.legacy.sendReasoningTextUpdate,
  sendCommand: mocks.legacy.sendCommand,
}));
vi.mock("../src/tools/session-manager.js", () => ({
  clearRunCrossTaskSentFiles: vi.fn(),
  getCurrentSessionContext: () => undefined,
}));
vi.mock("../src/utils/logger.js", () => ({
  logger: {
    withContext: () => ({ log: mocks.log, warn: mocks.warn, error: mocks.error }),
    log: mocks.log,
    warn: mocks.warn,
    error: mocks.error,
  },
}));

import { createXYReplyDispatcher } from "../src/dispatch/reply-dispatcher.js";
import { createLegacyReplyDispatcher } from "../src/legacy/reply-dispatcher.js";
import {
  bindSessionKey,
  cacheXYConfig,
  deleteSession,
  getOrCreateSession,
  listSessions,
  markTurnInflight,
  registerTask,
  startStatusHeartbeat,
  stopStatusHeartbeat,
} from "../src/conversation/conversation-manager.js";
import { startLegacyStatusHeartbeat, stopLegacyStatusHeartbeat } from "../src/legacy/keepalive.js";
import { markAppVersion, isLegacyAppVersion } from "../src/utils/app-version.js";
import { registerToolStatusHook } from "../src/tool-status-hook.js";
import { registerStepInfoHook } from "../src/tools/step-info-tool.js";
import { sendDisplayTaskCardData as realCardSend } from "../src/formatter.js";

const SESSION_KEY = "agent:main:direct:sess-wire";

function mockFactory() {
  mocks.createDispatcher.mockImplementation((options) => ({
    dispatcher: options,
    replyOptions: options,
    markDispatchIdle: vi.fn(),
  }));
}

interface Frame { seq: number; kind: string; summary: string; }

function collectHigh(): Frame[] {
  const orderOf = (fn: any) => fn.mock.invocationCallOrder;
  const rows: Frame[] = [];
  const push = (fn: any, kind: string, fn2: (p: any) => string) => {
    fn.mock.calls.forEach(([p]: any, i: number) => rows.push({ seq: orderOf(fn)[i], kind, summary: fn2(p) }));
  };
  push(mocks.sendDisplayTaskCardData, "DisplayTaskCardData", (p) => `index=${p.index} stepName="${p.stepName}" isFinal=${p.isFinal}`);
  push(mocks.sendStatusUpdate, "status-update", (p) => `state=${p.state} text="${String(p.text).slice(0, 18)}" sid=${p.streamingTextId ?? "-"}`);
  push(mocks.sendReasoningTextUpdate, "reasoningText", (p) => `text="${String(p.text).slice(0, 14)}" append=${p.append} reasonFin=${p.isReasoningFinished ?? "-"} sid=${p.streamingTextId ?? "-"}`);
  push(mocks.sendA2AResponse, "artifact-update(正文)", (p) => `text="${String(p.text).slice(0, 14)}" append=${p.append} final=${p.final} lastChunk=${p.lastChunk ?? "-"} sid=${p.streamingTextId ?? "-"}`);
  push(mocks.sendExecuteStatusCard, "DisplayExecuteStatusCard", (p) => `step="${String(p.text ?? p.stepName ?? "").slice(0, 16)}" symbol=${p.symbolName ?? "-"}`);
  push(mocks.sendCommand, "command(StepInfo等)", (p) => `${JSON.stringify(p).slice(0, 60)}`);
  return rows.sort((a, b) => a.seq - b.seq).map((r, i) => ({ ...r, seq: i + 1 }));
}

function collectLow(): Frame[] {
  const orderOf = (fn: any) => fn.mock.invocationCallOrder;
  const rows: Frame[] = [];
  const push = (fn: any, kind: string, fn2: (p: any) => string) => {
    fn.mock.calls.forEach(([p]: any, i: number) => rows.push({ seq: orderOf(fn)[i], kind, summary: fn2(p) }));
  };
  push(mocks.legacy.sendStatusUpdate, "status-update(legacy)", (p) => `state=${p.state} text="${String(p.text).slice(0, 18)}"`);
  push(mocks.legacy.sendReasoningTextUpdate, "reasoningText(legacy)", (p) => `text="${String(p.text).slice(0, 14)}" append=${p.append}`);
  push(mocks.legacy.sendA2AResponse, "artifact-update(legacy 正文)", (p) => `text="${String(p.text).slice(0, 14)}" append=${p.append} final=${p.final}`);
  push(mocks.legacy.sendCommand, "command(legacy)", (p) => `${JSON.stringify(p).slice(0, 60)}`);
  return rows.sort((a, b) => a.seq - b.seq).map((r, i) => ({ ...r, seq: i + 1 }));
}

function printTrace(title: string, rows: Frame[]): string {
  const lines = rows.map((r) => `| ${r.seq} | ${r.kind} | ${r.summary} |`);
  return `\n### ${title}\n\n| # | 帧类型 | 关键字段 |\n|---|---|---|\n${lines.join("\n")}\n`;
}

describe("高低版本 A2A 流帧轨迹模拟（同一脚本化 turn 走两条链路）", () => {
  beforeEach(() => {
    mockFactory();
    vi.clearAllMocks();
    mockFactory();
    for (const f of [mocks.sendA2AResponse, mocks.sendStatusUpdate, mocks.sendReasoningTextUpdate, mocks.sendCommand, mocks.sendExecuteStatusCard, mocks.sendDisplayTaskCardData, mocks.legacy.sendA2AResponse, mocks.legacy.sendStatusUpdate, mocks.legacy.sendReasoningTextUpdate, mocks.legacy.sendCommand]) {
      f.mockResolvedValue(undefined);
    }
  });
  afterEach(() => {
    for (const s of listSessions()) deleteSession(s.sessionId);
  });

  it("HIGH 高版本(app_ver=11.7.10.300)完整 turn 帧轨迹", async () => {
    const sessionId = "sess-wire";
    const taskId = "task-wire-high";
    const messageId = "msg-wire-high";
    markAppVersion(taskId, "11.7.10.300");
    registerTask(sessionId, taskId, messageId);
    bindSessionKey(SESSION_KEY, sessionId, taskId, messageId);
    cacheXYConfig({} as any);
    expect(isLegacyAppVersion(taskId)).toBe(false);

    const trace: Frame[] = [];
    let seq = 0;
    // ── ① 入站起始卡(bot.ts 准入后发卡块,高版本分支) ──
    trace.push({ seq: ++seq, kind: "DisplayTaskCardData(起始卡)", summary: `index=1 stepName="任务正在处理中" isFinal=false [经会话出站队列]` });

    // ── ② 创建主流 dispatcher ──
    const turn = createXYReplyDispatcher({ cfg: {}, runtime: { error: mocks.error }, sessionId, taskId, messageId, accountId: "default" });
    markTurnInflight(sessionId, taskId);

    // ── ③ 思考流(SDK 全量快照,增量下发) ──
    await turn.replyOptions.onReasoningStream({ text: "先分析需求" });
    await turn.replyOptions.onReasoningStream({ text: "先分析需求，再整理步骤" });
    await turn.replyOptions.onReasoningEnd();

    // ── ④ 工具调用：状态卡 + StepInfo(经 hook,非 legacy 不抑制) ──
    const handlers: Record<string, Function[]> = {};
    const api = { on: (ev: string, fn: Function) => { (handlers[ev] ??= []).push(fn); }, config: {} } as any;
    registerToolStatusHook(api);
    registerStepInfoHook(api);
    for (const fn of handlers["before_tool_call"] ?? []) await fn({ toolName: "create_note", params: { title: "买菜" } }, { sessionKey: SESSION_KEY });

    // ── ⑤ 正文流(append 快照) ──
    await turn.replyOptions.onPartialReply({ text: "好的，" });
    await turn.replyOptions.onPartialReply({ text: "好的，已为你创建" });

    // ── ⑥ 30s 保活卡(manager 心跳,turn 进行中演示一个 tick) ──
    vi.useFakeTimers();
    startStatusHeartbeat(sessionId);
    await vi.advanceTimersByTimeAsync(30_000);
    stopStatusHeartbeat(sessionId);
    vi.useRealTimers();

    // ── ⑦ 终态序列 ──
    await turn.dispatcher.deliver({ text: "好的，已为你创建备忘录。" }, { kind: "final" });
    await turn.dispatcher.onIdle();
    await getOrCreateSession(sessionId).outboundQueue.whenIdle();

    await getOrCreateSession(sessionId).outboundQueue.whenIdle();
    const frames = collectHigh();
    trace.push(...frames.map((f) => ({ ...f, seq: 0 })));
    console.log(printTrace("高版本(app_ver=11.7.10.300)帧轨迹 —— 思考→工具→正文→终态→保活", trace.slice(1).concat([trace[0]]).map((f, i) => ({ ...f, seq: i + 1 })).sort((a, b) => {
      // 起始卡放最前,其余按捕获顺序
      if (a.kind.startsWith("DisplayTaskCardData(起始卡)")) return -1;
      if (b.kind.startsWith("DisplayTaskCardData(起始卡)")) return 1;
      return a.seq - b.seq;
    })));
    expect(frames.length).toBeGreaterThan(0);
  });

  it("LOW 低版本(app_ver=11.7.10.100)完整 turn 帧轨迹", async () => {
    const sessionId = "sess-wire";
    const taskId = "task-wire-low";
    const messageId = "msg-wire-low";
    markAppVersion(taskId, "11.7.10.100");
    registerTask(sessionId, taskId, messageId);
    bindSessionKey(SESSION_KEY, sessionId, taskId, messageId);
    cacheXYConfig({} as any);
    expect(isLegacyAppVersion(taskId)).toBe(true);

    const trace: Frame[] = [];
    let seq = 0;
    // ── ① 入站初始 status-update(bot.ts 准入后发卡块,低版本分支直发) ──
    trace.push({ seq: ++seq, kind: "status-update(legacy 初始)", summary: `state=working text="任务正在处理中，请稍候~" [直发,无 envelope 字段]` });

    // ── ② 创建 legacy dispatcher ──
    const turn = createLegacyReplyDispatcher({ cfg: {}, runtime: { error: mocks.error }, sessionId, taskId, messageId, accountId: "default" });
    markTurnInflight(sessionId, taskId);

    // ── ③ 思考流(增量) ──
    await turn.replyOptions.onReasoningStream({ text: "先分析需求" });
    await turn.replyOptions.onReasoningStream({ text: "先分析需求，再整理步骤" });

    // ── ④ 工具调用(legacy onToolStart 状态帧,挂在返回的 replyOptions 上) ──
    await turn.replyOptions.onToolStart?.({ name: "create_note", phase: "start" });
    await turn.replyOptions.onToolResult?.({ text: "已创建" });

    // ── ⑤ 正文流(增量 append) ──
    await turn.replyOptions.onPartialReply({ text: "好的，" });
    await turn.replyOptions.onPartialReply({ text: "好的，已为你创建" });

    // ── ⑥ 终态序列 ──
    await turn.dispatcher.deliver({ text: "好的，已为你创建备忘录。" }, { kind: "final" });
    await turn.dispatcher.onIdle();
    await getOrCreateSession(sessionId).outboundQueue.whenIdle();

    // ── ⑦ 30s 保活 status-update(legacy 心跳,演示一个 tick) ──
    vi.useFakeTimers();
    startLegacyStatusHeartbeat(sessionId);
    await vi.advanceTimersByTimeAsync(30_000);
    stopLegacyStatusHeartbeat(sessionId);
    vi.useRealTimers();

    await getOrCreateSession(sessionId).outboundQueue.whenIdle();
    const frames = collectLow();
    trace.push(...frames.map((f) => ({ ...f, seq: 0 })));
    console.log(printTrace("低版本(app_ver=11.7.10.100)帧轨迹 —— 思考→工具→正文→终态→保活", trace.slice(1).concat([trace[0]]).map((f, i) => ({ ...f, seq: i + 1 })).sort((a, b) => {
      if (a.kind.startsWith("status-update(legacy 初始)")) return -1;
      if (b.kind.startsWith("status-update(legacy 初始)")) return 1;
      return a.seq - b.seq;
    })));
    expect(frames.length).toBeGreaterThan(0);
  });
});
