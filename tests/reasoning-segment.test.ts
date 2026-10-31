import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  sendReasoningTextUpdate: vi.fn(),
  sendA2AResponse: vi.fn(),
  sendStatusUpdate: vi.fn(),
  sendDisplayTaskCardData: vi.fn(),
  sendExecuteStatusCard: vi.fn(),
  log: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

vi.mock("../src/formatter.js", () => ({
  sendReasoningTextUpdate: mocks.sendReasoningTextUpdate,
  sendA2AResponse: mocks.sendA2AResponse,
  sendStatusUpdate: mocks.sendStatusUpdate,
  sendDisplayTaskCardData: mocks.sendDisplayTaskCardData,
  sendExecuteStatusCard: mocks.sendExecuteStatusCard,
}));

vi.mock("../src/utils/logger.js", () => ({
  logger: {
    withContext: () => ({ log: mocks.log, warn: mocks.warn, error: mocks.error }),
    log: mocks.log,
    warn: mocks.warn,
    error: mocks.error,
  },
}));

import {
  noteReasoningSnapshot,
  peekReasoningSegmentText,
  isReasoningSegmentOpen,
  closeReasoningSegment,
  cutReasoningSegment,
  releaseReasoningSegment,
} from "../src/utils/reasoning-segment.js";
import {
  getOrCreateSession,
  rotateStreamingTextSegment,
  deleteSession,
  listSessions,
} from "../src/conversation/conversation-manager.js";
import {
  getOrCreateStreamingTextId,
  releaseStreamingTextId,
} from "../src/utils/streaming-text-id.js";
import { releaseThinkIndex } from "../src/utils/think-index.js";
import {
  markLastChunkBlock,
  markReasoningBlockEnd,
  peekLastReasoningBlockSeq,
  getAccumulatedThinkIndex,
} from "../src/utils/think-index.js";

describe("reasoning-segment registry", () => {
  const taskId = "task-seg-unit";

  afterEach(() => {
    releaseReasoningSegment(taskId);
  });

  it("returns the full snapshot as segment before any cut", () => {
    expect(noteReasoningSnapshot(taskId, "思考中")).toBe("思考中");
    expect(isReasoningSegmentOpen(taskId)).toBe(true);
    expect(peekReasoningSegmentText(taskId)).toBe("思考中");
  });

  it("strips the cut base from cumulative snapshots after a boundary", () => {
    noteReasoningSnapshot(taskId, "前半段");
    closeReasoningSegment(taskId);
    cutReasoningSegment(taskId);
    expect(peekReasoningSegmentText(taskId)).toBe("");
    // SDK 跨边界续流：全量快照仍含边界前文本 → 只下发增量段
    expect(noteReasoningSnapshot(taskId, "前半段后半段")).toBe("后半段");
    expect(isReasoningSegmentOpen(taskId)).toBe(true);
    expect(peekReasoningSegmentText(taskId)).toBe("后半段");
  });

  it("treats a snapshot that no longer starts with the base as a new block", () => {
    noteReasoningSnapshot(taskId, "旧块内容");
    cutReasoningSegment(taskId);
    expect(noteReasoningSnapshot(taskId, "全新思考块")).toBe("全新思考块");
    expect(peekReasoningSegmentText(taskId)).toBe("全新思考块");
  });

  it("returns an empty segment when the snapshot adds nothing beyond the base", () => {
    noteReasoningSnapshot(taskId, "完整内容");
    closeReasoningSegment(taskId);
    cutReasoningSegment(taskId);
    // 边界切分后 SDK 重放旧段内容：段文本为空，且不应置位 open
    expect(noteReasoningSnapshot(taskId, "完整内容")).toBe("");
    expect(isReasoningSegmentOpen(taskId)).toBe(false);
  });

  it("keeps the segment text stable across repeated cumulative snapshots", () => {
    noteReasoningSnapshot(taskId, "思考内容A");
    closeReasoningSegment(taskId);
    cutReasoningSegment(taskId);
    expect(noteReasoningSnapshot(taskId, "思考内容A思考内容B")).toBe("思考内容B");
    // 同一快照重放：段文本按基线剥离保持幂等（append:false 重发同段是安全的）
    expect(noteReasoningSnapshot(taskId, "思考内容A思考内容B")).toBe("思考内容B");
    expect(peekReasoningSegmentText(taskId)).toBe("思考内容B");
    expect(isReasoningSegmentOpen(taskId)).toBe(true);
  });
});

