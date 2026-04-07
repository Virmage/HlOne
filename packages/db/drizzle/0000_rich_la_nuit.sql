CREATE TABLE "api_wallets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"agent_address" text NOT NULL,
	"encrypted_private_key" text NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"expires_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "copied_positions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"copy_relationship_id" uuid NOT NULL,
	"source_position_id" uuid,
	"asset" text NOT NULL,
	"side" text NOT NULL,
	"size" numeric(20, 6) NOT NULL,
	"entry_price" numeric(20, 6) NOT NULL,
	"current_price" numeric(20, 6),
	"unrealized_pnl" numeric(20, 2),
	"realized_pnl" numeric(20, 2) DEFAULT '0',
	"is_open" boolean DEFAULT true NOT NULL,
	"opened_at" timestamp DEFAULT now() NOT NULL,
	"closed_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "copy_allocations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"copy_relationship_id" uuid NOT NULL,
	"allocated_capital" numeric(20, 2) NOT NULL,
	"max_leverage" real DEFAULT 10,
	"max_position_size_percent" real DEFAULT 25,
	"min_order_size" numeric(20, 2) DEFAULT '10',
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "copy_allocations_copy_relationship_id_unique" UNIQUE("copy_relationship_id")
);
--> statement-breakpoint
CREATE TABLE "copy_relationships" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"trader_profile_id" uuid NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"is_paused" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "executions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"copy_relationship_id" uuid NOT NULL,
	"source_trader_address" text NOT NULL,
	"asset" text NOT NULL,
	"side" text NOT NULL,
	"direction" text NOT NULL,
	"source_size" numeric(20, 6) NOT NULL,
	"source_price" numeric(20, 6) NOT NULL,
	"executed_size" numeric(20, 6),
	"executed_price" numeric(20, 6),
	"status" text DEFAULT 'pending' NOT NULL,
	"skip_reason" text,
	"hyperliquid_order_id" text,
	"latency_ms" integer,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"executed_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "manual_overrides" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"copied_position_id" uuid NOT NULL,
	"action" text NOT NULL,
	"original_size" numeric(20, 6),
	"new_size" numeric(20, 6),
	"reason" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "portfolio_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"total_account_value" numeric(20, 2),
	"allocated_capital" numeric(20, 2),
	"unrealized_pnl" numeric(20, 2),
	"realized_pnl" numeric(20, 2),
	"available_margin" numeric(20, 2),
	"snapshot_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "source_positions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"trader_profile_id" uuid NOT NULL,
	"asset" text NOT NULL,
	"side" text NOT NULL,
	"size" numeric(20, 6) NOT NULL,
	"entry_price" numeric(20, 6) NOT NULL,
	"leverage" real,
	"unrealized_pnl" numeric(20, 2),
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "trader_profiles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"address" text NOT NULL,
	"account_size" numeric(20, 2),
	"total_pnl" numeric(20, 2),
	"roi_percent" real,
	"win_rate" real,
	"trade_count" integer DEFAULT 0,
	"max_leverage" real,
	"last_active_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "trader_profiles_address_unique" UNIQUE("address")
);
--> statement-breakpoint
CREATE TABLE "trader_scores" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"trader_profile_id" uuid NOT NULL,
	"risk_adjusted_return" real,
	"absolute_pnl_score" real,
	"roi_score" real,
	"consistency_score" real,
	"drawdown_penalty" real,
	"recency_score" real,
	"composite_score" real NOT NULL,
	"rank" integer,
	"computed_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "trader_scores_trader_profile_id_unique" UNIQUE("trader_profile_id")
);
--> statement-breakpoint
CREATE TABLE "trader_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"trader_profile_id" uuid NOT NULL,
	"account_value" numeric(20, 2),
	"total_pnl" numeric(20, 2),
	"roi_percent" real,
	"drawdown_percent" real,
	"open_positions" jsonb,
	"snapshot_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"wallet_address" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "users_wallet_address_unique" UNIQUE("wallet_address")
);
--> statement-breakpoint
ALTER TABLE "api_wallets" ADD CONSTRAINT "api_wallets_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "copied_positions" ADD CONSTRAINT "copied_positions_copy_relationship_id_copy_relationships_id_fk" FOREIGN KEY ("copy_relationship_id") REFERENCES "public"."copy_relationships"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "copied_positions" ADD CONSTRAINT "copied_positions_source_position_id_source_positions_id_fk" FOREIGN KEY ("source_position_id") REFERENCES "public"."source_positions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "copy_allocations" ADD CONSTRAINT "copy_allocations_copy_relationship_id_copy_relationships_id_fk" FOREIGN KEY ("copy_relationship_id") REFERENCES "public"."copy_relationships"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "copy_relationships" ADD CONSTRAINT "copy_relationships_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "copy_relationships" ADD CONSTRAINT "copy_relationships_trader_profile_id_trader_profiles_id_fk" FOREIGN KEY ("trader_profile_id") REFERENCES "public"."trader_profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "executions" ADD CONSTRAINT "executions_copy_relationship_id_copy_relationships_id_fk" FOREIGN KEY ("copy_relationship_id") REFERENCES "public"."copy_relationships"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "manual_overrides" ADD CONSTRAINT "manual_overrides_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "manual_overrides" ADD CONSTRAINT "manual_overrides_copied_position_id_copied_positions_id_fk" FOREIGN KEY ("copied_position_id") REFERENCES "public"."copied_positions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portfolio_snapshots" ADD CONSTRAINT "portfolio_snapshots_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_positions" ADD CONSTRAINT "source_positions_trader_profile_id_trader_profiles_id_fk" FOREIGN KEY ("trader_profile_id") REFERENCES "public"."trader_profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trader_scores" ADD CONSTRAINT "trader_scores_trader_profile_id_trader_profiles_id_fk" FOREIGN KEY ("trader_profile_id") REFERENCES "public"."trader_profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trader_snapshots" ADD CONSTRAINT "trader_snapshots_trader_profile_id_trader_profiles_id_fk" FOREIGN KEY ("trader_profile_id") REFERENCES "public"."trader_profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_copied_pos_relationship" ON "copied_positions" USING btree ("copy_relationship_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_copy_rel_user_trader" ON "copy_relationships" USING btree ("user_id","trader_profile_id");--> statement-breakpoint
CREATE INDEX "idx_executions_relationship" ON "executions" USING btree ("copy_relationship_id");--> statement-breakpoint
CREATE INDEX "idx_executions_status" ON "executions" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_portfolio_snapshots_user_time" ON "portfolio_snapshots" USING btree ("user_id","snapshot_at");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_source_pos_trader_asset" ON "source_positions" USING btree ("trader_profile_id","asset");--> statement-breakpoint
CREATE INDEX "idx_trader_profiles_pnl" ON "trader_profiles" USING btree ("total_pnl");--> statement-breakpoint
CREATE INDEX "idx_trader_snapshots_trader_time" ON "trader_snapshots" USING btree ("trader_profile_id","snapshot_at");