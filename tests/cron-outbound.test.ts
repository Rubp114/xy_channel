import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  gateCronSendText: vi.fn(),
  closeCronTurn: vi.fn(),
  savePushData: vi.fn(),
  pushBroadcast: vi.fn(),
  log: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

vi.mock("../src/config.js", () => ({
  resolveXYConfig: () => ({ defaultSessionId: "default-session" }),
}));

vi.mock("../src/conversation/cron-buffer.js", () => ({
  gateCronSendText: mocks.gateCronSendText,
  closeCronTurn: mocks.closeCronTurn,
}));

vi.mock("../src/conversation/outbound-gateway.js", () => ({
  pushBroadcast: mocks.pushBroadcast,
  sendWsFrame: vi.fn(),
}));

vi.mock("../src/tools/session-manager.js", () => ({
  getCurrentSessionContext: () => undefined,
}));

vi.mock("../src/conversation/conversation-manager.js", () => ({
  getWaitState: () => undefined,
  addCompletionText: vi.fn(),
}));

vi.mock("../src/utils/pushdata-manager.js", () => ({
  savePushData: mocks.savePushData,
}));

vi.mock("../src/utils/logger.js", () => ({
  logger: {
    log: mocks.log,
    warn: mocks.warn,
    error: mocks.error,
    withContext: () => ({ log: mocks.log, warn: mocks.warn, error: mocks.error }),
  },
}));

import { xyOutbound } from "../src/dispatch/outbound.js";

describe("cron outbound full-text delivery", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.savePushData.mockResolvedValue("push-data-id");
    mocks.pushBroadcast.mockResolvedValue(undefined);
  });

  it("persists and pushes the merged cron text instead of the announce tail", async () => {
    const mergedText = "完整推荐正文\n\n补充参考来源";
    mocks.gateCronSendText.mockReturnValue({
      gate: "announce",
      text: mergedText,
      jobId: "job-1",
      meta: { jobId: "job-1", jobTitle: "每日推荐" },
    });

    await xyOutbound.sendText({
      cfg: {},
      to: "default",
      text: "补充参考来源",
      accountId: "default",
    });

    expect(mocks.savePushData).toHaveBeenCalledWith(mergedText, {
      cronJobId: "job-1",
      cronTitle: "每日推荐",
    });
    expect(mocks.pushBroadcast).toHaveBeenCalledWith(expect.objectContaining({
      text: mergedText,
      title: "完整推荐正文",
      pushDataId: "push-data-id",
      cronJobId: "job-1",
      cronTitle: "每日推荐",
    }));
    expect(mocks.closeCronTurn).toHaveBeenCalledWith("job-1", "announce-delivered");
  });
});
