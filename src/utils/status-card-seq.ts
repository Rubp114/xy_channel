// 执行状态卡序号注册表。
//
// DisplayExecuteStatusCard 命令 payload 的 taskUniqIndexId：一轮对话（taskId）
// 内发送状态卡的序号，从 1 开始递增；turn 结束（final 帧发出）或会话销毁时
// 释放，下一轮对话（新 taskId）重新从 1 开始。
//
// 叶子模块：不依赖 conversation/dispatch 层，tools / formatter /
// conversation-manager 均可安全 import（避免循环依赖）。

/** taskId → 本轮对话已发出的状态卡数量（即下一张卡的序号 = 当前值 + 1）。 */
const statusCardSeqByTask = new Map<string, number>();

/** 取本轮对话下一张状态卡的序号（自增并返回，首张为 1）。 */
export function nextStatusCardSeq(taskId: string): number {
  const next = (statusCardSeqByTask.get(taskId) ?? 0) + 1;
  statusCardSeqByTask.set(taskId, next);
  return next;
}

/**
 * 查询指定 taskId 当前时刻最后进入出栈队列的工具状态卡序号；
 * 本 turn 尚未发过卡片时为 0。A2A 消息帧携带该值，端侧把这段流式文本
 * 显示在序号一致的卡片下方（0 表示不在任何卡片下）。
 */
export function getCurrentStatusCardSeq(taskId: string): number {
  return statusCardSeqByTask.get(taskId) ?? 0;
}

/** 释放指定 taskId 的序号状态（turn 结束 / 会话销毁时调用）。幂等。 */
export function releaseStatusCardSeq(taskId: string): void {
  statusCardSeqByTask.delete(taskId);
}
