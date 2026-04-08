# HLOne Score — Hyperliquid Reputation & Gated Access System

## Overview

A promotional system where users connect their wallet, get scored on their Hyperliquid trading history, receive a unique identity (name + image), and earn access to HLOne based on their score. High scorers get instant access + invite codes. Lower scorers join a ranked waitlist.

---

## 1. User Flow

```
Connect Wallet → Score Computed (2-5s) → Reveal Animation → Identity Card
                                                              ├── Score 70+ → Instant Access + Invite Codes
                                                              ├── Score 40-69 → Waitlist (ranked by score)
                                                              └── Score <40 → Waitlist (back of line)
```

1. User lands on `/score` (or standalone domain)
2. Clicks "Connect Wallet" (existing wallet infra)
3. Backend fetches all HL data for that address (2-5 seconds)
4. Dramatic reveal animation: score counts up, identity card materializes
5. Shows full breakdown with shareable image
6. CTA: "You're in" or "You're #X in queue"

---

## 2. Scoring Engine (0-100)

### Data Sources (all from Hyperliquid public API, no keys needed)

| Signal | API Endpoint | Weight |
|--------|-------------|--------|
| **Account Age** | `userFillsByTime` (earliest trade) | 10% |
| **Total Volume** | `portfolio` (allTime vlm) | 15% |
| **All-Time PNL** | `portfolio` (allTime pnl) | 10% |
| **Account Value** | `clearinghouseState` | 10% |
| **Unique Pairs** | `userFillsByTime` (distinct coins) | 10% |
| **Trading Consistency** | `userFillsByTime` (days with trades / total days) | 10% |
| **Order Sophistication** | `userFillsByTime` (limit vs market ratio) | 10% |
| **Risk Management** | `frontendOpenOrders` (TP/SL usage) | 5% |
| **Leverage Discipline** | `clearinghouseState` (avg leverage) | 5% |
| **Long/Short Balance** | `userFillsByTime` (buy vs sell ratio) | 5% |
| **Max Drawdown** | `portfolio` (equity curve) | 5% |
| **Funding Earned** | `userFunding` (net funding) | 5% |

### Score Tiers

| Tier | Score | Name Style | Access |
|------|-------|-----------|--------|
| **Whale** | 90-100 | "Whale CrimsonFalcon" | Instant + 5 invites |
| **Sharp** | 70-89 | "Sharp IronEagle" | Instant + 3 invites |
| **Trader** | 50-69 | "Trader NeonWolf" | Waitlist (priority) |
| **Rookie** | 30-49 | "Rookie GreenLizard" | Waitlist (standard) |
| **Tourist** | 0-29 | "Tourist SilverFox" | Waitlist (back) |

### Anti-Gaming Measures

- **Account age floor**: accounts < 7 days old get 0 for age (prevents fresh farming)
- **Volume velocity cap**: volume earned in last 24h counts at 10% weight (prevents wash trading)
- **Consistency > spikes**: daily trading frequency weighted higher than single-day volume bursts
- **Pair diversity bonus**: trading 10+ unique pairs signals real usage vs bot activity
- **Leverage penalty**: avg leverage > 50x reduces score (degen bots)

### Scoring Formula (pseudocode)

```typescript
function computeScore(data: WalletData): number {
  const age = Math.min(daysSinceFirstTrade / 365, 1) * 100;           // 0-100, caps at 1yr
  const volume = Math.min(Math.log10(totalVolume + 1) / 7, 1) * 100;  // log scale, caps at $10M
  const pnl = Math.min((allTimePnl + 50000) / 100000, 1) * 100;       // -$50K=0, +$50K=100
  const accountVal = Math.min(Math.log10(accountValue + 1) / 5, 1) * 100; // log, caps at $100K
  const pairs = Math.min(uniquePairs / 20, 1) * 100;                  // caps at 20 pairs
  const consistency = (daysWithTrades / totalDays) * 100;              // 0-100%
  const sophistication = limitOrderRatio * 100;                        // 0-100%
  const riskMgmt = hasTpSl ? 100 : 0;                                // binary
  const leverageScore = avgLeverage <= 10 ? 100 : Math.max(0, 100 - (avgLeverage - 10) * 5);
  const balance = (1 - Math.abs(longRatio - 0.5) * 2) * 100;        // 50/50 = 100
  const ddScore = Math.max(0, 100 - maxDrawdownPct);                 // 0% dd = 100
  const fundingScore = Math.min(netFunding / 1000, 1) * 100;         // caps at $1K earned

  return Math.round(
    age * 0.10 + volume * 0.15 + pnl * 0.10 + accountVal * 0.10 +
    pairs * 0.10 + consistency * 0.10 + sophistication * 0.10 +
    riskMgmt * 0.05 + leverageScore * 0.05 + balance * 0.05 +
    ddScore * 0.05 + fundingScore * 0.05
  );
}
```

