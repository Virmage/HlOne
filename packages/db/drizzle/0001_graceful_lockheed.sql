CREATE TABLE "oi_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"coin" text NOT NULL,
	"open_interest" numeric(20, 2) NOT NULL,
	"price" numeric(20, 6) NOT NULL,
	"snapshot_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "whale_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"whale_address" text NOT NULL,
	"whale_name" text NOT NULL,
	"account_value" numeric(20, 2),
	"coin" text NOT NULL,
	"event_type" text NOT NULL,
	"old_size" numeric(20, 6),
	"new_size" numeric(20, 6),
	"position_value_usd" numeric(20, 2),
	"price" numeric(20, 6),
	"detected_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "idx_oi_snapshots_coin_time" ON "oi_snapshots" USING btree ("coin","snapshot_at");--> statement-breakpoint
CREATE INDEX "idx_whale_events_coin_time" ON "whale_events" USING btree ("coin","detected_at");--> statement-breakpoint
CREATE INDEX "idx_whale_events_time" ON "whale_events" USING btree ("detected_at");