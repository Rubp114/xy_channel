// OpenClaw → A2A format conversion
// 纯 A2A 帧构建器：只负责组帧，最后一跳统一走 conversation/outbound-gateway。
import { v4 as uuidv4 } from "uuid";
import { sendWsFrame } from "./conversation/outbound-gateway.js";
import { getOrCreateStreamingTextId, releaseStreamingTextId } from "./utils/streaming-text-id.js";
import { isReasoningFinished as readReasoningFinished, releaseReasoningState } from "./utils/reasoning-state.js";
import { releaseStatusCardSeq, getCurrentStatusCardSeq } from "./utils/status-card-seq.js";
import { logger } from "./utils/logger.js";
import { redactSensitiveText, containsSensitiveInfo } from "./sensitive-redactor.js";
import { rewriteOutboundApprovalText } from "./approval-bridge.js";
import { isCronToolCall, getCurrentCronJobId } from "./tools/session-manager.js";
import { configManager } from "./utils/config-manager.js";
import { getPushIdByJobId } from "./utils/cron-push-map.js";
import { getAllPushIds } from "./utils/pushid-manager.js";
import type {
  XYChannelConfig,
  A2ATaskArtifactUpdateEvent,
  A2ATaskStatusUpdateEvent,
  A2ACommand,
} from "./types.js";

// ─────────────────────────────────────────────────────────────
// 敏感信息脱敏辅助函数
// ─────────────────────────────────────────────────────────────

const MESSAGE_CONTENT_KEYS = new Set(["text", "reasoningText", "content", "message"]);

