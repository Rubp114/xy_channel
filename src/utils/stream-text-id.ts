// 流式文本 turn 标识注册表。
//
// 每一轮 turn（一个 taskId）的模型文本流携带一个独立的 uuidv4 streamTextId：
//   - turn 内所有流式帧（含终帧）共享同一 streamTextId（get-or-create 保证稳定）；
//   - turn 内出现分段边界（StepInfo 命令下发）时 rotateStreamTextId 轮换 id，
//     边界之后的文本帧与之前的文本帧使用不同的 streamTextId；
//   - turn 文本输出完成（lastChunk=true 的终帧发出）后释放，下一轮 turn
//     （新 taskId）开始时生成新的 streamTextId。
//
// 叶子模块：不依赖 conversation/dispatch 层，formatter 与 conversation-manager
// 均可安全 import（避免 formatter ↔ conversation-manager 循环依赖）。

import { v4 as uuidv4 } from "uuid";

/** taskId → 本 turn 文本流的 streamTextId。 */
const streamTextIds = new Map<string, string>();

/**
 * 获取（或首次创建）指定 taskId 对应 turn 的 streamTextId。
 * 同一 taskId 的多次调用返回同一 id，直到 releaseStreamTextId 被调用。
 */
export function getOrCreateStreamTextId(taskId: string): string {
  let id = streamTextIds.get(taskId);
  if (!id) {
    id = uuidv4();
    streamTextIds.set(taskId, id);
  }
  return id;
}

/**
 * 释放指定 taskId 的 streamTextId（turn 文本流结束：终帧发出 / 任务链清理）。
 * 幂等，未登记的 taskId 为 no-op。
 */
export function releaseStreamTextId(taskId: string): void {
  streamTextIds.delete(taskId);
}

/**
 * 轮换指定 taskId 的 streamTextId：直接替换为新 id 并返回。
 * 用于 turn 内的分段边界（如 StepInfo 命令下发后），保证边界之后发出的
 * 文本帧与之前的文本帧使用不同的 streamTextId（端侧按 id 聚合文本段）。
 * 未登记时等同 get-or-create 的首次创建。
 */
export function rotateStreamTextId(taskId: string): string {
  const id = uuidv4();
  streamTextIds.set(taskId, id);
  return id;
}
