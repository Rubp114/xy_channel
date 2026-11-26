import type { EnvConfig, FormattedSkill, ToolSearchResult } from "./types.js";
export declare function extractUserQuery(fullPrompt: string): string;
export declare function readEnvFile(filePath: string): EnvConfig;
export declare function getSkillsInDirectory(dirPath: string): string[];
export declare function getInstalledSkills(): string[];
export declare function buildExcludedSkillIds(excludedSkills?: string[]): Set<string>;
export interface SearchToolsOptions {
    query: string;
    maxTools?: number;
    includeUninstalledOnly?: boolean;
    envFilePath?: string;
    serviceUrl?: string;
    apiKey?: string;
    uid?: string;
    timeoutMs?: number;
    configExcludedSkills?: string[];
    dynamicSkillEnabled?: boolean;
}
export declare function searchTools(options: SearchToolsOptions): Promise<ToolSearchResult | null>;
export declare function formatToolsForContext(result: ToolSearchResult): string;
export declare function formatDynamicSkillsForContext(skills: FormattedSkill[]): string;
