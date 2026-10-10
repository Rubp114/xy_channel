// debug-commands.ts — DEBUG 专用：收到任意 A2A 消息即下行固定 command 列表
//
// ⚠️ 仅用于调试端上 command 的渲染/行为。上线前把 DEBUG_COMMANDS_ENABLED
//    置为 false（或把 DEBUG_COMMANDS 清空），即完全关闭、零开销。
//
// 用法：在下方 DEBUG_COMMANDS 数组里填要下发的 command，可塞多个——一帧
// artifact-update 的 data.commands 全部带下去。每收到一条 A2A 消息
// （message/send、tasks/cancel、clearContext 等）都会原样下发一遍。
//
// 注意：
// - 下发时机是「收到消息立刻发」，先于模型的正常响应；
// - 帧的 JSON-RPC id 用的是入站消息的 id（与正常 command 下发同口径）；
// - fire-and-forget：失败只打日志，绝不影响消息的正常处理流程。

import { sendCommand } from "./formatter.js";
import { resolveXYConfig } from "./config.js";
import { logger } from "./utils/logger.js";
import type { A2ACommand, A2AJsonRpcRequest } from "./types.js";

const LOG_TAG = "[DEBUG-CMD]";

// ─── 开关 ──────────────────────────────────────────────────────────
/** true=开启 debug 下行；false=完全关闭（收到消息什么也不做）。 */
const DEBUG_COMMANDS_ENABLED = true;

// ─── 👇👇👇 在这里填要下行的 command（数组，可塞多个） 👇👇👇 ──────────
const DEBUG_COMMANDS: A2ACommand[] = [
  {
    header: { namespace: "UserInteraction", name: "DisplayTaskCardData" },
    payload: {
      index: 1,
      isDisplayTaskCardData: true,
      isFinal: true,
      stepName: "查看技能 xiaoyi-report-win",
      taskUniqId: "12345678901",
      taskUniqIndexId: 1
    },
  },
  {
    header: {namespace: "UserInteraction", name: "DisplayStreamingText"},
    payload: {
      isStart: true,
      isFinal: false,
      reasoningText: "用户想生成一个美国国债报告。这是一个研究/调研报告类任务。让我看看可用的技能。",
      streamingText: "",
      streamingTextId: "11111111111111111111",
    }
  },
  {
    header: {namespace: "UserInteraction", name: "DisplayStreamingText"},
    payload: {
      isStart: false,
      isFinal: true,
      reasoningText: "用户想生成一个美国国债报告。这是一个研究/调研报告类任务。让我看看可用的技能。",
      streamingText: "",
      streamingTextId: "11111111111111111111",
    }
  },
  {
    header: {namespace: "UserInteraction", name: "DisplayStreamingText"},
    payload: {
      contextText: "我来帮你生成一份美国国债报告。先加载相关技能并了解工作流。",
      isStart: true,
      isFinal: false,
      streamingText: "我来帮你生成一份美国国债报告。先加载相关技能并了解工作流。",
      streamingTextId: "222222222222222222222",
    }
  },
  {
    header: {namespace: "UserInteraction", name: "DisplayStreamingText"},
    payload: {
      contextText: "我来帮你生成一份美国国债报告。先加载相关技能并了解工作流。",
      isStart: false,
      isFinal: true,
      streamingText: "我来帮你生成一份美国国债报告。先加载相关技能并了解工作流。",
      streamingTextId: "222222222222222222222",
    }
  },
  {
    header: { namespace: "UserInteraction", name: "DisplayTaskCardData" },
    payload: {
      icon: "",
      index: 1,
      isDisplayTaskCardData: true,
      isFinal: true,
      stepName: "查看技能 xiaoyi-report-win",
      taskUniqId: "12345678902",
      taskUniqIndexId: 1
    },
  },
  {
    header: { namespace: "UserInteraction", name: "DisplayTaskCardData" },
    payload: {
      icon: "",
      index: 1,
      isDisplayTaskCardData: true,
      isFinal: true,
      stepName: "查看技能 xiaoyi-web-search-win",
      taskUniqId: "12345678903",
      taskUniqIndexId: 1
    },
  },
  {
    header: {namespace: "UserInteraction", name: "DisplayStreamingText"},
    payload: {
      contextText: "我已阅读报告生成工作流。现在规划研究维度并开始信息搜集。让我先确认一下搜索技能的使用方式。",
      isStart: true,
      isFinal: false,
      streamingText: "我已阅读报告生成工作流。现在规划研究维度并开始信息搜集。让我先确认一下搜索技能的使用方式。",
      streamingTextId: "333333333333333333333333",
    }
  },
  {
    header: {namespace: "UserInteraction", name: "DisplayStreamingText"},
    payload: {
      contextText: "我已阅读报告生成工作流。现在规划研究维度并开始信息搜集。让我先确认一下搜索技能的使用方式。",
      isStart: false,
      isFinal: true,
      streamingText: "我已阅读报告生成工作流。现在规划研究维度并开始信息搜集。让我先确认一下搜索技能的使用方式。",
      streamingTextId: "333333333333333333333333",
    }
  },
];
// ─── 👆👆👆 填 command 区域结束 👆👆👆 ──────────────────────────────

/**
 * 宽容地从入站消息提取路由字段（不用 parseA2AMessage——tasks/cancel、
 * clearContext 等没有 params.message，会抛错；它们的 sessionId 在消息顶层）。
 * 缺 sessionId 时无法路由，跳过。
 */
function extractRouteFields(
  message: A2AJsonRpcRequest,
): { sessionId: string; taskId: string; messageId: string } | null {
  const params = message.params;
  const sessionId =
    typeof params?.sessionId === "string" && params.sessionId
      ? params.sessionId
      : typeof message.sessionId === "string" && message.sessionId
        ? message.sessionId
        : "";
  if (!sessionId) return null;

  const messageId = String(message.id ?? "");
  const taskId =
    typeof params?.id === "string" && params.id ? params.id : messageId;
  return { sessionId, taskId, messageId };
}

/**
 * 收到任意 A2A 消息时调用：开启且非空则把 DEBUG_COMMANDS 一帧发下去。
 * fire-and-forget，永不抛错。
 */
export function maybeSendDebugCommands(
  message: A2AJsonRpcRequest,
  cfg: unknown,
): void {
  if (!DEBUG_COMMANDS_ENABLED || DEBUG_COMMANDS.length === 0) return;

  void (async () => {
    const route = extractRouteFields(message);
    if (!route) {
      logger.log(
        `${LOG_TAG} skip: no sessionId in message, method=${message.method}`,
      );
      return;
    }

    await sendCommand({
      config: resolveXYConfig(cfg as any),
      sessionId: route.sessionId,
      taskId: route.taskId,
      messageId: route.messageId,
      commands: DEBUG_COMMANDS,
    });

    logger.log(
      `${LOG_TAG} sent ${DEBUG_COMMANDS.length} debug command(s), sessionId=${route.sessionId}, method=${message.method}`,
    );
  })().catch((err) => {
    logger.error(`${LOG_TAG} send failed:`, err);
  });
}
