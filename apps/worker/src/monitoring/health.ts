/**
 * Health & Monitoring System
 *
 * - Exposes /health endpoint for orchestrator health checks
 * - Tracks metrics: latency, fill count, error rate, queue depth
 * - Alerts on: disconnection, high error rate, stale fills, queue backup
 */

import http from "http";
import type { WsManager } from "../services/ws-manager.js";
import type { Queue } from "bullmq";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyQueue = Queue<any, any, any>;

export interface HealthStatus {
  status: "healthy" | "degraded" | "unhealthy";
  uptime: number;
  websocket: {
    connected: boolean;
    subscriptions: number;
  };
  queues: {
    [name: string]: {
      waiting: number;
      active: number;
      failed: number;
    };
  };
  metrics: {
    fillsProcessed: number;
    ordersSubmitted: number;
    ordersSkipped: number;
    ordersFailed: number;
    avgLatencyMs: number;
    errorRate: number;
  };
  alerts: string[];
}

export class HealthMonitor {
  private startTime = Date.now();
  private server: http.Server | null = null;
  private metrics = {
    fillsProcessed: 0,
    ordersSubmitted: 0,
    ordersSkipped: 0,
    ordersFailed: 0,
    latencies: [] as number[],
    lastFillTime: 0,
    errors: [] as { time: number; message: string }[],
  };
  private alertCallbacks: ((alert: string) => void)[] = [];

  constructor(
    private wsManager: WsManager,
    private queues: Map<string, AnyQueue>
  ) {}

  // ─── Metric recording ───────────────────────────────────────────────

  recordFill() {
    this.metrics.fillsProcessed++;
    this.metrics.lastFillTime = Date.now();
  }

  recordOrderSubmitted(latencyMs: number) {
    this.metrics.ordersSubmitted++;
    this.metrics.latencies.push(latencyMs);
    // Keep only last 100 latencies
    if (this.metrics.latencies.length > 100) {
      this.metrics.latencies.shift();
    }
  }

  recordOrderSkipped() {
    this.metrics.ordersSkipped++;
  }

  recordOrderFailed(error: string) {
    this.metrics.ordersFailed++;
    this.metrics.errors.push({ time: Date.now(), message: error });
    // Keep only last 50 errors
    if (this.metrics.errors.length > 50) {
      this.metrics.errors.shift();
    }
  }

  recordError(error: string) {
    this.metrics.errors.push({ time: Date.now(), message: error });
    if (this.metrics.errors.length > 50) {
      this.metrics.errors.shift();
    }
  }

  onAlert(callback: (alert: string) => void) {
    this.alertCallbacks.push(callback);
  }

  private emitAlert(message: string) {
    console.warn(`[ALERT] ${message}`);
    for (const cb of this.alertCallbacks) {
      cb(message);
    }
  }

  // ─── Health check ───────────────────────────────────────────────────

