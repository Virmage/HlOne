/**
 * WebSocket Manager
 *
 * Manages persistent WebSocket connections to Hyperliquid.
 * Subscribes to userFills for all actively copied traders.
 * Handles reconnection, heartbeat, and subscription management.
 */

import WebSocket from "ws";
import { EventEmitter } from "events";

const HL_WS = "wss://api.hyperliquid.xyz/ws";
const HEARTBEAT_INTERVAL = 30_000; // 30s
const RECONNECT_BASE_DELAY = 1_000; // 1s
const RECONNECT_MAX_DELAY = 60_000; // 60s

export interface WsFillEvent {
  coin: string;
  px: string;
  sz: string;
  side: string;
  dir: string;
  closedPnl: string;
  time: number;
  hash: string;
  oid: number;
  crossed: boolean;
  fee: string;
  tid: number;
}

export interface WsMessage {
  channel: string;
  data: {
    user: string;
    fills: WsFillEvent[];
    isSnapshot: boolean;
  };
}

export class WsManager extends EventEmitter {
  private ws: WebSocket | null = null;
  private subscriptions = new Map<string, number>(); // address -> subscription count
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectAttempts = 0;
  private isShuttingDown = false;
  private pendingSubscriptions: string[] = [];

  constructor() {
    super();
  }

  async connect(): Promise<void> {
    if (this.ws?.readyState === WebSocket.OPEN) return;

    return new Promise((resolve, reject) => {
      console.log("[WS] Connecting to Hyperliquid...");
      this.ws = new WebSocket(HL_WS);

      this.ws.on("open", () => {
        console.log("[WS] Connected");
        this.reconnectAttempts = 0;
        this.startHeartbeat();

        // Resubscribe to all tracked addresses
        for (const address of this.subscriptions.keys()) {
          this.sendSubscribe(address);
        }

        // Process any pending subscriptions
        for (const addr of this.pendingSubscriptions) {
          this.sendSubscribe(addr);
          this.subscriptions.set(addr, (this.subscriptions.get(addr) || 0) + 1);
        }
        this.pendingSubscriptions = [];

        this.emit("connected");
        resolve();
      });

      this.ws.on("message", (data: WebSocket.Data) => {
        try {
          const msg = JSON.parse(data.toString());
          this.handleMessage(msg);
        } catch (err) {
          console.error("[WS] Failed to parse message:", err);
        }
      });

      this.ws.on("close", (code, reason) => {
        console.log(`[WS] Disconnected: ${code} ${reason.toString()}`);
        this.stopHeartbeat();
        if (!this.isShuttingDown) {
          this.scheduleReconnect();
        }
        this.emit("disconnected", code);
      });

      this.ws.on("error", (err) => {
        console.error("[WS] Error:", err.message);
        this.emit("error", err);
        // Don't reject on error during reconnect attempts
        if (this.reconnectAttempts === 0) {
          reject(err);
        }
      });

      this.ws.on("pong", () => {
        // Heartbeat acknowledged
      });
    });
  }

  private handleMessage(msg: unknown) {
    if (!msg || typeof msg !== "object") return;

    const message = msg as Record<string, unknown>;

    // Subscription confirmation
    if (message.channel === "subscriptionResponse") {
      return;
    }

    // User fills
    if (message.channel === "userFills") {
      const data = message.data as WsMessage["data"];
      if (!data) return;

      // Skip snapshot messages — we only care about live fills
      if (data.isSnapshot) {
        console.log(`[WS] Received snapshot for ${data.user} (${data.fills?.length || 0} fills)`);
        return;
      }

      if (data.fills && data.fills.length > 0) {
        for (const fill of data.fills) {
          this.emit("fill", {
            traderAddress: data.user,
            fill,
          });
        }
      }
    }

    // User events (fills + funding + liquidations)
    if (message.channel === "userEvents") {
      const data = message.data as Record<string, unknown>;
      if (data && Array.isArray(data.events)) {
        for (const event of data.events) {
          if (event && typeof event === "object" && "fill" in event) {
            // This is a fill event within userEvents
            this.emit("fill", {
              traderAddress: (data as { user: string }).user,
              fill: (event as { fill: WsFillEvent }).fill,
            });
          }
        }
      }
    }
  }

  subscribe(traderAddress: string) {
    const count = this.subscriptions.get(traderAddress) || 0;
    this.subscriptions.set(traderAddress, count + 1);

    if (this.ws?.readyState === WebSocket.OPEN) {
      this.sendSubscribe(traderAddress);
    } else {
      this.pendingSubscriptions.push(traderAddress);
    }

    console.log(`[WS] Subscribed to fills for ${traderAddress}`);
  }

  unsubscribe(traderAddress: string) {
    const count = this.subscriptions.get(traderAddress) || 0;
    if (count <= 1) {
      this.subscriptions.delete(traderAddress);
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.sendUnsubscribe(traderAddress);
      }
    } else {
      this.subscriptions.set(traderAddress, count - 1);
    }
    console.log(`[WS] Unsubscribed from fills for ${traderAddress}`);
  }

  private sendSubscribe(address: string) {
    this.ws?.send(
      JSON.stringify({
        method: "subscribe",
        subscription: {
          type: "userFills",
          user: address,
        },
      })
    );
  }

  private sendUnsubscribe(address: string) {
    this.ws?.send(
      JSON.stringify({
        method: "unsubscribe",
        subscription: {
          type: "userFills",
          user: address,
        },
      })
    );
  }

  private startHeartbeat() {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.ping();
      }
    }, HEARTBEAT_INTERVAL);
  }

  private stopHeartbeat() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private scheduleReconnect() {
    if (this.reconnectTimer) return;

    const delay = Math.min(
      RECONNECT_BASE_DELAY * Math.pow(2, this.reconnectAttempts),
      RECONNECT_MAX_DELAY
    );
    this.reconnectAttempts++;

    console.log(`[WS] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})`);

    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      try {
        await this.connect();
      } catch {
        // connect() will trigger another close event which will call scheduleReconnect
      }
    }, delay);
  }

  getSubscriptionCount(): number {
    return this.subscriptions.size;
  }

  getSubscribedAddresses(): string[] {
    return [...this.subscriptions.keys()];
  }

  isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  async shutdown() {
    this.isShuttingDown = true;
    this.stopHeartbeat();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.close(1000, "Shutdown");
      this.ws = null;
    }
    console.log("[WS] Shut down");
  }
}
