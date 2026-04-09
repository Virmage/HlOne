import {
  pgTable,
  text,
  timestamp,
  uuid,
  numeric,
  integer,
  boolean,
  jsonb,
  index,
  uniqueIndex,
  real,
} from "drizzle-orm/pg-core";

// ─── Users ───────────────────────────────────────────────────────────────────

export const users = pgTable("users", {
  id: uuid("id").defaultRandom().primaryKey(),
  walletAddress: text("wallet_address").notNull().unique(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

// ─── API / Agent Wallets ─────────────────────────────────────────────────────

export const apiWallets = pgTable("api_wallets", {
  id: uuid("id").defaultRandom().primaryKey(),
  userId: uuid("user_id")
    .references(() => users.id)
    .notNull(),
  agentAddress: text("agent_address").notNull(),
  // Encrypted private key — never stored plaintext
  encryptedPrivateKey: text("encrypted_private_key").notNull(),
  isActive: boolean("is_active").default(true).notNull(),
  expiresAt: timestamp("expires_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// ─── Trader Profiles ─────────────────────────────────────────────────────────

export const traderProfiles = pgTable(
  "trader_profiles",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    address: text("address").notNull().unique(),
    // Cached stats — refreshed periodically
    accountSize: numeric("account_size", { precision: 20, scale: 2 }),
    totalPnl: numeric("total_pnl", { precision: 20, scale: 2 }),
    roiPercent: real("roi_percent"),
    winRate: real("win_rate"),
    tradeCount: integer("trade_count").default(0),
    maxLeverage: real("max_leverage"),
    lastActiveAt: timestamp("last_active_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [index("idx_trader_profiles_pnl").on(table.totalPnl)]
);

// ─── Trader Snapshots (time-series performance data) ─────────────────────────

export const traderSnapshots = pgTable(
  "trader_snapshots",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    traderProfileId: uuid("trader_profile_id")
      .references(() => traderProfiles.id)
      .notNull(),
    accountValue: numeric("account_value", { precision: 20, scale: 2 }),
    totalPnl: numeric("total_pnl", { precision: 20, scale: 2 }),
    roiPercent: real("roi_percent"),
    drawdownPercent: real("drawdown_percent"),
    openPositions: jsonb("open_positions"),
    snapshotAt: timestamp("snapshot_at").defaultNow().notNull(),
  },
  (table) => [
    index("idx_trader_snapshots_trader_time").on(
      table.traderProfileId,
      table.snapshotAt
    ),
  ]
);

// ─── Trader Scores (computed ranking) ────────────────────────────────────────

export const traderScores = pgTable("trader_scores", {
  id: uuid("id").defaultRandom().primaryKey(),
  traderProfileId: uuid("trader_profile_id")
    .references(() => traderProfiles.id)
    .notNull()
    .unique(),
  riskAdjustedReturn: real("risk_adjusted_return"),
  absolutePnlScore: real("absolute_pnl_score"),
  roiScore: real("roi_score"),
  consistencyScore: real("consistency_score"),
  drawdownPenalty: real("drawdown_penalty"),
  recencyScore: real("recency_score"),
  compositeScore: real("composite_score").notNull(),
  rank: integer("rank"),
  computedAt: timestamp("computed_at").defaultNow().notNull(),
});

// ─── Copy Relationships ──────────────────────────────────────────────────────

export const copyRelationships = pgTable(
  "copy_relationships",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id")
      .references(() => users.id)
      .notNull(),
    traderProfileId: uuid("trader_profile_id")
      .references(() => traderProfiles.id)
      .notNull(),
    isActive: boolean("is_active").default(true).notNull(),
    isPaused: boolean("is_paused").default(false).notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("idx_copy_rel_user_trader").on(
      table.userId,
      table.traderProfileId
    ),
  ]
);

// ─── Copy Allocations (capital + risk settings per copy relationship) ────────

export const copyAllocations = pgTable("copy_allocations", {
  id: uuid("id").defaultRandom().primaryKey(),
  copyRelationshipId: uuid("copy_relationship_id")
    .references(() => copyRelationships.id)
    .notNull()
    .unique(),
  allocatedCapital: numeric("allocated_capital", {
    precision: 20,
    scale: 2,
  }).notNull(),
  maxLeverage: real("max_leverage").default(10),
  maxPositionSizePercent: real("max_position_size_percent").default(25),
  minOrderSize: numeric("min_order_size", { precision: 20, scale: 2 }).default(
    "10"
  ),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

// ─── Source Positions (what the trader currently holds) ───────────────────────

export const sourcePositions = pgTable(
  "source_positions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    traderProfileId: uuid("trader_profile_id")
      .references(() => traderProfiles.id)
      .notNull(),
    asset: text("asset").notNull(),
    side: text("side").notNull(), // "long" | "short"
    size: numeric("size", { precision: 20, scale: 6 }).notNull(),
    entryPrice: numeric("entry_price", { precision: 20, scale: 6 }).notNull(),
    leverage: real("leverage"),
    unrealizedPnl: numeric("unrealized_pnl", { precision: 20, scale: 2 }),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("idx_source_pos_trader_asset").on(
      table.traderProfileId,
      table.asset
    ),
  ]
);

// ─── Whale Events (persisted position change alerts) ────────────────────────

export const whaleEvents = pgTable(
  "whale_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    whaleAddress: text("whale_address").notNull(),
    whaleName: text("whale_name").notNull(),
    accountValue: numeric("account_value", { precision: 20, scale: 2 }),
    coin: text("coin").notNull(),
    eventType: text("event_type").notNull(),
    oldSize: numeric("old_size", { precision: 20, scale: 6 }),
    newSize: numeric("new_size", { precision: 20, scale: 6 }),
    positionValueUsd: numeric("position_value_usd", { precision: 20, scale: 2 }),
    price: numeric("price", { precision: 20, scale: 6 }),
    detectedAt: timestamp("detected_at").defaultNow().notNull(),
  },
  (table) => [
    index("idx_whale_events_coin_time").on(table.coin, table.detectedAt),
    index("idx_whale_events_time").on(table.detectedAt),
  ]
);

// ─── Copied Positions (follower's mirrored positions) ────────────────────────

export const copiedPositions = pgTable(
  "copied_positions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    copyRelationshipId: uuid("copy_relationship_id")
      .references(() => copyRelationships.id)
      .notNull(),
    sourcePositionId: uuid("source_position_id").references(
      () => sourcePositions.id
    ),
    asset: text("asset").notNull(),
    side: text("side").notNull(),
    size: numeric("size", { precision: 20, scale: 6 }).notNull(),
    entryPrice: numeric("entry_price", { precision: 20, scale: 6 }).notNull(),
    currentPrice: numeric("current_price", { precision: 20, scale: 6 }),
    unrealizedPnl: numeric("unrealized_pnl", { precision: 20, scale: 2 }),
    realizedPnl: numeric("realized_pnl", { precision: 20, scale: 2 }).default(
      "0"
    ),
    isOpen: boolean("is_open").default(true).notNull(),
    openedAt: timestamp("opened_at").defaultNow().notNull(),
    closedAt: timestamp("closed_at"),
  },
  (table) => [
    index("idx_copied_pos_relationship").on(table.copyRelationshipId),
  ]
);

// ─── Executions (trade execution log) ────────────────────────────────────────

export const executions = pgTable(
  "executions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    copyRelationshipId: uuid("copy_relationship_id")
      .references(() => copyRelationships.id)
      .notNull(),
    sourceTraderAddress: text("source_trader_address").notNull(),
    asset: text("asset").notNull(),
    side: text("side").notNull(),
    direction: text("direction").notNull(), // "Open Long", "Close Short", etc.
    sourceSize: numeric("source_size", { precision: 20, scale: 6 }).notNull(),
    sourcePrice: numeric("source_price", { precision: 20, scale: 6 }).notNull(),
    executedSize: numeric("executed_size", { precision: 20, scale: 6 }),
    executedPrice: numeric("executed_price", { precision: 20, scale: 6 }),
    status: text("status").notNull().default("pending"), // pending, submitted, filled, failed, skipped
    skipReason: text("skip_reason"),
    hyperliquidOrderId: text("hyperliquid_order_id"),
    latencyMs: integer("latency_ms"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    executedAt: timestamp("executed_at"),
  },
  (table) => [
    index("idx_executions_relationship").on(table.copyRelationshipId),
    index("idx_executions_status").on(table.status),
  ]
);

// ─── Manual Overrides ────────────────────────────────────────────────────────

export const manualOverrides = pgTable("manual_overrides", {
  id: uuid("id").defaultRandom().primaryKey(),
  userId: uuid("user_id")
    .references(() => users.id)
    .notNull(),
  copiedPositionId: uuid("copied_position_id")
    .references(() => copiedPositions.id)
    .notNull(),
  action: text("action").notNull(), // "close", "reduce", "increase"
  originalSize: numeric("original_size", { precision: 20, scale: 6 }),
  newSize: numeric("new_size", { precision: 20, scale: 6 }),
  reason: text("reason"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// ─── Portfolio Snapshots (daily account state) ───────────────────────────────

export const portfolioSnapshots = pgTable(
  "portfolio_snapshots",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id")
      .references(() => users.id)
      .notNull(),
    totalAccountValue: numeric("total_account_value", {
      precision: 20,
      scale: 2,
    }),
    allocatedCapital: numeric("allocated_capital", {
      precision: 20,
      scale: 2,
    }),
    unrealizedPnl: numeric("unrealized_pnl", { precision: 20, scale: 2 }),
    realizedPnl: numeric("realized_pnl", { precision: 20, scale: 2 }),
    availableMargin: numeric("available_margin", { precision: 20, scale: 2 }),
    snapshotAt: timestamp("snapshot_at").defaultNow().notNull(),
  },
  (table) => [
    index("idx_portfolio_snapshots_user_time").on(
      table.userId,
      table.snapshotAt
    ),
  ]
);

// ─── Open Interest Snapshots (persisted OI history for chart overlay) ────────

export const oiSnapshots = pgTable(
  "oi_snapshots",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    coin: text("coin").notNull(),
    openInterest: numeric("open_interest", { precision: 20, scale: 2 }).notNull(),
    price: numeric("price", { precision: 20, scale: 6 }).notNull(),
    snapshotAt: timestamp("snapshot_at").defaultNow().notNull(),
  },
  (table) => [
    index("idx_oi_snapshots_coin_time").on(table.coin, table.snapshotAt),
  ]
);

// ─── Top Trader Fills (persisted chart markers, survives server restarts) ───

export const topTraderFills = pgTable(
  "top_trader_fills",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    coin: text("coin").notNull(),
    side: text("side").notNull(), // "buy" or "sell"
    price: numeric("price", { precision: 20, scale: 6 }).notNull(),
    sizeUsd: numeric("size_usd", { precision: 20, scale: 2 }).notNull(),
    trader: text("trader").notNull(), // display name
    address: text("address").notNull(), // wallet address
    accountValue: numeric("account_value", { precision: 20, scale: 2 }),
    fillTime: timestamp("fill_time").notNull(),
  },
  (table) => [
    index("idx_top_trader_fills_coin_time").on(table.coin, table.fillTime),
    index("idx_top_trader_fills_time").on(table.fillTime),
  ]
);
