import { isBelowLegacyAppVersion } from "../utils/app-version.js";

/** 仅在支持 stepinfo 的 App 版本（>= 11.7.10.212）中可见的工具。 */
const STEPINFO_VERSION_GATED_TOOLS = new Set(["ask_user"]);

/**
 * 暂不上线的工具：任何 App 版本都对模型隐藏。
 * ask_user 工具代码与 websocket 应答协议处理保留（见 2004715 引入），
 * 仅屏蔽其在模型工具列表中的可见性；端侧交互卡链路就绪后从此集合移除即可放开。
 */
const ALWAYS_HIDDEN_TOOLS = new Set(["ask_user"]);

/**
 * 按 App 版本过滤动态工具。版本缺失时不暴露门控工具，避免向无法渲染
 * 对应交互卡片的客户端下发指令；未门控工具保持原有行为。
 * 屏蔽优先：ALWAYS_HIDDEN_TOOLS 中的工具一律不进入模型可见列表
 * （只作用于列表过滤，不影响 execute 自检的版本门控语义）。
 */
export function filterToolsByAppVersion(tools: any[], appVer?: string): any[] {
  return tools.filter((tool) => !ALWAYS_HIDDEN_TOOLS.has(tool.name) && isToolVisibleForAppVersion(tool.name, appVer));
}

export function isToolVisibleForAppVersion(toolName: string, appVer?: string): boolean {
  if (!STEPINFO_VERSION_GATED_TOOLS.has(toolName)) return true;
  return typeof appVer === "string" && appVer.length > 0 && !isBelowLegacyAppVersion(appVer);
}