---

## 3. Identity System

### Unique Name

Extend existing `name-generator.ts`:
- Tier prefix: "Whale", "Sharp", "Trader", "Rookie", "Tourist"
- Adjective + Animal + Number: "Sharp IronEagle42"
- Deterministic from address hash (same wallet = same name always)

### Identity Card (SVG/Canvas)

Programmatically generated image per wallet:

```
┌────────────────────────────────────┐
│  HLOne Pass                   #427 │
│                                    │
│  ┌──────────┐   Sharp IronEagle42  │
│  │          │   Score: 78 / 100    │
│  │  AVATAR  │   ████████░░ SHARP   │
│  │          │                      │
│  └──────────┘   0x1a2b...3c4d      │
│                                    │
│  Vol: $2.4M    PNL: +$12K          │
│  Pairs: 18     Age: 247 days       │
│  Style: Balanced Swing Trader      │
│                                    │
│  ─────────────────────────────     │
│  Tier: SHARP  │  Invites: 3        │
└────────────────────────────────────┘
```

**Avatar generation:**
- Color palette derived from score tier (green/cyan for high, gray for low)
- Geometric pattern from address hash (like GitHub identicons but cooler)
- Badge overlays for special achievements

**Trading Style Labels** (derived from data):
- "Diamond Hands" — low trade frequency, long hold times
- "Scalper" — high frequency, small positions
- "Whale Hunter" — large positions, few trades
- "Diversified" — 15+ pairs traded
- "Degen" — avg leverage > 20x
- "Balanced" — near 50/50 long/short
- "Funding Farmer" — net positive funding

### Image Generation Options

| Option | Effort | Quality | Cost |
|--------|--------|---------|------|
| **SVG composition** (recommended) | 1 day | Good, fast | Free |
| Canvas/sharp (Node) | 1.5 days | Better | Free |
| AI image gen (DALL-E) | 0.5 day | Unique | ~$0.02/image |

**Recommendation**: SVG composition for v1. Fast, deterministic, zero cost. Can upgrade to AI-gen later for premium tiers.

---

## 4. Access Gating & Waitlist

### Database Schema

```sql
-- Score records (one per wallet)
CREATE TABLE hl_scores (
  id SERIAL PRIMARY KEY,
  wallet_address TEXT UNIQUE NOT NULL,
  score INTEGER NOT NULL,
  tier TEXT NOT NULL,              -- whale/sharp/trader/rookie/tourist
  breakdown JSONB NOT NULL,        -- { age: 85, volume: 72, ... }
  trading_style TEXT,              -- "Balanced Swing Trader"
  identity_name TEXT NOT NULL,     -- "Sharp IronEagle42"
  image_url TEXT,                  -- SVG/PNG URL
  has_access BOOLEAN DEFAULT FALSE,
  waitlist_position INTEGER,
  invite_codes TEXT[],             -- ["ABC123", "DEF456", ...]
  invites_remaining INTEGER DEFAULT 0,
  invited_by TEXT,                 -- wallet that invited this user
  scored_at TIMESTAMP DEFAULT NOW(),
  last_refreshed TIMESTAMP
);

-- Invite code tracking
CREATE TABLE invite_codes (
  code TEXT PRIMARY KEY,
  created_by TEXT NOT NULL,        -- wallet address
  used_by TEXT,                    -- wallet that used it
  used_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW()
);
```

### Access Logic

```typescript
function determineAccess(score: number, inviteCode?: string): AccessResult {
  // Invite code bypasses queue
  if (inviteCode && isValidInviteCode(inviteCode)) {
    return { hasAccess: true, invites: 1 };
  }

  // Score-based access
  if (score >= 70) return { hasAccess: true, invites: score >= 90 ? 5 : 3 };

  // Waitlist
  const position = getWaitlistPosition(score);
  return { hasAccess: false, waitlistPosition: position, estimatedWait: "Coming soon" };
}
```

### Waitlist Mechanics

