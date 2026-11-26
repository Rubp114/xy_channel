import { describe, expect, it } from "vitest";
import {
  filterToolsByAppVersion,
  isToolVisibleForAppVersion,
} from "../src/tools/tool-visibility.js";

const tools = [{ name: "create_note" }, { name: "ask_user" }];

describe("app-version tool visibility", () => {
  // 版本门控谓词语义不变：达到阈值即视为支持
  it.each(["11.7.10.212", "11.7.10.213", "11.7.11.0", "12.0.0.0"])(
    "isToolVisibleForAppVersion still gates ask_user by version: %s",
    (appVer) => {
      expect(isToolVisibleForAppVersion("ask_user", appVer)).toBe(true);
    },
  );

  // 但 ask_user 处于屏蔽状态（ALWAYS_HIDDEN_TOOLS）：列表过滤任何版本都不放行
  it.each(["11.7.10.212", "11.7.10.213", "11.7.11.0", "12.0.0.0"])(
    "filterToolsByAppVersion hides ask_user at or above the threshold while masked: %s",
    (appVer) => {
      expect(filterToolsByAppVersion(tools, appVer).map((tool) => tool.name)).toEqual([
        "create_note",
      ]);
    },
  );

  it.each(["10.0.0.0", "11.7.8.357", "11.7.9.330", "11.7.10.0", "11.7.10.211"])(
    "hides ask_user below the stepinfo threshold: %s",
    (appVer) => {
      expect(filterToolsByAppVersion(tools, appVer).map((tool) => tool.name)).toEqual([
        "create_note",
      ]);
    },
  );

  it.each([undefined, ""])("hides ask_user when appVer is unavailable: %s", (appVer) => {
    expect(filterToolsByAppVersion(tools, appVer).map((tool) => tool.name)).toEqual([
      "create_note",
    ]);
  });

  it("does not change visibility for ungated tools", () => {
    expect(isToolVisibleForAppVersion("create_note", "1.0.0.0")).toBe(true);
    expect(isToolVisibleForAppVersion("create_note")).toBe(true);
  });
});
