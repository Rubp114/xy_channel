// Heartbeat management for WebSocket connections
import WebSocket from "ws";
import { logger } from "../utils/logger.js";

export interface HeartbeatConfig {
  interval: number; // Heartbeat interval in milliseconds
  timeout: number; // Timeout for heartbeat response in milliseconds
  message: string | (() => string); // Heartbeat message to send (factory for fresh timestamp)
}

// ── 时钟跳变探测（快照冻结/恢复场景）──
/** 探测 tick 间隔：恢复后最迟 ~1s 内发现跳变 */
const CLOCK_JUMP_CHECK_INTERVAL_MS = 1000;
/** 判定阈值：墙钟相对单调时钟前跳超过该值视为进程曾被快照冻结 */
const CLOCK_JUMP_THRESHOLD_MS = 5000;

/**
 * Manages heartbeat for a WebSocket connection.
 * Supports both application-level (30s) and protocol-level (20s) heartbeats.
 */
export class HeartbeatManager {
  private intervalTimer: NodeJS.Timeout | null = null;
  private timeoutTimer: NodeJS.Timeout | null = null;
  private lastPongTime: number = 0;

  // 时钟跳变探测器状态
  private clockJumpTimer: NodeJS.Timeout | null = null;
  private lastWallMs: number = 0;
  private lastMonoNs: bigint = 0n;

  // Logging functions following feishu pattern
  private log: (msg: string, ...args: any[]) => void;
  private error: (msg: string, ...args: any[]) => void;

  constructor(
    private ws: WebSocket,
    private config: HeartbeatConfig,
    private onTimeout: () => void,
    private serverName: string = "unknown",
    logFn?: (msg: string, ...args: any[]) => void,
    errorFn?: (msg: string, ...args: any[]) => void,
    private onHeartbeatSuccess?: () => void  // ✅ 新增：心跳成功回调
  ) {
    this.log = logFn ?? ((msg, ...args) => logger.log(msg, ...args));
    this.error = errorFn ?? ((msg, ...args) => logger.error(msg, ...args));
  }

  /**
   * Start heartbeat monitoring.
   */
  start(): void {
    this.stop(); // Clear any existing timers
    this.lastPongTime = Date.now();

    // Setup ping/pong for protocol-level heartbeat
    this.ws.on("pong", () => {
      this.lastPongTime = Date.now();
      if (this.timeoutTimer) {
        clearTimeout(this.timeoutTimer);
        this.timeoutTimer = null;
      }
      // ✅ Report health: heartbeat successful
      this.onHeartbeatSuccess?.();
    });

    // Start interval timer
    this.intervalTimer = setInterval(() => {
      // 时间跳变检测（快照冻结/恢复场景）：距上次 pong 超过一个完整心跳周期，
      // 说明进程被冻结过或链路早已死亡，直接判定死链立即重连，跳过 pong 等待
      const gap = Date.now() - this.lastPongTime;
      if (this.lastPongTime > 0 && gap > this.config.interval + this.config.timeout) {
        this.error(
          `Stale connection detected for ${this.serverName}: no pong for ${gap}ms (exceeds ${this.config.interval + this.config.timeout}ms), forcing reconnect`,
        );
        this.onTimeout();
        return;
      }
      this.sendHeartbeat();
    }, this.config.interval);

    this.startClockJumpDetector();

    this.log(`[DEBUG] Heartbeat started for ${this.serverName}: interval=${this.config.interval}ms`);
  }

