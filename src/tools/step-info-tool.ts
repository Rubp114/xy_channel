// step-info-tool — 文本分段边界 + 任务卡片（before/after_tool_call 钩子）
//
// 两个能力合并在本模块（原 skill-tool 已并入）：
//
// 1) 文本分段边界：分类内工具调用（before_tool_call）与返回（after_tool_call）
//    时轮换本 turn 的 streamingTextId 并切分流式装配器
//    （conversation-manager.rotateStreamingTextSegment）：边界前的旧段以
//    lastChunk=true 收尾帧结束、并标记 thinkIndex 待下发值，边界后的文本帧
//    使用新 id，且新 id 帧不叠加旧段文本。
//    （原 Common/StepInfo 命令已移除，只保留分段边界本身。）
//    - displayName 按分类映射（网页搜索/运行命令/文件创建/编辑文件/读取文件/
//      查找文件/分析图片/生成图片/生成音乐/生成视频/下载文件）
//    - 「使用工具」白名单（update_plan/canvas/tool_search 等）无分段边界，见 2)
//
// 2) 执行状态卡命令（namespace=UserInteraction, name=DisplayExecuteStatusCard）：
//    payload={ text, isFinal:true, taskUniqId:taskId,
//              taskUniqIndexId:本轮对话内状态卡序号(按taskId从1递增) }
//    每次下发时同步配对一张 DisplayTaskCardData（顺序在 statusCard 之前，
//    index/taskUniqIndexId 取状态卡序号，stepName 取状态卡 text）；
//    对话轮开始/结束时的 DisplayTaskCardData 起始卡与 final 卡见
//    formatter.sendDisplayTaskCardData 的文档。
//    - 技能通知：模型 cd 进技能目录或读技能 SKILL.md 时下发
//        cd 进技能目录 → text=使用技能 <skillName>
//        读 SKILL.md    → text=查看技能 <skillName>（同命令内 cd+读 md 判为查看）
//        合并去重：read 工具读 SKILL.md 时只发技能卡片，不再做「读取文件」
//        分段边界；read 普通文件只做分段边界。
//        exec 命令命中技能检测时，技能卡片与分段边界并存。
//    - 「使用工具」白名单工具：只在调用前下发一次卡片（text=displayName），
//      after 侧无动作。
//    - update_plan 计划步骤：除「使用工具」卡片外，plan 中 status=in_progress
//      的步骤也各下发一张卡片（text=步骤文本，同轮多张卡片由
//      taskUniqIndexId 序号区分）。
//
// 仅处理分类内工具；未映射工具（cron、sessions_* 系列、subagents、
// memory_* 系列、tts 等其余 general 工具与全部端工具）静默跳过。
// 命令经 formatter.sendCommand 下发，路由与 channel 其它命令一致：
// 普通对话 WS、cron run push 通道。
//
// 状态更新帧（tool-status-hook 的「正在使用工具：xxx」status-update）不在本模块，
// 保持不变。
//
// 钩子体全 try/catch：before_tool_call 抛错会 block 工具执行，
// 命令下发失败绝不能影响工具本身。

import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { sendCommand, sendDisplayTaskCardData } from "../formatter.js";
import {
  resolveBySessionKey,
  getCachedXYConfig,
  rotateStreamingTextSegment,
} from "../conversation/conversation-manager.js";
import {
  getCurrentSessionContext,
  isCronToolCall,
  getCronToolRunInfo,
} from "./session-manager.js";
import { logger } from "../utils/logger.js";
import { nextStatusCardSeq } from "../utils/status-card-seq.js";
import { takePendingThinkIndex } from "../utils/think-index.js";
import type { A2ACommand, XYChannelConfig } from "../types.js";

const LOG_TAG = "[STEP-INFO]";

