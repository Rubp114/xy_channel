// thinkIndex 待下发标记注册表。
//
// 每当一帧 lastChunk=true 的流式文本（正文分段收尾帧 / reasoning 结束标记帧）
// 结束一个流文本块时，记录该块的 taskUniqIndexId；其后下发的第一张
// DisplayExecuteStatusCard 状态卡在 payload 中携带 thinkIndex=[该值]
// （字符串数组），端侧据此把刚结束的文本块关联到卡片位置。
//   - 同一 taskId 连续结束多个文本块时只保留最近一块（"上一个"语义）；
//   - 仅之后第一张状态卡携带（take 即清除）；
//   - turn 结束（final 帧发出）或会话销毁时释放，下轮重新标记。
//
// 叶子模块：不依赖 conversation/dispatch 层，formatter / conversation-manager /
// tools 均可安全 import（避免循环依赖）。

/** taskId → 最近一个 lastChunk=true 流文本块的 taskUniqIndexId（字符串化）。 */
const pendingThinkIndexByTask = new Map<string, string>();

/**
 * 记录一帧 lastChunk=true 流文本块的 taskUniqIndexId。
 * 在块结束的决策点同步调用（onReasoningEnd / rotateStreamingTextSegment），
 * 而非帧实际发出时 —— 保证随后工具钩子内组卡时一定能取到，不受出站队列
 * drain 时序影响。连续调用后者覆盖前者（只保留最近一块）。
 */
export function markLastChunkBlock(taskId: string, taskUniqIndexId: number): void {
  pendingThinkIndexByTask.set(taskId, String(taskUniqIndexId));
}

/** 取出并清除待下发的 thinkIndex 值（仅第一张状态卡携带）；无标记时返回 null。 */
export function takePendingThinkIndex(taskId: string): string | null {
  const value = pendingThinkIndexByTask.get(taskId);
  if (value === undefined) return null;
  pendingThinkIndexByTask.delete(taskId);
  return value;
}

/** 释放指定 taskId 的待下发标记（turn 结束 / 会话销毁时调用）。幂等。 */
export function releaseThinkIndex(taskId: string): void {
  pendingThinkIndexByTask.delete(taskId);
}
