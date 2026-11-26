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
//   - header：content-type、x-uid、x-api-key、x-request-from、x-skill-id
//     （默认空）、x-session-id（当前会话）；x-hag-trace-id 填当前活跃会话的
//     taskId（ALS 任务链/事件上下文取，缺失时降级 sessionId → 随机 uuid）。
//   - body 仅一个字段：{ taskType }。
//   - 去重：key = `${sessionId}|${taskType}|${dedupKey}` 进程内只报一次；
//     cron 场景由调用方传 jobId 作 dedupKey（每次创建各报一次），技能场景
//     不传（同会话同技能只报一次）。
//   - 异步 fire-and-forget，失败仅记日志，绝不影响主流程。
//   - [WORK-REPORT][DEBUG] 日志打印完整请求报文与响应/报错全文。

import * as https from "https";
import { randomUUID } from "crypto";
import { logger } from "./logger.js";
import type { XYChannelConfig } from "../types.js";

const REPORT_URL =
  "https://lfhagmirror.hwcloudtest.cn:18449/client-work-activity/v1/task/report";
const REQUEST_TIMEOUT_MS = 10_000;
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

interface PostJsonResult {
  status: number;
  body: string;
}

/** POST JSON，收集响应全文，resolve { status, body }；网络/超时错误 reject。 */
function postJson(
  url: string,
  headers: Record<string, string>,
  body: string,
): Promise<PostJsonResult> {
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
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf-8"),
          }),
        );
        res.on("error", reject);
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

/** 错误对象可读化（含 stack / cause 链）。 */
function describeError(err: unknown): string {
  if (err instanceof Error) {
    const cause = (err as { cause?: unknown }).cause;
    return `${err.name}: ${err.message}${err.stack ? `\n${err.stack}` : ""}` +
      (cause ? `\ncaused by: ${String(cause)}` : "");
  }
  return String(err);
}

export interface WorkActivityReportContext {
  /** 当前会话 A2A sessionId（进 x-session-id）；缺失按空串处理。 */
  sessionId?: string;
  /** 当前活跃会话的 taskId（填 x-hag-trace-id）；缺失降级 sessionId → uuid。 */
  taskId?: string;
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

    // trace-id 填当前活跃会话的 taskId（不复用 cspl 的 sessionId_时间戳 约定）；
    // taskId 缺失时降级 sessionId，两者都没有用随机 uuid 兜底
    const traceId = ctx.taskId || sessionId || randomUUID();
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
    // debug：完整请求报文
    try {
      logger.log(
        `[WORK-REPORT][DEBUG] request url=${REPORT_URL} headers=${JSON.stringify(headers)} body=${body}`,
      );
    } catch { /* ignore */ }
    postJson(REPORT_URL, headers, body)
      .then(({ status, body: respBody }) => {
        logger.log(`[WORK-REPORT] reported taskType=${taskType}, httpStatus=${status}`);
        // debug：完整响应报文
        logger.log(`[WORK-REPORT][DEBUG] response status=${status} body=${respBody || "(empty)"}`);
      })
      .catch((err) => {
        logger.error(`[WORK-REPORT] report failed taskType=${taskType}:`, err);
        // debug：完整报错内容
        logger.error(`[WORK-REPORT][DEBUG] request error=${describeError(err)}`);
      });
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