/**
 * displayName 分类映射（保留自工具分类整理结论）。
 *
 * - Web: 网页搜索;Command: 运行命令;File-create: 文件创建;File-edit: 编辑文件
 * - File-read: 读取文件;File-search: 查找文件(当前无工具);image: 分析图片
 *   (image_generate: 生成图片);music: 生成音乐;video: 生成视频
 * - download: 下载文件(当前无工具);general: 使用工具(仅下列白名单)
 *
 * general 白名单外（cron、gateway、nodes、message、heartbeat_respond、
 * sessions_* 系列、subagents、session_status、memory_* 系列、tts）
 * 与全部端工具不下发命令。
 *
 * displayName="使用工具" 的白名单工具不做分段边界，改为下发
 * DisplayExecuteStatusCard 执行状态卡（见 TASK_CARD_TOOLS）。
 */
const DISPLAY_BY_TOOL: Record<string, string> = {
  // Web
  web_search: "网页搜索",
  x_search: "网页搜索",
  web_fetch: "网页搜索",
  browser: "网页搜索",
  // Command（bash 为 exec 别名）
  exec: "运行命令",
  bash: "运行命令",
  process: "运行命令",
  code_execution: "运行命令",
  // File-create
  write: "文件创建",
  skill_workshop: "文件创建",
  save_self_evolution_skill: "文件创建",
  // File-edit
  edit: "编辑文件",
  apply_patch: "编辑文件",
  // File-read
  read: "读取文件",
  // Image
  image: "分析图片",
  image_generate: "生成图片",
  // Music / Video
  music_generate: "生成音乐",
  video_generate: "生成视频",
  // General 白名单
  tool_search: "使用工具",
  tool_search_code: "使用工具",
  tool_describe: "使用工具",
  update_plan: "使用工具",
  agents_list: "使用工具",
  convert_timestamp_to_utc8_time: "使用工具",
  view_push_result: "使用工具",
  send_file_to_user: "使用工具",
  canvas: "使用工具",
};

/**
 * 「使用工具」白名单工具集合（DISPLAY_BY_TOOL 中 displayName="使用工具" 的项）。
 * 这类工具不发执行状态卡、不做文本分段边界；update_plan 例外保留
 * in_progress 步骤卡（before_tool_call 时下发）。
 */
const TASK_CARD_TOOLS: Set<string> = new Set(
  Object.keys(DISPLAY_BY_TOOL).filter((t) => DISPLAY_BY_TOOL[t] === "使用工具"),
);

/**
 * 工具状态卡触发表：仅表内工具的调用会触发 DisplayExecuteStatusCard
 * （tool-status-hook 的调用前卡与 reply-dispatcher onToolResult 的结果卡）；
 * 表外工具一律不触发。text 为卡片展示文案，symbolName 为卡片图标
 * （协议侧未给图标的端工具省略该字段）。
 *
 * 注意三个键以 openclaw 实际注册名为准（与协议侧给的名字不同）：
 *   upload-file → upload_file；send-file-to-user → send_file_to_user；
 *   run_subagent → subagents。
 * create_alarm 协议侧未给文案/图标，text 回退为工具名。
 */
