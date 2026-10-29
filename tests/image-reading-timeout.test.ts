import { beforeEach, describe, expect, it, vi } from "vitest";
import { PassThrough } from "stream";

// ── Mocks ─────────────────────────────────────────────────────────
const mocks = vi.hoisted(() => ({
  fetch: vi.fn(),
  getCurrentSessionContext: vi.fn(),
}));

vi.mock("node-fetch", () => ({
  default: mocks.fetch,
}));

vi.mock("../src/tools/session-manager.js", () => ({
  getCurrentSessionContext: mocks.getCurrentSessionContext,
}));

// file-upload 在本地文件路径分支才会用到；本测试只传远程 URL，走不到它
vi.mock("../src/file-upload.js", () => ({
  XYFileUploadService: class {},
}));

import { imageReadingTool } from "../src/tools/image-reading-tool.js";

function makeResponse(body: NodeJS.ReadableStream | null, ok = true, status = 200) {
  return { ok, status, statusText: "OK", body };
}

function makeStream() {
  return new PassThrough();
}

describe("image_reading SSE stream termination", () => {
  const baseCtx = {
    config: {
      fileUploadUrl: "https://celia.example.com",
      apiKey: "key",
      uid: "uid",
    },
    sessionId: "sess-1",
    taskId: "task-1",
    messageId: "msg-1",
  };

  beforeEach(() => {
    vi.restoreAllMocks();
    mocks.fetch.mockReset();
    mocks.getCurrentSessionContext.mockReset();
    mocks.getCurrentSessionContext.mockReturnValue(baseCtx);
  });

  it("应把 AbortSignal 传给 fetch（替代失效的 timeout 选项）", async () => {
    const stream = makeStream();
    mocks.fetch.mockResolvedValue(makeResponse(stream));

    const donePromise = imageReadingTool.execute("c1", {
      images: ["https://cdn.example.com/a.jpg"],
      prompt: "描述",
    });

    // 等 fetch 被调用时捕获 signal
    await vi.waitFor(() => expect(mocks.fetch).toHaveBeenCalledTimes(1), { timeout: 2000 });
    const [, init] = mocks.fetch.mock.calls[0];
    // fetch 必须带 signal（AbortController），不再依赖已失效的 timeout
    expect(init.signal).toBeDefined();
    expect(init.signal).toHaveProperty("aborted", false);

    // 让流式响应返回正常结果
    stream.write('data: {"abilityInfos":[{"actionExecutorResult":{"reply":{"streamInfo":{"streamContent":"一张猫的图片"}}}}]}\n\n');
    stream.write("data: [DONE]\n\n");

    const result = await donePromise;
    const parsed = JSON.parse((result.content[0] as any).text);
    expect(parsed.success).toBe(true);
    expect(parsed.caption).toContain("猫");
  });

  it("收到 [DONE] 后应提前 break，不傻等 EOF（防止 for await 无限挂起）", async () => {
    const stream = makeStream();
    mocks.fetch.mockResolvedValue(makeResponse(stream));

    const donePromise = imageReadingTool.execute("c2", {
      images: ["https://cdn.example.com/a.jpg"],
      prompt: "描述",
    });

    await vi.waitFor(() => expect(mocks.fetch).toHaveBeenCalledTimes(1), { timeout: 2000 });

    // 只发 [DONE]，然后把流“永远不结束”（不调 stream.end()）——
    // 旧代码会因 [DONE] 不 break 而无限挂起；新代码应在此限时内正常返回。
    stream.write("data: [DONE]\n\n");

    const result = await Promise.race([
      donePromise,
      new Promise<any>((_, reject) =>
        setTimeout(() => reject(new Error("test timeout: stream did not terminate on [DONE]")), 5000),
      ),
    ]);
    // 结果可能 success=false（没有 caption），但绝不能永远卡住 ——
    // 只要 execute 能返回就说明 [DONE] 触发了提前 break
    expect(result).toBeDefined();
    expect(Array.isArray(result.content)).toBe(true);
  });
});
