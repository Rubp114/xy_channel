/** 窗口内丢弃帧计数（按会话；置窗清零，解除时随日志汇总输出后释放）。 */
interface SuppressionDropCounts {
    reasoning: number;
    text: number;
    card: number;
}
/** 流式产出活动登记（dispatcher 思考/正文流回调入口调用）。 */
export declare function noteStreamActivity(sessionId: string): void;
/** 流式活动复位（deliver = 一条 assistant 消息完结）。 */
export declare function clearStreamActivity(sessionId: string): void;
/** 查询是否有在途调用正在流式产出（steer 成功时据此决定是否置窗口）。 */
export declare function hasStreamActivity(sessionId: string): boolean;
/** 置抑制窗口。 */
export declare function markSteerSuppression(sessionId: string): void;
/** 查询抑制窗口是否生效。 */
export declare function isSteerSuppressed(sessionId: string): boolean;
/**
 * 窗口内丢帧记账（reasoning=思考帧 / text=正文帧 / card=状态卡）。
 * 不写日志 —— 逐帧日志在流式场景会造成日志风暴，汇总在窗口解除时输出。
 */
export declare function noteSteerSuppressedDrop(sessionId: string, kind: keyof SuppressionDropCounts): void;
/** 解除抑制窗口（assistant message_start / deliver / onIdle 兜底）。幂等。 */
export declare function liftSteerSuppression(sessionId: string): void;
/** 释放会话全部 steer 抑制状态（任务链/会话销毁时调用）。幂等。 */
export declare function releaseSteerSuppression(sessionId: string): void;
export {};
