# HlOne

**HyperLiquid trading terminal** — perps, options (via Derive), copy trading, smart-money flow, whale tracking. Built for traders who want more than the default HL UI.

Live at **[hlone.xyz](https://hlone.xyz)**.

---

## What's inside

### Trade
- **Perps** on HyperLiquid L1 (200+ pairs). Signed locally via agent wallets — same pattern HL's own frontend uses.
- **Options** on [Derive](https://derive.xyz) — HYPE, BTC, ETH, SOL. Full chain browser with greeks, IV rank, max pain.
- **Copy trading** — replicate any top HL trader with configurable allocation, leverage cap, min order size.

### Data (live, every few seconds)
- **Sharp Flow** — aggregated positions of top-performing HL traders, with divergence detection vs retail
- **Whale Feed** — real-time large-position entries/exits from the top-200 accounts
- **Signals** — directional bias built from sharp money + whale activity + funding + OI
- **Top Trader Fills** — see what the best traders are actually clicking, overlaid on the chart
- **Large Trade Tape** — $50K+ fills across the top 20 coins
- **Funding / OI / Lending rates** — Felix + HyperLend APRs, funding leaderboards
- **Macro bar** — gold, SPX, NDX, BTC, ETH side-by-side with HL majors
- **News + Social** — CryptoPanic headlines, LunarCrush galaxy scores per coin

### Studio (coming soon)
Build your own branded HlOne. Pick widgets, drop your logo, set a color, deploy a live fork with a $50 one-time USDC payment. Full self-serve at launch. Today: config + preview is open, deploy is held.

---

## How it works

- **Frontend**: Next.js 16 app on Vercel. Signs HL orders with EIP-712 via agent wallets generated locally on first trade.
- **API**: Fastify on Railway. Aggregates HL's public info API with smart-money classification from the leaderboard, whale tracking, scoring, and signal derivation.
- **Database**: Postgres (Drizzle ORM) for time-series data (OI snapshots, sharp-flow snapshots, top-trader fills, trade logs).
- **Cache**: Redis (Upstash) for cross-instance shared state.
- **Payments** (for Studio deploy): USDC on Arbitrum, verified on-chain via viem.
- **Options**: Derive v2 session keys. Imported once from derive.xyz, stored encrypted (AES-GCM) in browser localStorage.

### Non-custody

HlOne never holds keys and never routes your funds. Every order is signed locally and submitted directly to the venue (HL or Derive). The backend only serves aggregated market data and tracks your builder-code fee split. See `/security` on the live site for the full trust model.

---

## Architecture

```
apps/
├── api/          # Fastify — market data aggregation + routes
├── web/          # Next.js 16 — trading UI + Studio
└── worker/       # Background jobs (whale tracking, OI snapshotting)

packages/
└── db/           # Drizzle schema + migrations, shared DB client
```

---

## Development

```bash
# 1. Install
npm install

# 2. Copy env template
cp .env.example .env
# then fill in DATABASE_URL, NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID, etc.

# 3. DB migrations
npm run --workspace=@hl-copy/db generate   # if you changed schema
npm run --workspace=@hl-copy/db migrate    # apply

# 4. Run
npm run dev --workspace=apps/api     # API on :3001
npm run dev --workspace=apps/web     # web on :3000
```

### Required env vars
See `.env.example` for the full list. Minimum for local dev:
- `DATABASE_URL` — Postgres (Neon free tier works)
- `NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID` — from [cloud.walletconnect.com](https://cloud.walletconnect.com)

---

## Security

Covered in detail at [hlone.xyz/security](https://hlone.xyz/security). The short version:

- **Non-custodial** — we never hold user keys
- **Agent wallets** encrypted with AES-GCM-256 (100k PBKDF2 iterations) when the user sets a password; plaintext localStorage otherwise (matches HL's own frontend behavior)
- **Derive session keys** same encryption, opt-in
- **EIP-712** signing for every HL order + copy-trade action
- **Strict CSP** with per-request nonces (no `unsafe-inline`)
- **Body-hash-bound signatures** on all mutating endpoints so stolen sigs can't be replayed with different parameters
- **Rate limits** on telemetry endpoints

Full audit performed Apr 2026 — see commit `46a689d` for the comprehensive security hardening pass (14 critical + high-severity findings closed).

---

## Contributing

Issues and PRs welcome. If you find a security issue, please **don't** open a public issue — email [security@hlone.xyz](mailto:security@hlone.xyz) or DM [@hlonexyz](https://x.com/hlonexyz) on X.

---

## License

MIT — see [LICENSE](./LICENSE).