  /**
   * Stop heartbeat monitoring.
   */
  stop(): void {
    if (this.intervalTimer) {
      clearInterval(this.intervalTimer);
      this.intervalTimer = null;
    }
    if (this.timeoutTimer) {
      clearTimeout(this.timeoutTimer);
      this.timeoutTimer = null;
    }
    this.stopClockJumpDetector();
    this.log(`[DEBUG] Heartbeat stopped for ${this.serverName}`);
  }

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
  private startClockJumpDetector(): void {
    this.stopClockJumpDetector();
    this.lastWallMs = Date.now();
    this.lastMonoNs = process.hrtime.bigint();

    this.clockJumpTimer = setInterval(() => {
      const nowWallMs = Date.now();
      const nowMonoNs = process.hrtime.bigint();
      const wallDeltaMs = nowWallMs - this.lastWallMs;
      const monoDeltaMs = Number(nowMonoNs - this.lastMonoNs) / 1e6;
      this.lastWallMs = nowWallMs;
      this.lastMonoNs = nowMonoNs;

      const jumpMs = wallDeltaMs - monoDeltaMs;
      if (jumpMs <= CLOCK_JUMP_THRESHOLD_MS) return;

      this.log(
        `[CLOCK-JUMP] Wall clock jumped forward ${Math.round(jumpMs)}ms ` +
          `(wall +${Math.round(wallDeltaMs)}ms, mono +${Math.round(monoDeltaMs)}ms) — snapshot freeze/resume detected`,
      );

      const gapMs = nowWallMs - this.lastPongTime;
      if (this.lastPongTime > 0 && gapMs > this.config.interval + this.config.timeout) {
        this.error(
          `Stale connection detected for ${this.serverName} after clock jump: no pong for ${gapMs}ms (exceeds ${this.config.interval + this.config.timeout}ms), forcing reconnect`,
        );
        this.onTimeout();
      } else {
        this.log(`[CLOCK-JUMP] Gap since last pong is ${gapMs}ms (within tolerance), sending immediate heartbeat probe`);
        this.sendHeartbeat();
      }
    }, CLOCK_JUMP_CHECK_INTERVAL_MS);
    this.clockJumpTimer.unref?.();
  }

  private stopClockJumpDetector(): void {
    if (this.clockJumpTimer) {
      clearInterval(this.clockJumpTimer);
      this.clockJumpTimer = null;
    }
  }

  /**
   * Send a heartbeat ping.
   */
  private sendHeartbeat(): void {
    if (this.ws.readyState !== WebSocket.OPEN) {
      this.log(`Cannot send heartbeat for ${this.serverName}: WebSocket not open`);
      return;
    }

    try {
      // Send application-level heartbeat message（工厂函数时每次现拼，时间戳取当前值）
      const message = typeof this.config.message === "function" ? this.config.message() : this.config.message;
      this.ws.send(message);

      // Send protocol-level ping
      this.ws.ping();

      // Clear any stale pending timeout before arming a new one — the clock-jump
      // probe path can call sendHeartbeat() while a previous timeout is still
      // pending; overwriting it would orphan the old timer and cause a spurious
      // "Heartbeat timeout" (and reconnect) on a healthy connection.
      if (this.timeoutTimer) {
        clearTimeout(this.timeoutTimer);
        this.timeoutTimer = null;
      }

      // Setup timeout timer
      this.timeoutTimer = setTimeout(() => {
        this.error(`Heartbeat timeout for ${this.serverName}`);
        this.onTimeout();
      }, this.config.timeout);
    } catch (error) {
      this.error(`Failed to send heartbeat for ${this.serverName}:`, error);
    }
  }

  /**
   * External notification of connection activity (e.g. app-level heartbeat response received).
   * Updates liveness state and cancels the pending timeout timer.
   */
  notifyActivity(): void {
    this.lastPongTime = Date.now();
    if (this.timeoutTimer) {
      clearTimeout(this.timeoutTimer);
      this.timeoutTimer = null;
    }
  }

  /**
   * Check if connection is healthy based on last pong time.
   */
  isHealthy(): boolean {
    if (this.lastPongTime === 0) {
      return true; // Not started yet
    }
    const timeSinceLastPong = Date.now() - this.lastPongTime;
    return timeSinceLastPong < this.config.interval + this.config.timeout;
  }
}