  async getHealth(): Promise<HealthStatus> {
    const alerts: string[] = [];
    let status: "healthy" | "degraded" | "unhealthy" = "healthy";

    // Check WebSocket
    if (!this.wsManager.isConnected()) {
      alerts.push("WebSocket disconnected from Hyperliquid");
      status = "unhealthy";
    }

    // Check for stale fills (no fills in 5 minutes when subscribed)
    if (
      this.wsManager.getSubscriptionCount() > 0 &&
      this.metrics.lastFillTime > 0 &&
      Date.now() - this.metrics.lastFillTime > 300_000
    ) {
      alerts.push("No fills received in 5+ minutes despite active subscriptions");
      status = status === "unhealthy" ? "unhealthy" : "degraded";
    }

    // Check error rate (last 10 minutes)
    const recentErrors = this.metrics.errors.filter(
      (e) => Date.now() - e.time < 600_000
    );
    const totalRecent = this.metrics.ordersSubmitted + this.metrics.ordersFailed;
    const errorRate = totalRecent > 0
      ? this.metrics.ordersFailed / totalRecent
      : 0;

    if (errorRate > 0.5 && totalRecent > 5) {
      alerts.push(`High error rate: ${(errorRate * 100).toFixed(1)}%`);
      status = "unhealthy";
    } else if (errorRate > 0.2 && totalRecent > 5) {
      alerts.push(`Elevated error rate: ${(errorRate * 100).toFixed(1)}%`);
      status = status === "unhealthy" ? "unhealthy" : "degraded";
    }

    // Check queue depths
    const queueStats: HealthStatus["queues"] = {};
    for (const [name, queue] of this.queues) {
      const counts = await queue.getJobCounts("waiting", "active", "failed");
      queueStats[name] = {
        waiting: counts.waiting || 0,
        active: counts.active || 0,
        failed: counts.failed || 0,
      };

      if ((counts.waiting || 0) > 100) {
        alerts.push(`Queue "${name}" has ${counts.waiting} waiting jobs`);
        status = status === "unhealthy" ? "unhealthy" : "degraded";
      }

      if ((counts.failed || 0) > 50) {
        alerts.push(`Queue "${name}" has ${counts.failed} failed jobs`);
        status = status === "unhealthy" ? "unhealthy" : "degraded";
      }
    }

    // Average latency
    const avgLatency =
      this.metrics.latencies.length > 0
        ? this.metrics.latencies.reduce((a, b) => a + b, 0) /
          this.metrics.latencies.length
        : 0;

    if (avgLatency > 5000) {
      alerts.push(`High average latency: ${avgLatency.toFixed(0)}ms`);
      status = status === "unhealthy" ? "unhealthy" : "degraded";
    }

    // Emit new alerts
    for (const alert of alerts) {
      this.emitAlert(alert);
    }

    return {
      status,
      uptime: Date.now() - this.startTime,
      websocket: {
        connected: this.wsManager.isConnected(),
        subscriptions: this.wsManager.getSubscriptionCount(),
      },
      queues: queueStats,
      metrics: {
        fillsProcessed: this.metrics.fillsProcessed,
        ordersSubmitted: this.metrics.ordersSubmitted,
        ordersSkipped: this.metrics.ordersSkipped,
        ordersFailed: this.metrics.ordersFailed,
        avgLatencyMs: Math.round(avgLatency),
        errorRate,
      },
      alerts,
    };
  }

  // ─── HTTP health endpoint ───────────────────────────────────────────

  startServer(port: number = 3002) {
    this.server = http.createServer(async (req, res) => {
      if (req.url === "/health") {
        const health = await this.getHealth();
        const statusCode = health.status === "healthy" ? 200 : health.status === "degraded" ? 200 : 503;
        res.writeHead(statusCode, { "Content-Type": "application/json" });
        res.end(JSON.stringify(health, null, 2));
      } else if (req.url === "/metrics") {
        // Prometheus-compatible metrics endpoint
        const health = await this.getHealth();
        const lines = [
          `# HELP copy_fills_total Total fills processed`,
          `# TYPE copy_fills_total counter`,
          `copy_fills_total ${health.metrics.fillsProcessed}`,
          `# HELP copy_orders_total Total orders by status`,
          `# TYPE copy_orders_total counter`,
          `copy_orders_total{status="submitted"} ${health.metrics.ordersSubmitted}`,
          `copy_orders_total{status="skipped"} ${health.metrics.ordersSkipped}`,
          `copy_orders_total{status="failed"} ${health.metrics.ordersFailed}`,
          `# HELP copy_latency_avg_ms Average order latency`,
          `# TYPE copy_latency_avg_ms gauge`,
          `copy_latency_avg_ms ${health.metrics.avgLatencyMs}`,
          `# HELP copy_ws_connected WebSocket connection status`,
          `# TYPE copy_ws_connected gauge`,
          `copy_ws_connected ${health.websocket.connected ? 1 : 0}`,
          `# HELP copy_ws_subscriptions Active WebSocket subscriptions`,
          `# TYPE copy_ws_subscriptions gauge`,
          `copy_ws_subscriptions ${health.websocket.subscriptions}`,
          `# HELP copy_uptime_seconds Worker uptime`,
          `# TYPE copy_uptime_seconds gauge`,
          `copy_uptime_seconds ${Math.floor(health.uptime / 1000)}`,
        ];
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end(lines.join("\n") + "\n");
      } else {
        res.writeHead(404);
        res.end("Not found");
      }
    });

    this.server.listen(port, () => {
      console.log(`[HEALTH] Health server on port ${port}`);
    });
  }

  stop() {
    this.server?.close();
  }
}