describe("think-index last reasoning block tracking", () => {
  const taskId = "task-thinkidx";

  afterEach(() => {
    releaseThinkIndex(taskId);
  });

  it("records the latest closed reasoning block while keeping all blocks in the list", () => {
    markReasoningBlockEnd(taskId, 1);
    markReasoningBlockEnd(taskId, 2);
    markLastChunkBlock(taskId, 3); // 中间正文段只入列表，不覆盖最近思考块
    expect(getAccumulatedThinkIndex(taskId)).toEqual(["1", "2", "3"]);
    expect(peekLastReasoningBlockSeq(taskId)).toBe("2");
  });

  it("dedups blocks sharing the same seq (同 seq 即同一块)", () => {
    markReasoningBlockEnd(taskId, 1);
    markReasoningBlockEnd(taskId, 1);
    expect(getAccumulatedThinkIndex(taskId)).toEqual(["1"]);
    expect(peekLastReasoningBlockSeq(taskId)).toBe("1");
  });

  it("returns undefined when no reasoning block has closed", () => {
    markLastChunkBlock(taskId, 1);
    expect(peekLastReasoningBlockSeq(taskId)).toBeUndefined();
  });

  it("release clears both the list and the last-reasoning record", () => {
    markReasoningBlockEnd(taskId, 1);
    releaseThinkIndex(taskId);
    expect(getAccumulatedThinkIndex(taskId)).toEqual([]);
    expect(peekLastReasoningBlockSeq(taskId)).toBeUndefined();
  });
});

describe("rotateStreamingTextSegment reasoning close", () => {
  const sessionId = "sess-seg";
  const taskId = "task-seg";
  const messageId = "msg-seg";
  const config = {} as never;

  beforeEach(() => {
    mocks.sendReasoningTextUpdate.mockResolvedValue(undefined);
    mocks.sendA2AResponse.mockResolvedValue(undefined);
  });

  afterEach(() => {
    for (const session of listSessions()) {
      deleteSession(session.sessionId);
    }
    releaseReasoningSegment(taskId);
    releaseStreamingTextId(taskId);
    releaseThinkIndex(taskId);
    vi.clearAllMocks();
  });

  it("closes an open reasoning segment with the old id before rotating", async () => {
    getOrCreateSession(sessionId);
    const oldId = getOrCreateStreamingTextId(taskId);
    noteReasoningSnapshot(taskId, "思考前半段");

    const newId = await rotateStreamingTextSegment({ config, sessionId, taskId, messageId });
    expect(newId).not.toBe(oldId);

    // 旧 id 补发思考收尾帧：完整段文本 + lastChunk=true + isReasoningFinished=false
    expect(mocks.sendReasoningTextUpdate).toHaveBeenCalledTimes(1);
    expect(mocks.sendReasoningTextUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId,
        text: "思考前半段",
        append: false,
        lastChunk: true,
        isReasoningFinished: false,
        streamingTextId: oldId,
      }),
    );
    expect(isReasoningSegmentOpen(taskId)).toBe(false);
    // 基线已切分：后续续流快照只下发增量段
    expect(noteReasoningSnapshot(taskId, "思考前半段思考后半段")).toBe("思考后半段");
  });

  it("rotates without a close frame when no reasoning segment is open", async () => {
    getOrCreateSession(sessionId);
    await rotateStreamingTextSegment({ config, sessionId, taskId, messageId });
    expect(mocks.sendReasoningTextUpdate).not.toHaveBeenCalled();
  });

  it("does not send a second close frame when the segment is already closed", async () => {
    getOrCreateSession(sessionId);
    noteReasoningSnapshot(taskId, "思考内容");
    // 模拟 onReasoningEnd 已收尾（结束标记帧已入队）
    closeReasoningSegment(taskId);

    await rotateStreamingTextSegment({ config, sessionId, taskId, messageId });
    expect(mocks.sendReasoningTextUpdate).not.toHaveBeenCalled();
    // 但基线仍切分：新 id 的思考帧不得携带边界前文本
    expect(noteReasoningSnapshot(taskId, "思考内容追加")).toBe("追加");
  });
});
