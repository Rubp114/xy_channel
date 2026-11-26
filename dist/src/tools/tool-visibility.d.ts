/**
 * 按 App 版本过滤动态工具。版本缺失时不暴露门控工具，避免向无法渲染
 * 对应交互卡片的客户端下发指令；未门控工具保持原有行为。
 * 屏蔽优先：ALWAYS_HIDDEN_TOOLS 中的工具一律不进入模型可见列表
 * （只作用于列表过滤，不影响 execute 自检的版本门控语义）。
 */
export declare function filterToolsByAppVersion(tools: any[], appVer?: string): any[];
export declare function isToolVisibleForAppVersion(toolName: string, appVer?: string): boolean;
