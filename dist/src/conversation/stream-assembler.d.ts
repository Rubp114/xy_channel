export interface AssemblerSegment {
    kind: "model" | "injected";
    text: string;
}
export interface FinalizeResult {
    /** 终帧应携带的全文本（可能为空字符串 —— 异常路径，调用方回退空帧语义）。 */
    fullText: string;
    /** 最后一轮模型调用的解析文本（canonical 优先），供跨任务结果消息使用。 */
    resolvedLastText: string;
    /** 权威文本与流式累计的对比诊断（无权威文本时为 "no-canonical"）。 */
    diagnostic: "match" | "patched-tail" | "canonical-shorter" | "diverged" | "no-canonical";
}
export declare class StreamAssembler {
    private segments;
    /** 当前模型调用的流式累计文本（同一调用内递增）。 */
    private currentModelText;
    /** deliver(kind=final) 捕获的权威最终文本（最后一次模型调用的 canonical 文本）。 */
    private canonicalFinalText;
    /**
     * onPartialReply 喂入。text 是当前模型调用的累计清洗文本（非增量）。
     * 同一调用内 text 递增；跨调用时 text 刷新（!startsWith），此时把上一个
     * 调用的完整文本锁存为 model 段。
     */
    onStreamText(text: string): {
        fullText: string;
        latched: boolean;
    };
    /**
     * 工具注入非模型文本（如卡片 DSL）。先锁存当前模型文本（保持相对位置），
     * 再把注入内容作为独立段压入。注入后所有全量帧自然携带该段，
     * 客户端 append:false 整体替换不会抹掉注入内容。
     */
    injectArtifact(text: string): string;
    /**
     * deliver(kind=final) 喂入权威文本。调用方必须已排除 compaction 通知和
     * ⚙️ 系统通知（它们不是答案文本）。
     */
    onFinalText(text: string): void;
    /**
     * onIdle 收口：计算终帧全文本。
     * canonical 非空时替换 currentModelText；current 为空（已锁存/无流式）时
     * 替换最后一个 model 段；完全没有 model 内容（ACP 纯 deliver 路径）时
     * fullText 就是 canonical 本身。
     */
    finalize(): FinalizeResult;
    /** 全文本：已锁存段以 "\n" 连接，再接当前模型文本。 */
    getFullText(): string;
    /** 是否有任何已装配内容（已锁存段或当前模型文本非空）。 */
    hasContent(): boolean;
    /** 新 turn 清空（dispatcher 创建时调用；终帧发出后也应复位）。 */
    reset(): void;
}