export const TOOL_STATUS_CARD_META: Record<string, { symbolName?: string; text?: string }> = {
  web_search: { symbolName: "magnifyingglass", text: "网页搜索" },
  web_fetch: { symbolName: "pc_ic_tab_index_1", text: "网页抓取" },
  subagents: { symbolName: "arrow_triangle_divide", text: "启动子任务" },
  read: { symbolName: "doc_text_badge_magnifyingglass", text: "文件读取" },
  write: { symbolName: "folder_badge_arrow_left", text: "文件写入" },
  edit: { symbolName: "doc_plaintext_and_pencil", text: "文件编辑" },
  bash: { symbolName: "code_square", text: "执行命令" },
  exec: { symbolName: "wired_projection", text: "CLI工具" },
  invoke: { symbolName: "code_1", text: "API工具" },
  upload_file: { symbolName: "electric_install", text: "上传到远程设备" },
  send_file_to_user: { symbolName: "electric_install", text: "从远程设备下载" },
  create_calendar_event: { text: "创建日程" },
  call_phone: { text: "拨打电话" },
  create_alarm: {text: "创建日程"},
  delete_alarm: { text: "删除日程" },
  image_reading: { text: "图片理解" },
  get_user_location: { text: "获取位置信息" },
  modify_alarm: { text: "修改闹钟" },
  modify_note: { text: "追加备忘录" },
  create_note: { text: "创建备忘录" },
  query_app_message: { text: "获取设备通知" },
  save_file_to_file_manager: { text: "保存文件" },
  save_media_to_gallery: { text: "保存图片" },
  search_alarm: { text: "查找闹钟" },
  search_calendar_event: { text: "查找日程" },
  search_contact: { text: "查找联系人" },
  search_email: { text: "查找邮件" },
  search_file: { text: "查找文件" },
  search_message: { text: "查找短信" },
  search_notes: { text: "查找备忘录" },
  search_photo_gallery: { text: "查找图片" },
  send_email: { text: "发送邮件" },
  send_message: { text: "发送短信" },
  add_collection: { text: "记入公共知识" },
  xiaoyi_append_reference: { text: "知识搜索引用呈现" },
  query_collection: { text: "查找公共知识" },
  delete_collection: { text: "删除公共知识" },
};

// ── 技能检测 ───────────────────────────────────────────────────────

/** 从路径/文本中提取技能名：.../skills/<name> 或 .../core_skills/<name>。 */
function extractSkillNameFromPathText(text: string): string | null {
  const normalized = text.replace(/\\/g, "/");
  const m = normalized.match(/(?:^|[/\s"';&|])(?:core_)?skills\/([^/'"\s;&|]+)/i);
  return m ? m[1] : null;
}

