CREATE TABLE "top_trader_fills" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"coin" text NOT NULL,
	"side" text NOT NULL,
	"price" numeric(20, 6) NOT NULL,
	"size_usd" numeric(20, 2) NOT NULL,
	"trader" text NOT NULL,
	"address" text NOT NULL,
	"account_value" numeric(20, 2),
	"fill_time" timestamp NOT NULL
);
--> statement-breakpoint
CREATE INDEX "idx_top_trader_fills_coin_time" ON "top_trader_fills" USING btree ("coin","fill_time");--> statement-breakpoint
CREATE INDEX "idx_top_trader_fills_time" ON "top_trader_fills" USING btree ("fill_time");