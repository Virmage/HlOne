CREATE TABLE "sharp_flow_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"coin" text NOT NULL,
	"sharp_long_count" integer DEFAULT 0 NOT NULL,
	"sharp_short_count" integer DEFAULT 0 NOT NULL,
	"sharp_net_size" numeric(20, 2),
	"sharp_direction" text NOT NULL,
	"sharp_strength" integer NOT NULL,
	"square_long_count" integer DEFAULT 0 NOT NULL,
	"square_short_count" integer DEFAULT 0 NOT NULL,
	"square_net_size" numeric(20, 2),
	"square_direction" text NOT NULL,
	"square_strength" integer NOT NULL,
	"consensus" text NOT NULL,
	"divergence" boolean DEFAULT false NOT NULL,
	"divergence_score" integer DEFAULT 0 NOT NULL,
	"hlone_score" integer,
	"signal" text,
	"price" numeric(20, 8) NOT NULL,
	"change_24h" real,
	"volume_24h" numeric(20, 2),
	"funding_rate" real,
	"snapshot_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "idx_sharp_flow_snapshots_coin_time" ON "sharp_flow_snapshots" USING btree ("coin","snapshot_at");--> statement-breakpoint
CREATE INDEX "idx_sharp_flow_snapshots_time" ON "sharp_flow_snapshots" USING btree ("snapshot_at");--> statement-breakpoint
CREATE INDEX "idx_sharp_flow_snapshots_divergence" ON "sharp_flow_snapshots" USING btree ("divergence","snapshot_at");