/** 读 SKILL.md 检测：路径形如 .../skills/<name>/SKILL.md（含 core_skills）。 */
function extractSkillNameFromMdPath(text: string): string | null {
  const normalized = text.replace(/\\/g, "/");
  const m = normalized.match(/(?:core_)?skills\/([^/'"\s;&|]+)\/SKILL\.md/i);
  return m ? m[1] : null;
}

/**
 * 从 exec 命令中识别「cd 进技能目录」，返回技能名。
 * 支持：cd skills/foo、cd ~/.openclaw/workspace/skills/foo、
 * cd "core_skills/foo"、cd skills/foo/sub（取 skills 后的第一段）。
 */
function detectCdIntoSkill(command: string): string | null {
  const normalized = command.replace(/\\/g, "/");
  const cdMatch = normalized.match(/\bcd\s+["']?([^"';&|]+)/i);
  if (!cdMatch) return null;
  return extractSkillNameFromPathText(cdMatch[1]);
}

/** read 工具路径分类：技能 SKILL.md 或普通文件。 */
function classifyReadPath(path: unknown): { kind: "skill"; skillName: string } | { kind: "normal" } | null {
  if (typeof path !== "string" || path.trim().length === 0) return null;
  const skillName = extractSkillNameFromMdPath(path);
  if (skillName) return { kind: "skill", skillName };
  return { kind: "normal" };
}

/**
 * 识别当前工具调用的技能动作（exec 命令内容 / read 路径）。
 * 返回 null 表示不命中；read 优先（同命令内 cd+读 md → 判为 read）。
 */
function detectSkillAction(
  event: { toolName?: string; params?: Record<string, unknown> },
): { action: "view" | "use"; skillName: string } | null {
  if (event.toolName === "read") {
    const classified = classifyReadPath(event.params?.path);
    if (classified?.kind === "skill") return { action: "view", skillName: classified.skillName };
    return null;
  }

  if (event.toolName === "exec") {
    const command = event.params?.command;
    if (typeof command !== "string" || command.trim().length === 0) return null;

    const mdSkillName = extractSkillNameFromMdPath(command);
    if (mdSkillName) return { action: "view", skillName: mdSkillName };

    const cdSkillName = detectCdIntoSkill(command);
    if (cdSkillName) return { action: "use", skillName: cdSkillName };
    return null;
  }

  return null;
}

/** 判断当前工具调用是否为 read 技能 SKILL.md（只发技能卡片，不做分段边界）。 */
function isSkillMdRead(event: { toolName?: string; params?: Record<string, unknown> }): boolean {
  if (event.toolName !== "read") return false;
  return classifyReadPath(event.params?.path)?.kind === "skill";
}

/**
 * 提取 update_plan 参数中 in_progress 状态的步骤文本。
 * openclaw update_plan schema：{ explanation?, plan: [{ step, status }] }，
 * status ∈ pending/in_progress/completed，且工具侧校验至多一个 in_progress
 * （这里仍做防御性遍历，schema 放宽后也能全部下发）。
 */
function extractInProgressPlanSteps(params: Record<string, unknown> | undefined): string[] {
  const plan = params?.plan;
  if (!Array.isArray(plan)) return [];
  const steps: string[] = [];
  for (const entry of plan) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    if (e.status !== "in_progress") continue;
    if (typeof e.step === "string" && e.step.trim().length > 0) steps.push(e.step);
  }
  return steps;
}

// ── 下发目标解析 ───────────────────────────────────────────────────

/** 解析下发目标会话上下文：主会话 binding → ALS → cron 合成 ctx → 放弃。 */
function resolveSendContext(
  event: { toolCallId?: string },
  ctx: { sessionKey?: string },
): { config: XYChannelConfig; sessionId: string; taskId: string; messageId: string } | null {
  // 1. 主会话对话路径：sessionKey → A2A binding（与 tool-status-hook 一致）
  const binding = resolveBySessionKey(ctx.sessionKey ?? "");
  if (binding) {
    const cached = getCachedXYConfig();
    const config = (cached as XYChannelConfig) ?? null;
    if (config) {
      return {
        config,
        sessionId: binding.sessionId,
        taskId: binding.taskId,
        messageId: binding.messageId,
      };
    }
  }

  // 2. ALS 会话上下文（普通 turn 兜底；cron 时 provider 已把 jobId 绑定到
  //    该 sessionId，push 路由能命中 cron-push-map 的精确设备）
  const alsCtx = getCurrentSessionContext();
  if (alsCtx?.sessionId) {
    return {
      config: alsCtx.config,
      sessionId: alsCtx.sessionId,
      taskId: alsCtx.taskId,
      messageId: alsCtx.messageId,
    };
  }

  // 3. cron 无 ALS：sessionKey 带 "cron:" 前缀（openclaw 自身行为，不依赖
  //    其它 before_tool_call 钩子的标记时序）或 toolCallId 已被 cron 检测
  //    钩子标记时，按 call-device-tool 同款方式构造合成 ctx（"cron-" 前缀
  //    使 sendCommand 路由到 push 通道）
  const sessionKey = ctx.sessionKey ?? "";
  const toolCallId = event.toolCallId ?? "";
  if (sessionKey.includes("cron:") || isCronToolCall(toolCallId)) {
    const runInfo = getCronToolRunInfo(toolCallId);
    const cached = getCachedXYConfig();
    const config = (cached as XYChannelConfig) ?? null;
    if (config) {
      return {
        config,
        sessionId: `cron-${(runInfo?.runId ?? toolCallId).replace(/-/g, "")}`,
        taskId: runInfo?.runId ?? toolCallId,
        messageId: "",
      };
    }
  }

  return null;
}

// ── 命令下发 ───────────────────────────────────────────────────────

/** 文本分段边界：以旧 id 补发旧段完整文本（lastChunk=true 收尾帧）并等队列
 *  排空，再轮换 streamingTextId、切分流式装配器 —— 其后的文本帧使用新 id，
 *  且只携带边界后新段的文本（端侧按 id 聚合流式文本段）。
 *  内部还会标记 thinkIndex 待下发值（见 utils/think-index）。 */
async function rotateTextSegmentAtToolBoundary(params: {
  config: XYChannelConfig;
  sessionId: string;
  taskId: string;
  messageId: string;
}): Promise<void> {
  const newStreamingTextId = await rotateStreamingTextSegment(params);
  logger.log(
    `${LOG_TAG} rotated streamingTextId taskId=${params.taskId} newId=${newStreamingTextId}`,
  );
}

/** 下发一条执行状态卡命令（UserInteraction/DisplayExecuteStatusCard）。
 *  payload：text 为卡片展示文本；isFinal 默认 true；taskUniqId 取 taskId
 *  （同轮对话内所有卡片相同）；taskUniqIndexId 为本轮对话（taskId）内发送
 *  状态卡的序号，从 1 开始递增（见 utils/status-card-seq），同轮多张卡片
 *  由序号区分。
 *  每次下发同步配对一张 DisplayTaskCardData（顺序在 statusCard 之前）：
 *  index/taskUniqIndexId 取本卡序号，stepName 取本卡 text，isFinal=false。
 *  工具调用状态卡（触发表内工具的调用前卡）也经此下发（tool-status-hook）。 */
export async function sendExecuteStatusCard(params: {
  config: XYChannelConfig;
  sessionId: string;
  taskId: string;
  messageId: string;
  toolCallId?: string;
  /** 卡片展示文本（原 stepName 语义）。 */
  text: string;
  /** 卡片图标 symbolName（触发表内工具下发时携带；未给则省略该字段）。 */
  symbolName?: string;
  /** 默认 true。 */
  isFinal?: boolean;
}): Promise<void> {
  const seq = nextStatusCardSeq(params.taskId);

  // 若本卡之前刚结束一个流文本块（lastChunk=true 的分段收尾帧 / reasoning
  // 结束标记帧），本卡携带 thinkIndex=[该块的 taskUniqIndexId]（字符串数组）。
  // take 语义：仅块结束后的第一张状态卡携带。
  const pendingThinkIndex = takePendingThinkIndex(params.taskId);

  // 配对卡先行：DisplayTaskCardData 的顺序必须在 statusCard 之前
  await sendDisplayTaskCardData({
    config: params.config,
    sessionId: params.sessionId,
    taskId: params.taskId,
    messageId: params.messageId,
    toolCallId: params.toolCallId,
    index: seq,
    stepName: params.text,
    isFinal: false,
  });

  const command: A2ACommand = {
    header: { namespace: "UserInteraction", name: "DisplayExecuteStatusCard" },
    payload: {
      text: params.text,
      isFinal: params.isFinal ?? true,
      taskUniqId: params.taskId,
      taskUniqIndexId: seq,
      ...(params.symbolName ? { symbolName: params.symbolName } : {}),
      ...(pendingThinkIndex !== null ? { thinkIndex: [pendingThinkIndex] } : {}),
    },
  };
  if (pendingThinkIndex !== null) {
    logger.log(`${LOG_TAG} status card carries thinkIndex=["${pendingThinkIndex}"], taskUniqIndexId=${seq}`);
  }

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
 * Register the step-info + skill hooks on the OpenClaw plugin API.
 * Call during `registrationMode === "full"` in the plugin entry point.
 */
export function registerStepInfoHook(api: OpenClawPluginApi): void {
  // 工具执行前：技能任务卡片 / 使用工具任务卡片 / 分类内工具分段边界
  api.on("before_tool_call", async (event, ctx) => {
    try {
      const sendCtx = resolveSendContext(event, ctx);
      if (!sendCtx) return;

      // 1. 技能任务卡片（cd 进技能目录 / 读 SKILL.md）
      const skillAction = detectSkillAction(event);
      if (skillAction) {
        const cardText =
          skillAction.action === "view"
            ? `查看技能 ${skillAction.skillName}`
            : `使用技能 ${skillAction.skillName}`;
        await sendExecuteStatusCard({
          ...sendCtx,
          toolCallId: event.toolCallId,
          text: cardText,
        });
        logger.log(
          `${LOG_TAG} sent skill status card action=${skillAction.action} skill=${skillAction.skillName}`,
        );
      }

      // 2. read 技能 SKILL.md 时只走技能卡片，跳过后续所有动作
      if (isSkillMdRead(event)) {
        logger.log(`${LOG_TAG} skip: read skill SKILL.md, tool=${event.toolName}`);
        return;
      }
      const displayName = DISPLAY_BY_TOOL[event.toolName];
      if (!displayName) return;

      // update_plan 追加全量入参日志，便于排查计划下发内容
      if (event.toolName === "update_plan") {
        logger.log(
          `${LOG_TAG} update_plan 调用入参 toolCallId=${event.toolCallId ?? ""}:`,
          event.params,
        );
      }

      // 3. 使用工具白名单：不发卡、无分段边界；update_plan 例外保留
      //    in_progress 步骤卡（text=步骤文本，同轮多张卡片由 taskUniqIndexId
      //    序号区分，taskUniqId 同为 taskId）
      if (TASK_CARD_TOOLS.has(event.toolName)) {
        if (event.toolName === "update_plan") {
          const planSteps = extractInProgressPlanSteps(event.params);
          for (const stepText of planSteps) {
            await sendExecuteStatusCard({
              ...sendCtx,
              toolCallId: event.toolCallId,
              text: stepText,
            });
            logger.log(`${LOG_TAG} sent plan step card step="${stepText}"`);
          }
        }
        return;
      }

      // 4. 分类内工具调用点：文本分段边界（旧段 lastChunk=true 收尾 +
      //    轮换 streamingTextId），不再下发任何命令
      await rotateTextSegmentAtToolBoundary({ ...sendCtx });

      logger.log(`${LOG_TAG} segment boundary at tool_call, tool=${event.toolName} display=${displayName}`);
    } catch (err) {
      // 命令下发失败绝不能 block 工具执行
      logger.error(`${LOG_TAG} before_tool_call hook failed:`, err);
    }
  });

  // 工具执行后：分类内工具的文本分段边界；使用工具类无动作
  api.on("after_tool_call", async (event, ctx) => {
    try {
      // read 技能 SKILL.md 的 result 也不做任何动作（与 before 侧去重对齐）
      if (isSkillMdRead(event)) return;
      const displayName = DISPLAY_BY_TOOL[event.toolName];
      if (!displayName) return;

      // 成功 → success=true + 执行结果；失败 → success=false + 报错信息
      const failed = event.error !== undefined && event.error !== null;
      const rawResult = failed
        ? (typeof event.error === "string" ? event.error : JSON.stringify(event.error))
        : event.result;

      // update_plan 追加全量出参日志（成功为执行结果，失败为报错信息）
      if (event.toolName === "update_plan") {
        logger.log(
          `${LOG_TAG} update_plan 实际输出 toolCallId=${event.toolCallId ?? ""} success=${!failed}:`,
          rawResult,
        );
      }

      // 使用工具类只在调用前下发一次任务卡片，after 侧无动作
      if (TASK_CARD_TOOLS.has(event.toolName)) return;

      const sendCtx = resolveSendContext(event, ctx);
      if (!sendCtx) {
        logger.log(`${LOG_TAG} skip segment boundary: no send context, tool=${event.toolName}`);
        return;
      }

      // 工具返回点：文本分段边界（旧段 lastChunk=true 收尾 + 轮换 streamingTextId）
      await rotateTextSegmentAtToolBoundary({ ...sendCtx });

      logger.log(
        `${LOG_TAG} segment boundary at tool_result, tool=${event.toolName} display=${displayName} success=${!failed}`,
      );
    } catch (err) {
      logger.error(`${LOG_TAG} after_tool_call hook failed:`, err);
    }
  });
}
