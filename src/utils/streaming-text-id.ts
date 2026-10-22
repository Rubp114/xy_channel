// 流式文本 turn 标识注册表。
//
// 每一轮 turn（一个 taskId）的模型文本流携带一个独立的 uuidv4 streamingTextId：
//   - turn 内所有流式帧（含终帧）共享同一 streamingTextId（get-or-create 保证稳定）；
//   - turn 内出现分段边界（工具调用/返回，见 step-info-tool）时
//     rotateStreamingTextId 轮换 id，边界之后的文本帧与之前的文本帧使用不同的
//     streamingTextId；
//   - turn 文本输出完成（lastChunk=true 的终帧发出）后释放，下一轮 turn
//     （新 taskId）开始时生成新的 streamingTextId。
//
// 叶子模块：不依赖 conversation/dispatch 层，formatter 与 conversation-manager
// 均可安全 import（避免 formatter ↔ conversation-manager 循环依赖）。

import { v4 as uuidv4 } from "uuid";

/** taskId → 本 turn 文本流的 streamingTextId。 */
const streamingTextIds = new Map<string, string>();

/**
 * 获取（或首次创建）指定 taskId 对应 turn 的 streamingTextId。
 * 同一 taskId 的多次调用返回同一 id，直到 releaseStreamingTextId 被调用。
 */
export function getOrCreateStreamingTextId(taskId: string): string {
  let id = streamingTextIds.get(taskId);
  if (!id) {
    id = uuidv4();
    streamingTextIds.set(taskId, id);
  }
  return id;
}

/**
 * 释放指定 taskId 的 streamingTextId（turn 文本流结束：终帧发出 / 任务链清理）。
 * 幂等，未登记的 taskId 为 no-op。
 */
export function releaseStreamingTextId(taskId: string): void {
  streamingTextIds.delete(taskId);
}

/**
 * 轮换指定 taskId 的 streamingTextId：直接替换为新 id 并返回。
 * 用于 turn 内的分段边界（工具调用/返回时），保证边界之后发出的
 * 文本帧与之前的文本帧使用不同的 streamingTextId（端侧按 id 聚合文本段）。
 * 未登记时等同 get-or-create 的首次创建。
 */
export function rotateStreamingTextId(taskId: string): string {
  const id = uuidv4();
  streamingTextIds.set(taskId, id);
  return id;
}