function redactMessagePayload(value: any, currentKey?: string): any {
  if (value === null || value === undefined) {
    return value;
  }
  if (typeof value === "string") {
    if (currentKey === undefined || MESSAGE_CONTENT_KEYS.has(currentKey)) {
      return redactSensitiveText(value);
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(item => redactMessagePayload(item, currentKey));
  }
  if (typeof value === "object") {
    const result: Record<string, any> = {};
    for (const key of Object.keys(value)) {
      result[key] = redactMessagePayload(value[key], key);
    }
    return result;
  }
  return value;
}

function buildTextPreview(text: string): string {
  if (typeof text !== "string" || text.length === 0) {
    return "";
  }
  return text.length <= 10 ? text : `${text.slice(0, 5)}***${text.slice(-5)}`;
}

/**
 * Parameters for sending an A2A response.
 */
export interface SendA2AResponseParams {
  config: XYChannelConfig;
  sessionId: string;
  taskId: string;
  messageId: string;
  text?: string;
  append: boolean;
  final: boolean;
  /**
   * 标识当前流文本块是否结束（结束=true，可开始下一块）。缺省取 final：
   * 只有正文/思考文本块结束时才允许为 true（正文终帧、分段收尾帧），
   * 任何中间帧不得为 true。分段收尾（rotateStreamingTextSegment）场景
   * 显式传 true。
   */
  lastChunk?: boolean;
  files?: Array<{ fileName: string; fileType: string; fileId: string }>;
  errorCode?: number | string; // 错误码，用于任务执行异常场景
  errorMessage?: string; // 错误描述
  log?: boolean; // 是否打印日志，默认 true
}

/**
 * Send an A2A artifact update response.
 */
export async function sendA2AResponse(params: SendA2AResponseParams): Promise<void> {
  const { config, sessionId, taskId, messageId, text, append, final, files, errorCode, errorMessage, log: shouldLog = true } = params;
  const log = logger.withContext(sessionId, taskId);

  // 审批桥接：将 OpenClaw 的审批提示翻译成用户友好的确认文案
  const bridgedText = text === undefined ? text : rewriteOutboundApprovalText(sessionId, text);

  // Build artifact update event
  // lastChunk 标识当前流文本块是否结束（结束=true，可开始下一块）：仅正文
  // 终帧（final=true）与分段收尾帧（显式传 true）允许为 true，流式进行中的
  // 中间帧一律 false。streamingTextId 为本轮 turn 文本流的独立标识，
  // 同一分段内所有文本帧共享；turn 内 StepInfo 命令下发后会轮换新 id
  // （见 step-info-tool），turn 结束后（final 帧发出）释放，下轮更换新 id。
  const artifact: A2ATaskArtifactUpdateEvent = {
    taskId,
    taskUniqId: taskId,
    taskUniqIndexId: getCurrentStatusCardSeq(taskId),
    kind: "artifact-update",
    isNew: true,
    append,
    lastChunk: params.lastChunk ?? final,
    streamingTextId: getOrCreateStreamingTextId(taskId),
    isReasoningFinished: readReasoningFinished(taskId),
    final,
    artifact: {
      artifactId: uuidv4(),
      parts: [],
    },
  };

  // Add text part (even if empty string, to maintain parts structure)
  if (bridgedText !== undefined) {
    artifact.artifact.parts.push({
      kind: "text",
      text: bridgedText,
    });
  }

  // Add file parts if provided
  if (files && files.length > 0) {
    artifact.artifact.parts.push({
      kind: "data",
      data: { fileInfo: files },
    });
  }

  // 对消息内容字段做敏感信息脱敏，不修改协议层的 id 等字段
  artifact.artifact.parts = redactMessagePayload(artifact.artifact.parts, "parts");

  // Build JSON-RPC response
  const jsonRpcResponse: any = {
    jsonrpc: "2.0",
    id: messageId,
    result: artifact,
  };

  // 🔑 添加 error 字段（仅当提供 errorCode 时）
  if (errorCode !== undefined) {
    jsonRpcResponse.error = {
      code: errorCode,
      message: errorMessage ?? "任务执行异常，请重试",
    };
    log.log(`[A2A_RESPONSE] Including error code: ${errorCode}`);
  }

  // Send via WebSocket（经 outbound-gateway 收口）
  if (shouldLog) {
    const redactedText = redactSensitiveText(bridgedText ?? "");
    log.log(`[A2A_RESPONSE] Sending artifact-update, append=${append}, final=${final}, lastChunk=${artifact.lastChunk}, streamingTextId=${artifact.streamingTextId}, taskUniqIndexId=${artifact.taskUniqIndexId}, isReasoningFinished=${artifact.isReasoningFinished}, text=${buildTextPreview(redactedText)}, files=${files?.length ?? 0}, sensitive=${containsSensitiveInfo(bridgedText ?? "")}`);
  }

  await sendWsFrame({ config, sessionId, taskId, payload: jsonRpcResponse });
  // 终帧（本轮 turn 文本输出完成）发出后释放 streamingTextId、reasoning 状态与
  // 状态卡序号：下轮 turn 生成新 id、reasoning 状态复位为默认 false、
  // taskUniqIndexId 重新从 1 开始
  if (final) {
    releaseStreamingTextId(taskId);
    releaseReasoningState(taskId);
    releaseStatusCardSeq(taskId);
  }
  if (shouldLog) {
    log.log(`[A2A_RESPONSE] Message sent successfully`);
  }
}

/**
 * Parameters for sending a reasoning text update (intermediate, streamed).
 */
export interface SendReasoningTextUpdateParams {
  config: XYChannelConfig;
  sessionId: string;
  taskId: string;
  messageId: string;
  text: string;
  append?: boolean; // defaults to true
  /** 显式覆盖 isReasoningFinished（reasoning 结束标记帧传 true）；缺省读 turn 级状态表。 */
  isReasoningFinished?: boolean;
  /** 标识当前流文本块是否结束。思维链流式中间帧一律 false；仅 reasoning
   *  结束标记帧（onReasoningEnd）传 true。 */
  lastChunk?: boolean;
}

/**
 * Send an A2A artifact-update with reasoningText part.
 * Used for onToolStart, onToolResult, onReasoningStream, onReasoningEnd, onPartialReply.
 * append=true, final=false, lastChunk=false（思维链流式中间帧，非文本块结束标记；
 * reasoning 结束标记帧显式传 lastChunk=true）,
 * text is suffixed with newline for markdown rendering.
 * reasoningText 与正文 text 禁止同帧携带：本函数只组 reasoningText part。
 */
export async function sendReasoningTextUpdate(params: SendReasoningTextUpdateParams): Promise<void> {
  const { config, sessionId, taskId, messageId, text, append = true } = params;
  const log = logger.withContext(sessionId, taskId);

  // 审批桥接
  const bridgedText = rewriteOutboundApprovalText(sessionId, text);

  const artifact: A2ATaskArtifactUpdateEvent = {
    taskId,
    taskUniqId: taskId,
    taskUniqIndexId: getCurrentStatusCardSeq(taskId),
    kind: "artifact-update",
    isNew: true,
    append,
    lastChunk: params.lastChunk ?? false,
    final: false,
    streamingTextId: getOrCreateStreamingTextId(taskId),
    isReasoningFinished: params.isReasoningFinished ?? readReasoningFinished(taskId),
    artifact: {
      artifactId: uuidv4(),
      parts: [
        {
          kind: "reasoningText",
          reasoningText: bridgedText,
        },
      ],
    },
  };

  // 对消息内容字段做敏感信息脱敏
  artifact.artifact.parts = redactMessagePayload(artifact.artifact.parts, "parts");

  const jsonRpcResponse = {
    jsonrpc: "2.0",
    id: messageId,
    result: artifact,
  };

  await sendWsFrame({ config, sessionId, taskId, payload: jsonRpcResponse });
}

/**
 * Parameters for sending a status update.
 */
export interface SendStatusUpdateParams {
  config: XYChannelConfig;
  sessionId: string;
  taskId: string;
  messageId: string;
  text: string;
  state: "submitted" | "working" | "input-required" | "completed" | "canceled" | "failed" | "unknown";
}

/**
 * Send an A2A task status update.
 * Follows A2A protocol standard format with nested status object.
 */
export async function sendStatusUpdate(params: SendStatusUpdateParams): Promise<void> {
  const { config, sessionId, taskId, messageId, text, state } = params;

  const log = logger.withContext(sessionId, taskId);

  // 审批桥接和脱敏
  const bridgedText = rewriteOutboundApprovalText(sessionId, text);
  const redactedText = redactSensitiveText(bridgedText);

  // Build status update event following A2A protocol standard
  const statusMessage = redactMessagePayload({
    role: "agent",
    parts: [
      {
        kind: "text",
        text: bridgedText,
      },
    ],
  });

  const statusUpdate: A2ATaskStatusUpdateEvent = {
    taskId,
    kind: "status-update",
    isNew: true,
    final: false, // Status updates should not end the stream
    status: {
      message: statusMessage,
      state,
    },
  };

  // Build JSON-RPC response
  const jsonRpcResponse = {
    jsonrpc: "2.0",
    id: messageId,
    result: statusUpdate,
  };

  // Log complete response body
  log.log(`[A2A_STATUS] Sending status-update, text="${redactedText}"`);

  await sendWsFrame({ config, sessionId, taskId, payload: jsonRpcResponse });
}

/**
 * Parameters for sending a command.
 */
export interface SendCommandParams {
  config: XYChannelConfig;
  sessionId: string;
  taskId: string;
  messageId: string;
  command?: A2ACommand;
  commands?: A2ACommand[];
  /** toolCallId from the tool's execute() — used for cron detection via hook-set Map. */
  toolCallId?: string;
  /** When true, the artifact-update is sent with final=true. Default: false. */
  final?: boolean;
  /** 标识当前流文本块是否结束。命令帧不携带文本、不是文本块终点，默认 false。 */
  lastChunk?: boolean;
}

/**
 * 解析 cron fire 时应使用的 pushId（多设备路由）。
 *
 * 查询链（逐级回退）：
 *   1. 合成 sessionId → jobId → cron-push-map.json → 创建时记录的设备 pushId
 *   2. configManager 同进程的 sessionId→pushId（进程未重启时兜底）
 *   3. getAllPushIds()[0]（单设备兼容旧行为）
 * 返回 undefined 表示走兜底（由 sendCommandViaPush 内部处理）。
 */
async function resolveCronPushId(
  sessionId: string,
  config: XYChannelConfig,
): Promise<string | undefined> {
  // 1. jobId → 持久化映射
  const jobId = getCurrentCronJobId(sessionId);
  if (jobId) {
    const hit = await getPushIdByJobId(jobId);
    if (hit?.pushId) {
      logger.log(`[CRON-PUSH] Resolved pushId via map, jobId=${jobId}`);
      return hit.pushId;
    }
  }
  // 2. 同进程 configManager 兜底
  const sessionPushId = configManager.getPushId(sessionId);
  if (sessionPushId) {
    logger.log(`[CRON-PUSH] Resolved pushId via configManager (fallback)`);
    return sessionPushId;
  }
  // 3. config.pushId / getAllPushIds()[0] 交给 sendCommandViaPush 内部处理
  void config;
  try {
    const all = await getAllPushIds();
    if (all.length > 0) {
      logger.log(`[CRON-PUSH] Resolved pushId via getAllPushIds[0] (legacy fallback)`);
      return all[0];
    }
  } catch (error) {
    logger.error(`[CRON-PUSH] getAllPushIds failed:`, error);
  }
  return undefined;
}

/**
 * Send a command as an artifact update (final=false).
 *
 * Cron-aware: if the sessionId starts with the cron prefix ("cron-"),
 * the command is delivered through the push channel instead of the
 * WebSocket session, because cron-triggered tool calls have no active
 * WebSocket session.  The device receives the push, executes the command,
 * and returns results through the normal WebSocket path — so response
 * listening in the calling tool works unchanged.
 */
export async function sendCommand(params: SendCommandParams): Promise<void> {
  const { config, sessionId, taskId, messageId, toolCallId } = params;
  const commands = params.commands ?? (params.command ? [params.command] : []);

  if (commands.length === 0) {
    throw new Error("sendCommand requires command or commands.");
  }

  // ── Cron mode: route through push channel ──────────────────────
  // Detected via: (a) sessionId "cron-" prefix from synthetic session, OR
  //               (b) toolCallId marked by before_tool_call hook from openclaw's sessionKey.
  if (sessionId.startsWith("cron-") || isCronToolCall(toolCallId)) {
    const { sendCommandViaPush } = await import("./cron-command.js");
    // 解析正确设备的 pushId：合成 sessionId → jobId → cron-push-map。
    // provider.ts 在 isCron 分支已把 jobId 绑定到该 sessionId。
    const pushId = await resolveCronPushId(sessionId, config);
    return sendCommandViaPush({ config, command: commands[0], pushId });
  }

  // ── Normal mode: WebSocket ─────────────────────────────────────
  const log = logger.withContext(sessionId, taskId);

  // Build artifact update with command as data
  // Wrap command in commands array as per protocol requirement
  // lastChunk 恒 false（命令帧不携带文本，不是文本块终点）
  const artifact: A2ATaskArtifactUpdateEvent = {
    taskId,
    taskUniqId: taskId,
    taskUniqIndexId: getCurrentStatusCardSeq(taskId),
    kind: "artifact-update",
    isNew: true,
    append: false,
    lastChunk: params.lastChunk ?? false,
    final: params.final ?? false,
    streamingTextId: getOrCreateStreamingTextId(taskId),
    isReasoningFinished: readReasoningFinished(taskId),
    artifact: {
      artifactId: uuidv4(),
      parts: [
        {
          kind: "data",
          data: {
            commands,
          },
        },
      ],
    },
  };

  // 对消息内容字段做敏感信息脱敏
  artifact.artifact.parts = redactMessagePayload(artifact.artifact.parts, "parts");

  // Build JSON-RPC response
  const jsonRpcResponse = {
    jsonrpc: "2.0",
    id: messageId,
    result: artifact,
  };

  // Log complete response body
  log.log(`[A2A_COMMAND] Sending command`);
  await sendWsFrame({ config, sessionId, taskId, payload: jsonRpcResponse });
  log.log(`[A2A_COMMAND] Command sent successfully`);
}

/**
 * Parameters for sending a DisplayTaskCardData task progress card.
 */
export interface SendDisplayTaskCardDataParams {
  config: XYChannelConfig;
  sessionId: string;
  taskId: string;
  messageId: string;
  /** toolCallId from the tool's execute() — used for cron detection via hook-set Map. */
  toolCallId?: string;
  /** 卡片序号：配对场景取配套 DisplayExecuteStatusCard 的 taskUniqIndexId；对话轮起始卡固定 1。 */
  index: number;
  /** 卡片展示的步骤名（final 帧固定为"任务处理已完成"）。 */
  stepName: string;
  /** 当前对话轮结束时下发的 final 帧为 true，其余为 false。 */
  isFinal: boolean;
}

/**
 * 下发一条 DisplayTaskCardData 任务进度卡（UserInteraction 命名空间）。
 *
 * 三种下发时机：
 *   1. 对话轮开始：index=1，stepName="任务正在处理中"，isFinal=false（bot.ts）；
 *   2. 每次下发 DisplayExecuteStatusCard 时同步配对一张（顺序在本卡之后——
 *      调用方须先调本函数再发 statusCard），index/taskUniqIndexId 取 statusCard
 *      的 taskUniqIndexId，stepName 取其 text（step-info-tool.ts）；
 *   3. 对话轮结束：isFinal=true，stepName="任务处理已完成"，index 取当前
 *      状态卡序号（未发过卡时为 1，收尾起始卡）。
 */
export async function sendDisplayTaskCardData(params: SendDisplayTaskCardDataParams): Promise<void> {
  const command: A2ACommand = {
    header: { namespace: "UserInteraction", name: "DisplayTaskCardData" },
    payload: {
      index: params.index,
      isDisplayTaskCardData: true,
      isFinal: params.isFinal,
      stepName: params.stepName,
      taskUniqId: params.taskId,
      taskUniqIndexId: params.index,
    },
  };

  await sendCommand({
    config: params.config,
    sessionId: params.sessionId,
    taskId: params.taskId,
    messageId: params.messageId,
    command,
    toolCallId: params.toolCallId,
  });
}

/**
 * Parameters for sending a card (e.g., HTML H5 card).
 */
export interface SendCardParams {
  config: XYChannelConfig;
  sessionId: string;
  taskId: string;
  messageId: string;
  /** toolCallId from the tool's execute() — used for cron detection via hook-set Map. */
  toolCallId?: string;
  /** When true, the artifact-update is sent with final=true. Default: false. */
  final?: boolean;
  /** 标识一段流式文本是否结束。卡片帧不是文本流终点，默认 false。 */
  lastChunk?: boolean;
  /** Array of card data objects to send. */
  cardsInfo: CardDataObject[];
}

/**
 * Card data object for sending display cards.
 */
export interface CardDataObject {
  cardName: string;
  cardData: Record<string, any>;
  displayType: string;
}

/**
 * Send a card (e.g., HTML H5 card) as an artifact update (final=false).
 *
 * Cron-aware: same routing logic as sendCommand.
 */
export async function sendCard(params: SendCardParams): Promise<void> {
  const { config, sessionId, taskId, messageId, toolCallId } = params;

  // ── Cron mode: route through push channel ──────────────────────
  if (sessionId.startsWith("cron-") || isCronToolCall(toolCallId)) {
    throw new Error("sendCard does not support cron mode");
  }

  // ── Normal mode: WebSocket ─────────────────────────────────────
  const log = logger.withContext(sessionId, taskId);

  // Build artifact update with cardsInfo as data
  const artifact: A2ATaskArtifactUpdateEvent = {
    taskId,
    taskUniqId: taskId,
    taskUniqIndexId: getCurrentStatusCardSeq(taskId),
    kind: "artifact-update",
    isNew: true,
    append: false,
    lastChunk: params.lastChunk ?? false,
    final: params.final ?? false,
    streamingTextId: getOrCreateStreamingTextId(taskId),
    isReasoningFinished: readReasoningFinished(taskId),
    artifact: {
      artifactId: uuidv4(),
      parts: [
        {
          kind: "data",
          data: {
            cardsInfo: params.cardsInfo,
          },
        },
      ],
    },
  };

  // Build JSON-RPC response
  const jsonRpcResponse = {
    jsonrpc: "2.0",
    id: messageId,
    result: artifact,
  };

  log.log(`[A2A_CARD] Sending card`);
  await sendWsFrame({ config, sessionId, taskId, payload: jsonRpcResponse });
  log.log(`[A2A_CARD] Card sent successfully`);
}

/**
 * Parameters for sending reference data as an artifact update.
 */
export interface SendReferenceParams {
  config: XYChannelConfig;
  sessionId: string;
  taskId: string;
  messageId: string;
  toolCallId?: string;
  final?: boolean;
  /** 标识一段流式文本是否结束。引用帧不是文本流终点，默认 false。 */
  lastChunk?: boolean;
  references: ReferenceDataItem[];
}

/**
 * Flattened reference data item. The sendReference function transforms
 * these into the nested ReferenceDataObject structure expected by the client.
 */
export interface ReferenceDataItem {
  /** Site name for tracking, e.g. "百度百科" */
  name: string;
  /** Source type, e.g. "web_search", "document", "knowledge_base" */
  source: string;
  /** Page title displayed on the card */
  title: string;
  /** Page URL for navigation */
  url: string;
  /** Optional site logo URL */
  imageUrl?: string;
}

/**
 * Send reference/citation data as an artifact update (final=false).
 *
 * Follows the same pattern as sendCard: builds a data part with the
 * "reference" key containing ReferenceDataObject items, wraps in JSON-RPC,
 * and sends via WebSocket.
 */
export async function sendReference(params: SendReferenceParams): Promise<void> {
  const { config, sessionId, taskId, messageId, toolCallId } = params;

  // Cron mode not supported
  if (sessionId.startsWith("cron-") || isCronToolCall(toolCallId)) {
    throw new Error("sendReference does not support cron mode");
  }

  const log = logger.withContext(sessionId, taskId);

  // Transform flattened ReferenceDataItem[] into nested ReferenceDataObject
  const referenceItems = params.references.map((item) => ({
    params: {
      name: item.name,
      source: item.source,
    },
    card: {
      type: "leftPictureRightText",
      params: {
        title: item.title,
        subTitle: item.name,
        link: {
          webLink: {
            startMode: 0,
            url: item.url,
          },
        },
        ...(item.imageUrl ? { imageInfo: { small: { url: item.imageUrl } } } : {}),
      },
    },
  }));

  const reference = {
    items: referenceItems,
  };

  // Build artifact update with reference as data
  const artifact: A2ATaskArtifactUpdateEvent = {
    taskId,
    taskUniqId: taskId,
    taskUniqIndexId: getCurrentStatusCardSeq(taskId),
    kind: "artifact-update",
    isNew: true,
    append: false,
    lastChunk: params.lastChunk ?? false,
    final: params.final ?? false,
    streamingTextId: getOrCreateStreamingTextId(taskId),
    isReasoningFinished: readReasoningFinished(taskId),
    artifact: {
      artifactId: uuidv4(),
      parts: [
        {
          kind: "data",
          data: { reference },
        },
      ],
    },
  };

  // Build JSON-RPC response
  const jsonRpcResponse = {
    jsonrpc: "2.0",
    id: messageId,
    result: artifact,
  };

  log.log(`[A2A_REFERENCE] Sending reference, items=${referenceItems.length}`);
  await sendWsFrame({ config, sessionId, taskId, payload: jsonRpcResponse });
  log.log(`[A2A_REFERENCE] Reference sent successfully`);
}

/**
 * Parameters for sending a clearContext response.
 */
export interface SendClearContextResponseParams {
  config: XYChannelConfig;
  sessionId: string;
  messageId: string;
}

/**
 * Send a clearContext response.
 */
export async function sendClearContextResponse(params: SendClearContextResponseParams): Promise<void> {
  const { config, sessionId, messageId } = params;
  const log = logger.withContext(sessionId, "");


  // Build JSON-RPC response for clearContext
  const jsonRpcResponse = {
    jsonrpc: "2.0",
    id: messageId,
    result: {
      status: {
        state: "cleared",
      },
    },
    error: {
      code: 0,
  // Note: Using any to bypass type check as the response format differs from standard A2A types
      message: "",
    },
  };

  // Send via WebSocket（clearContext 使用 sessionId 作为 taskId）
  await sendWsFrame({ config, sessionId, taskId: sessionId, payload: jsonRpcResponse });
  log.log(`[CLEAR_CONTEXT] Sent clearContext response`);
}

/**
 * Parameters for sending a tasks/cancel response.
 */
export interface SendTasksCancelResponseParams {
  config: XYChannelConfig;
  sessionId: string;
  taskId: string;
  messageId: string;
}

/**
 * Send a tasks/cancel response.
 */
export async function sendTasksCancelResponse(params: SendTasksCancelResponseParams): Promise<void> {
  const { config, sessionId, taskId, messageId } = params;
  const log = logger.withContext(sessionId, taskId);


  // Build JSON-RPC response for tasks/cancel
  // Note: Using any to bypass type check as the response format differs from standard A2A types
  const jsonRpcResponse = {
    jsonrpc: "2.0",
    id: messageId,
    result: {
      id: taskId,
      status: {
        state: "canceled",
      },
    },
    error: {
      code: 0,
      message: "",
    },
  };

  await sendWsFrame({ config, sessionId, taskId, payload: jsonRpcResponse });
  log.log(`[TASKS_CANCEL] Sent tasks/cancel response`);
}

/**
 * Parameters for sending a Trigger response.
 */
export interface SendTriggerResponseParams {
  config: XYChannelConfig;
  sessionId: string;
  taskId: string;
  messageId: string;
  content: string;
}

/**
 * Send a Trigger response with pushData content.
 */
export async function sendTriggerResponse(params: SendTriggerResponseParams): Promise<void> {
  const { config, sessionId, taskId, messageId, content } = params;
  const log = logger.withContext(sessionId, taskId);

  // 审批桥接和脱敏
  const bridgedContent = rewriteOutboundApprovalText(sessionId, content);
  const redactedContent = redactSensitiveText(bridgedContent);

  // 对消息内容做敏感信息脱敏
  const artifactParts = redactMessagePayload([
    {
      kind: "text",
      text: bridgedContent,
    },
  ], "parts");

  // Build JSON-RPC response for Trigger
  const jsonRpcResponse = {
    jsonrpc: "2.0",
    id: messageId,
    result: {
      taskId: taskId,
      taskUniqId: taskId,
      taskUniqIndexId: getCurrentStatusCardSeq(taskId),
      kind: "artifact-update",
      isNew: true,
      append: false,
      lastChunk: false,
      final: true,
      streamingTextId: getOrCreateStreamingTextId(taskId),
      isReasoningFinished: readReasoningFinished(taskId),
      artifact: {
        artifactId: uuidv4(),
        parts: artifactParts,
      },
    },
    error: {
      code: 0,
      message: "",
    },
  };

  log.log(`[TRIGGER_RESPONSE] Sending Trigger response, text=${buildTextPreview(redactedContent)}`);
  await sendWsFrame({ config, sessionId, taskId, payload: jsonRpcResponse });
  // Trigger 帧 final=true：与 sendA2AResponse 终帧同样释放本 turn 的状态
  releaseStreamingTextId(taskId);
  releaseReasoningState(taskId);
  releaseStatusCardSeq(taskId);
  log.log(`[TRIGGER_RESPONSE] Trigger response sent successfully`);
}
