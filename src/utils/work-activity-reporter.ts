// 端侧工作场景上报（client-work-activity/v1/task/report）。
// 需求单号：AR10004AGN【会员活动】积分任务运营活动
//
// 触发场景 → taskType：
//   1. 调用 xiaoyi-ppt 技能                            → work_generate_ppt
//   2. 调用 xiaoyi-deep-research / xiaoyi-web-search   → work_deep_research
//   3. 调用 seedance-video-gen 技能                    → work_generate_video
//   4. 创建定时任务（cron add：对话触发 / 上行事件请求）→ work_scheduled_tasks
//   5. 调用 huawei-drive 技能                          → work_upload_to_cloud
//
// 技能"调用"判定复用 skill 打点日志逻辑（index.ts registerSkillsDiagnosticHook）：
// 读技能任意 md（含顶层 SKILL.md）或 exec/bash 运行技能路径里的脚本，均算调用。
//
// 请求约定：
//   - header 对齐 cspl/push 的 HTTPS 约定：content-type、x-hag-trace-id、x-uid、
//     x-api-key、x-request-from，另加 x-skill-id（默认空）、x-session-id；
//     x-hag-trace-id 取当前会话 sessionId 拼毫秒时间戳（cspl buildTraceId 同款，
//     空 sessionId 降级 uuid，超 64 截断）。
//   - body 仅一个字段：{ taskType }。
//   - 去重：key = `${sessionId}|${taskType}|${dedupKey}` 进程内只报一次；
//     cron 场景由调用方传 jobId 作 dedupKey（每次创建各报一次），技能场景
//     不传（同会话同技能只报一次）。
//   - 异步 fire-and-forget，失败仅记日志，绝不影响主流程。

import * as https from "https";
import { randomUUID } from "crypto";
import { logger } from "./logger.js";
import type { XYChannelConfig } from "../types.js";

const REPORT_URL =
  "https://lfhagmirror.hwcloudtest.cn:18449/client-work-activity/v1/task/report";
const REQUEST_TIMEOUT_MS = 10_000;
const MAX_TRACE_ID_LENGTH = 64;
const REQUEST_FROM = "openclaw";

export type WorkActivityTaskType =
  | "work_generate_ppt"
  | "work_deep_research"
  | "work_generate_video"
  | "work_scheduled_tasks"
  | "work_upload_to_cloud";

/** 技能名（skills 目录名，小写）→ taskType。 */
const SKILL_TASK_TYPE_MAP: Record<string, WorkActivityTaskType> = {
  "xiaoyi-ppt": "work_generate_ppt",
  "xiaoyi-deep-research": "work_deep_research",
  "xiaoyi-web-search": "work_deep_research",
  "seedance-video-gen": "work_generate_video",
  "huawei-drive": "work_upload_to_cloud",
};

/** 进程内去重表。 */
const reportedKeys = new Set<string>();

/** trace-id：sessionId 拼毫秒时间戳；空 sessionId 降级 uuid；超 64 截断（对齐 cspl buildTraceId）。 */
function buildTraceId(sessionId: string): string {
  const traceId = sessionId ? `${sessionId}_${Date.now()}` : randomUUID();
  return traceId.length > MAX_TRACE_ID_LENGTH
    ? traceId.substring(0, MAX_TRACE_ID_LENGTH)
    : traceId;
}

/** POST JSON，resolve HTTP 状态码；网络/超时错误 reject。 */
function postJson(
  url: string,
  headers: Record<string, string>,
  body: string,
): Promise<number> {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const req = https.request(
      {
        hostname: urlObj.hostname,
        port: urlObj.port || 443,
        path: urlObj.pathname + urlObj.search,
        method: "POST",
        headers,
        timeout: REQUEST_TIMEOUT_MS,
        rejectUnauthorized: false, // 与 cspl upload_file 一致（测试环境自签名证书）
      },
      (res) => {
        res.resume(); // 丢弃响应体
        res.on("end", () => resolve(res.statusCode ?? 0));
      },
    );
    req.on("timeout", () =>
      req.destroy(new Error(`timeout after ${REQUEST_TIMEOUT_MS}ms`)),
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

export interface WorkActivityReportContext {
  /** 当前会话 A2A sessionId（进 x-session-id / x-hag-trace-id）；缺失按空串处理。 */
  sessionId?: string;
  /** 频道配置（取 uid/apiKey）；缺失或缺字段时跳过上报。 */
  config?: XYChannelConfig | null;
  /** 去重键后缀：cron 场景传 jobId（每次创建各报一次）；不传则同会话同场景只报一次。 */
  dedupKey?: string;
}

/** 上报一次工作场景。同步校验+去重，请求异步发出；永不抛错。 */
export function reportWorkActivity(
  taskType: WorkActivityTaskType,
  ctx: WorkActivityReportContext = {},
): void {
  const sessionId = ctx.sessionId ?? "";
  try {
    const config = ctx.config;
    if (!config?.uid || !config?.apiKey) {
      logger.warn(
        `[WORK-REPORT] skip taskType=${taskType}: missing uid/apiKey in config`,
      );
      return;
    }
    const key = `${sessionId}|${taskType}|${ctx.dedupKey ?? ""}`;
    if (reportedKeys.has(key)) return;
    reportedKeys.add(key);

    const traceId = buildTraceId(sessionId);
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "x-hag-trace-id": traceId,
      "x-uid": config.uid,
      "x-api-key": config.apiKey,
      "x-request-from": REQUEST_FROM,
      "x-skill-id": "",
      "x-session-id": sessionId,
    };
    const body = JSON.stringify({ taskType });
    logger.log(
      `[WORK-REPORT] reporting taskType=${taskType}, sessionId=${sessionId || "(none)"}, traceId=${traceId}`,
    );
    postJson(REPORT_URL, headers, body)
      .then((status) =>
        logger.log(`[WORK-REPORT] reported taskType=${taskType}, httpStatus=${status}`),
      )
      .catch((err) =>
        logger.error(`[WORK-REPORT] report failed taskType=${taskType}:`, err),
      );
  } catch (err) {
    logger.error(`[WORK-REPORT] report failed taskType=${taskType}:`, err);
  }
}

/** 技能调用上报：不在观注表内的技能 no-op。 */
export function reportSkillInvocation(
  skillName: string,
  ctx: WorkActivityReportContext = {},
): void {
  const taskType = SKILL_TASK_TYPE_MAP[skillName.toLowerCase()];
  if (!taskType) return;
  reportWorkActivity(taskType, ctx);
}
