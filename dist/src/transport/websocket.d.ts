import { EventEmitter } from "events";
import type { RuntimeEnv } from "openclaw/plugin-sdk";
import type { XYChannelConfig, OutboundWebSocketMessage } from "../types.js";
/**
 * Diagnostics for WebSocket connection
 */
export interface ConnectionDiagnostic {
    exists: boolean;
    readyState: string;
    stateConnected: boolean;
    stateReady: boolean;
    reconnectAttempts: number;
    lastHeartbeat: number;
    heartbeatActive: boolean;
    hasReconnectTimer: boolean;
    listenerCount: number;
    isOrphan: boolean;
}
/**
 * Full diagnostics for WebSocket manager
 */
export interface ManagerDiagnostics {
    cacheKey: string;
    connection: ConnectionDiagnostic;
    isShuttingDown: boolean;
    totalEventListeners: number;
}
/**
 * Manages single WebSocket connection to XY server.
 *
 * Events:
 * - 'message': (message: A2AJsonRpcRequest, sessionId: string) => void
 * - 'data-event': (event: A2ADataEvent) => void
 * - 'gui-agent-response': (event: any) => void
 * - 'trigger-event': (event: any) => void
 * - 'connected': () => void
 * - 'disconnected': () => void
 * - 'error': (error: Error) => void
 * - 'ready': () => void
 */
export declare class XYWebSocketManager extends EventEmitter {
    readonly config: XYChannelConfig;
    private runtime?;
    private ws;
    private state;
    private heartbeat;
    private reconnectTimer;
    private isShuttingDown;
    private messageQueue;
    private isBuffering;
    private reconnectBufferTimer;
    private log;
    private error;
    private onHealthEvent?;
    constructor(config: XYChannelConfig, runtime?: RuntimeEnv);
    /**
     * Set health event callback to report activity to OpenClaw framework.
     */
    setHealthEventCallback(callback: () => void): void;
    /**
     * Check if config matches the current instance.
     */
    isConfigMatch(config: XYChannelConfig): boolean;
    /**
     * Connect to WebSocket server.
     * Does not throw error if connection fails - logs warning instead.
     */
    connect(): Promise<void>;
    /**
     * Disconnect from WebSocket server.
     */
    disconnect(): void;
    /**
     * Send a message to the server.
     */
    sendMessage(sessionId: string, message: OutboundWebSocketMessage): Promise<void>;
    /**
     * Check if server is ready.
     */
    isReady(): boolean;
    /**
     * Get detailed connection diagnostics for monitoring and debugging.
     */
    getConnectionDiagnostics(): ManagerDiagnostics;
    /**
     * Get diagnostic info for the connection.
     */
    private getConnectionDiagnostic;
    /**
     * Clean up connection without triggering reconnection.
     */
    private cleanupConnection;
    /**
     * Connect to server.
     */
    private connectServer;
    /**
     * Send init message to server.
     */
    private sendInitMessage;
    /**
     * Start heartbeat.
     */
    private startHeartbeat;
    private toUploadExeDataEvent;
    private toCrossDeviceTaskResultEvent;
    private toRunCrossTaskA2ARequest;
    /**
     * Handle incoming message from server.
     */
    private handleMessage;
    /**
     * Handle connection close.
     */
    private handleClose;
    /**
     * Handle connection activity (protocol pong or app-level heartbeat response).
     * Reports health and flushes the reconnect buffer early instead of waiting the full 10s.
     */
    private handleHeartbeatActivity;
    /**
     * Handle connection error.
     */
    private handleError;
    /**
     * Reconnect with fast-retry-then-backoff schedule.
     * 前几次快速重试（0.5/1/1/2/4s + 随机抖动），之后指数退避封顶 30s。
     * 修复：旧版首次就 1s 起步指数增长，503 场景累计 31s+10s 缓冲 = 42s 才恢复。
     */
    private reconnectServer;
}