- Sorted by score descending (higher score = earlier access)
- Batch onboarding: open 100 slots per day/week
- Score refreshes: users can re-score every 24h (encourages continued trading)
- Invite codes bypass the queue entirely (viral growth)

---

## 5. NFT (Phase 2, Optional)

### Approach

- **Chain**: Arbitrum (where HL settles) or HL EVM
- **Standard**: ERC-721 (soulbound — non-transferable)
- **Metadata**: Dynamic — points to HLOne API, score updates over time
- **Minting**: Free (gas only), triggered when user claims their score
- **Contract**: Simple, ~100 lines. Soulbound = disable `transferFrom`

### Why Soulbound?

- Prevents score farming → selling high-score NFTs
- The NFT IS the reputation — tied to the wallet that earned it
- Can still be displayed in wallets/OpenSea as a profile badge

### Defer Until:

- Core scoring + access system is live and working
- Have enough users to justify gas costs
- HL EVM is more mature for deployment

---

## 6. Implementation Plan

### Sprint 1: Backend Scoring (1-2 days)

```
apps/api/src/services/hl-score.ts     — Scoring engine
apps/api/src/routes/score.ts          — GET /api/score/:address
packages/db/src/schema/scores.ts      — DB schema
```

1. Create `hl-score.ts` — fetches all HL data, computes weighted score
2. Create DB migration for `hl_scores` and `invite_codes` tables
3. Create `/api/score/:address` endpoint — returns score, breakdown, identity
4. Add 1-hour cache per wallet (avoid hammering HL API)
5. Test with known wallets (yours, whale addresses)

### Sprint 2: Identity Generation (1 day)

```
apps/api/src/services/identity-card.ts — SVG card generator
apps/api/src/routes/score.ts           — GET /api/score/:address/card.svg
```

1. Extend name generator with tier prefixes
2. Build SVG template with dynamic data injection
3. Generate identicon-style avatar from address hash
4. Add trading style labels based on score breakdown
5. Serve as both SVG and PNG (via sharp conversion)

### Sprint 3: Frontend Score Page (1.5 days)

```
apps/web/src/app/score/page.tsx        — Main score page
apps/web/src/components/score/         — Score UI components
```

1. Landing page with "Connect Wallet" CTA
2. Loading animation (scanning blockchain...)
3. Score reveal: number counts up, card materializes
4. Breakdown view: radar chart of all signals
5. Share button (downloads card image, copies share link)
6. Access CTA: "Enter HLOne" or "Join Waitlist (#X)"

### Sprint 4: Access Gating & Invites (1 day)

```
apps/api/src/routes/score.ts           — POST /api/score/claim-invite
apps/web/src/app/score/page.tsx        — Invite code UI
```

1. Generate invite codes for qualifying users
2. Invite code input on score page
3. Gate HLOne access behind score check (middleware or client-side)
4. Admin dashboard: batch approve waitlist, adjust thresholds
5. Share invite codes (Twitter-formatted)

### Sprint 5: Polish & Launch (1 day)

1. Social share meta tags (OG image = identity card)
2. Twitter card optimization
3. Rate limiting (prevent score spam)
4. Analytics: track scores, conversions, invite chains
5. Launch checklist: test on mainnet, verify with real wallets

---

## 7. Viral Mechanics

- **Shareable card**: designed for Twitter screenshots
- **Invite chain tracking**: "You were invited by Sharp IronEagle42"
- **Leaderboard**: top scores displayed on the score page
- **Re-scoring**: score updates encourage continued HL trading
- **FOMO**: "Only 342 spots left" countdown
- **Referral bonus**: +5 points if you invite someone who scores 50+

---

## 8. Technical Notes

- All scoring data from HL's public API (POST to api.hyperliquid.xyz/info)
- No API keys needed for basic scoring
- LunarCrush social data could add a "social score" bonus (optional)
- Score computation takes 2-5 seconds (7 parallel API calls)
- Cache aggressively: 1hr for scores, 24hr for identity cards
- SVG generation is instant, PNG conversion ~100ms via sharp

---

## 9. Open Questions

- [ ] Exact score threshold for access (70? 60? 80?)
- [ ] How many invites per tier?
- [ ] Standalone domain or `/score` route?
- [ ] Do we show the waitlist publicly (leaderboard)?
- [ ] Score refresh cooldown (24h? 7d?)
- [ ] NFT on Arbitrum or HL EVM?
- [ ] Paid skip-the-line option?
