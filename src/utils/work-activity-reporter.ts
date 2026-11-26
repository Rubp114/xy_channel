// 端侧工作场景上报（client-work-activity/v1/task/report）。
// 需求单号：AR10004AGN【会员活动】积分任务运营活动
//
// 接口地址与凭证：全部取自 ~/.openclaw/.xiaoyienv（invoke 同款读取方式）——
//   source-url + 固定路径 /client-work-activity/v1/task/report（端口后部分）；
//   PERSONAL-UID / PERSONAL-API-KEY 作 x-uid / x-api-key。
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
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { randomUUID } from "crypto";
import { logger } from "./logger.js";
import type { XYChannelConfig } from "../types.js";

/** 环境文件（与 invoke 同一约定）：~/.openclaw/.xiaoyienv，KEY=VALUE 行、# 注释。 */
const ENV_FILE_PATH = path.join(os.homedir(), ".openclaw", ".xiaoyienv");
/** 上报接口路径（端口后的固定部分）；完整地址 = 环境变量 source-url + 本路径。 */
const REPORT_API_PATH = "/client-work-activity/v1/task/report";
const REQUEST_TIMEOUT_MS = 10_000;
const REQUEST_FROM = "openclaw";

/**
 * 从 .xiaoyienv 读上报所需环境配置（invoke 同款解析）：
 *   source-url        → 接口地址前缀
 *   PERSONAL-UID      → x-uid
 *   PERSONAL-API-KEY  → x-api-key
 * 任一键缺失/读失败返回 null（调用方跳过上报，不抛错）。地址前缀剥离尾部斜杠。
 */
function readEnvConfig(): { sourceUrl: string; uid: string; apiKey: string } | null {
  try {
    if (!fs.existsSync(ENV_FILE_PATH)) return null;
    const envData = fs.readFileSync(ENV_FILE_PATH, "utf-8");
    const env: Record<string, string> = {};
    for (const line of envData.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eqIdx = trimmed.indexOf("=");
      if (eqIdx === -1) continue;
      const key = trimmed.substring(0, eqIdx).trim();
      if (key === "source-url" || key === "PERSONAL-UID" || key === "PERSONAL-API-KEY") {
        env[key] = trimmed.substring(eqIdx + 1).trim();
      }
    }
    const sourceUrl = (env["source-url"] ?? "").replace(/\/+$/, "");
    const uid = env["PERSONAL-UID"] ?? "";
    const apiKey = env["PERSONAL-API-KEY"] ?? "";
    if (!sourceUrl || !uid || !apiKey) return null;
    return { sourceUrl, uid, apiKey };
  } catch {
    return null;
  }
}

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
  /** 已废弃：凭证改由 .xiaoyienv（PERSONAL-UID/PERSONAL-API-KEY）读取，
   *  本字段不再使用，仅为兼容调用方签名保留。 */
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
    // 接口地址与凭证全部取自 .xiaoyienv（invoke 同款读取）：source-url 为
    // 地址前缀，PERSONAL-UID / PERSONAL-API-KEY 为 x-uid / x-api-key。
    // 任一键缺失跳过（不记去重表，env 修复后下个触发点可正常上报）
    const envCfg = readEnvConfig();
    if (!envCfg) {
      logger.warn(
        `[WORK-REPORT] skip taskType=${taskType}: source-url/PERSONAL-UID/PERSONAL-API-KEY not fully set in ${ENV_FILE_PATH}`,
      );
      return;
    }
    const reportUrl = `${envCfg.sourceUrl}${REPORT_API_PATH}`;
    const key = `${sessionId}|${taskType}|${ctx.dedupKey ?? ""}`;
    if (reportedKeys.has(key)) return;
    reportedKeys.add(key);

    // trace-id 填当前活跃会话的 taskId（不复用 cspl 的 sessionId_时间戳 约定）；
    // taskId 缺失时降级 sessionId，两者都没有用随机 uuid 兜底
    const traceId = ctx.taskId || sessionId || randomUUID();
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "x-hag-trace-id": traceId,
      "x-uid": envCfg.uid,
      "x-api-key": envCfg.apiKey,
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
        `[WORK-REPORT][DEBUG] request url=${reportUrl} headers=${JSON.stringify(headers)} body=${body}`,
      );
    } catch { /* ignore */ }
    postJson(reportUrl, headers, body)
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
