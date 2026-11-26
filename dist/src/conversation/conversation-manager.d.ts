import { ConversationSession, SubagentWaitState, SubagentWaitTransition, TaskEntry } from "./conversation-session.js";
export declare function getOrCreateSession(sessionId: string): ConversationSession;
export declare function getSession(sessionId: string): ConversationSession | null;
export declare function deleteSession(sessionId: string): void;
export declare function listSessions(): ConversationSession[];
/** 会话状态迁移（working / waiting-subagent / completing / 终态）。 */
export declare function setSessionState(sessionId: string, state: ConversationSession["state"]): void;
/**
 * 注册或更新 session 的活跃 taskId。
 * Returns true if this was an update (session already had an active task).
 */
export declare function registerTask(sessionId: string, taskId: string, messageId: string): boolean;
/**
 * 移除 session 的活跃 taskId（消息处理完成时调用）。
 * @param expectedTaskId 可选：精确移除指定的 taskId，而非清空整个任务链。
 */
export declare function completeTask(sessionId: string, expectedTaskId?: string): void;
/** 获取 session 当前活跃 task（任务链末尾）。 */
export declare function getCurrentTask(sessionId: string): TaskEntry | null;
/** 获取 session 当前活跃 taskId（reply-dispatcher 跨链读取 / 工具富化用）。 */
export declare function getCurrentTaskId(sessionId: string): string | null;
/** 获取 session 当前活跃 messageId。 */
export declare function getCurrentMessageId(sessionId: string): string | null;
export declare function hasActiveTask(sessionId: string): boolean;
/** 所有活跃 task 绑定（gateway_stop 通知等场景）。 */
export declare function listActiveTaskBindings(): Array<{
    sessionId: string;
    currentTaskId: string;
    currentMessageId: string;
    updatedAt: number;
}>;
/**
 * dispatch 时登记在途 turn（bot.ts 创建 dispatcher 后调用）。
 * 注意：steer 直接注入成功的路径不 dispatch，不得登记。
 */
export declare function markTurnInflight(sessionId: string, taskId: string): void;
/** turn 不再产生流式帧时清除在途标记（onIdle 入口 / onSettled 兜底）。 */
export declare function clearTurnInflight(sessionId: string, taskId: string): void;
/** 最近创建 dispatcher 的 taskId；直接 steer 不创建 dispatcher，不会改写它。 */
export declare function getCurrentDispatchTaskId(sessionId: string): string | null;
/** 旧 dispatcher 已被新 dispatcher 接替后，不得再发送正文或终态帧。 */
export declare function isTurnSuperseded(sessionId: string, taskId: string): boolean;
/** 记录取消仅用于阻止该 turn 的后续输出，不向下一条消息注入任何提示。 */
export declare function markTurnCanceled(sessionId: string, taskId: string): void;
export declare function isTurnCanceled(sessionId: string, taskId: string): boolean;
/**
 * 绑定 openclaw sessionKey 到首条消息的 A2A 身份。
 * 仅在首条消息时调用（steer 消息不覆盖，保持 subagent 等待态跟踪稳定）。
 */
export declare function bindSessionKey(sessionKey: string, sessionId: string, taskId: string, messageId: string): void;
export declare function resolveBySessionKey(sessionKey: string): {
    sessionId: string;
    taskId: string;
    messageId: string;
} | null;
export declare function unbindSessionKey(sessionKey: string): void;
/**
 * 全局缓存 resolved XY config，供 hook 上下文（无 raw ClawdbotConfig）使用。
 */
export declare function cacheXYConfig(config: unknown): void;
export declare function getCachedXYConfig(): unknown;
/**
 * 启动（或重启）session 的 30s 状态心跳。
 * 心跳由 manager 拥有：dispatcher 销毁不影响心跳；
 * tick 时读取任务链末尾的当前 taskId/messageId。
 */
export declare function startStatusHeartbeat(sessionId: string, text?: string): void;
export declare function stopStatusHeartbeat(sessionId: string): void;
/**
 * subagent_spawned hook 调用。递增 expected completion 计数。
 * 若等待态尚不存在则创建（sessions_spawn 可能先于 sessions_yield）。
 */
export declare function markSubagentSpawned(sessionKey: string): number;
/**
 * subagent_ended hook 调用。标记一个 subagent run 结束并计为一次交付。
 * 这是主要的完成跟踪机制（subagent 完成可能不经 xyOutbound.sendText）。
 */
export declare function markSubagentEnded(sessionKey: string): SubagentWaitTransition | null;
/**
 * bot.ts onSettled 调用。标记父 dispatcher 已 settle。
 */
export declare function markParentSettled(sessionId: string, taskId: string): SubagentWaitTransition | null;
/**
 * 存储从 xyOutbound.sendText 捕获的完成文本。不递增交付计数。
 */
export declare function addCompletionText(sessionId: string, taskId: string, text: string): void;
export declare function getWaitState(sessionId: string, taskId?: string): SubagentWaitState | null;
export declare function hasWaitState(sessionId: string, taskId?: string): boolean;
export declare function clearWaitState(sessionId: string, reason: string, taskId?: string): SubagentWaitState | null;
/**
 * 当所有 subagent 完成且父 turn 已 settle 时，由 manager 发送终态帧并真正
 * 结束当前 A2A session：
 *   1. completed 状态帧（"任务处理已完成~"）→ final:true 全文本帧（合并
 *      completionTexts）——与 reply-dispatcher 正常终态同序，xy_tester
 *      与客户端依赖该顺序
 *   2. 清理等待态、停止心跳、移除任务链
 *   3. 会话状态迁移到 completed
 */
export declare function deliverSubagentFinalResult(params: {
    state: SubagentWaitState;
    reason?: string;
    text?: string;
}): Promise<void>;
