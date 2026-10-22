// thinkIndex 待下发标记注册表。
//
// 时序语义（第 N 段流文本块 → 第 N+1 段 → 状态卡）：
//   1. 每当一帧 lastChunk=true 的流式文本（正文分段收尾帧 / reasoning 结束
//      标记帧）结束一个流文本块时，记录该块的 taskUniqIndexId
//      （markLastChunkBlock，在块结束的决策点同步调用）；
//   2. 块结束后观察到首帧新的流式文本（正文 partial 帧或思维链流式帧经
//      出站队列实际发出）时，标记"下一段文本已开始"（markTextResumed，
//      formatter 在帧 drain 后调用）；
//   3. 其后下发的第一张 DisplayExecuteStatusCard 状态卡携带
//      thinkIndex=[该值]（takePendingThinkIndex，take 即清除）。
//   —— 只有"下一段文本已开始"之后下发的状态卡才携带 thinkIndex：若块结束
//   后文本尚未恢复流出（工具仍在执行），该期间下发的状态卡不携带，
//   待下发值继续保留，直到文本恢复后的第一张卡。
//
// 同一 taskId 连续结束多个文本块时只保留最近一块（"上一段"语义）；
// turn 结束（final 帧发出）或会话销毁时释放。
//
// 叶子模块：不依赖 conversation/dispatch 层，formatter / conversation-manager /
// tools 均可安全 import（避免循环依赖）。

interface PendingThinkIndex {
  /** 刚结束的流文本块的 taskUniqIndexId（字符串化）。 */
  blockSeq: string;
  /** 下一段流文本是否已开始发送。 */
  textResumed: boolean;
}

/** taskId → 待下发标记。 */
const pendingThinkIndexByTask = new Map<string, PendingThinkIndex>();

/**
 * 记录一帧 lastChunk=true 流文本块的 taskUniqIndexId。
 * 在块结束的决策点同步调用（onReasoningEnd / rotateStreamingTextSegment），
 * 而非帧实际发出时 —— 保证随后工具钩子内组卡时一定能取到，不受出站队列
 * drain 时序影响。连续调用后者覆盖前者（只保留最近一块）。
 */
export function markLastChunkBlock(taskId: string, taskUniqIndexId: number): void {
  pendingThinkIndexByTask.set(taskId, { blockSeq: String(taskUniqIndexId), textResumed: false });
}

/**
 * 标记块结束后的下一段流文本已开始发送（formatter 在正文 partial 帧 /
 * 思维链流式帧实际发出后调用）。无待下发标记时为 no-op。
 */
export function markTextResumed(taskId: string): void {
  const pending = pendingThinkIndexByTask.get(taskId);
  if (pending) pending.textResumed = true;
}

/**
 * 取出并清除待下发的 thinkIndex 值（仅文本恢复后第一张状态卡携带）；
 * 无标记、或文本尚未恢复时返回 null（标记保留，等文本恢复后的卡再携带）。
 */
export function takePendingThinkIndex(taskId: string): string | null {
  const pending = pendingThinkIndexByTask.get(taskId);
  if (!pending || !pending.textResumed) return null;
  pendingThinkIndexByTask.delete(taskId);
  return pending.blockSeq;
}

/** 释放指定 taskId 的待下发标记（turn 结束 / 会话销毁时调用）。幂等。 */
export function releaseThinkIndex(taskId: string): void {
  pendingThinkIndexByTask.delete(taskId);
}
