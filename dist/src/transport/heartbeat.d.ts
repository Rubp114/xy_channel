import WebSocket from "ws";
export interface HeartbeatConfig {
    interval: number;
    timeout: number;
    message: string | (() => string);
}
/**
 * Manages heartbeat for a WebSocket connection.
 * Supports both application-level (30s) and protocol-level (20s) heartbeats.
 */
export declare class HeartbeatManager {
    private ws;
    private config;
    private onTimeout;
    private serverName;
    private onHeartbeatSuccess?;
    private intervalTimer;
    private timeoutTimer;
    private lastPongTime;
    private clockJumpTimer;
    private lastWallMs;
    private lastMonoNs;
    private log;
    private error;
    constructor(ws: WebSocket, config: HeartbeatConfig, onTimeout: () => void, serverName?: string, logFn?: (msg: string, ...args: any[]) => void, errorFn?: (msg: string, ...args: any[]) => void, onHeartbeatSuccess?: () => void);
    /**
     * Start heartbeat monitoring.
     */
    start(): void;
    /**
     * Stop heartbeat monitoring.
     */
    stop(): void;
    /**
     * 时钟跳变探测器（快照冻结/恢复场景）。
     *
     * Node/libuv 定时器基于单调时钟（CLOCK_MONOTONIC），VM 快照冻结期间
     * 单调时钟停走，恢复后挂起的 interval 还需等完剩余延迟才触发——
     * 30s 心跳 interval 意味着死链发现延迟 0-30s（本 tick 自身也是单调
     * 定时器，恢复后最迟 ~1s 内触发，把发现延迟从 0-30s 压到 ~1s）。
     *
     * 每个 tick 对比墙钟（Date.now）与单调时钟（hrtime）的增量：
     * 墙钟相对单调时钟前跳超过阈值，即判定进程刚从快照冻结中恢复：
     * - 距上次 pong 已超一个心跳周期 → 直接判死链，立即 onTimeout 重连；
     * - 否则连接可能仍存活，立即发一次心跳探测（timeout 兜底）。
     */
    private startClockJumpDetector;
    private stopClockJumpDetector;
    /**
     * Send a heartbeat ping.
     */
    private sendHeartbeat;
    /**
     * External notification of connection activity (e.g. app-level heartbeat response received).
     * Updates liveness state and cancels the pending timeout timer.
     */
    notifyActivity(): void;
    /**
     * Check if connection is healthy based on last pong time.
     */
    isHealthy(): boolean;
}
