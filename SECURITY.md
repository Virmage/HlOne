# HLOne Security Model

HLOne is a self-custodial trading terminal for HyperLiquid. This document explains what we do (and don't do) with your keys, funds, and data.

---

## TL;DR

- **We never touch your funds.** You keep custody. HLOne only helps you sign transactions and send them to HyperLiquid.
- **Your keys stay in your browser.** Nothing is sent to our servers.
- **Optional password encryption** for stored keys — protects against XSS and malicious browser extensions.
- **Open source** — verify everything at [github.com/Virmage/hl-copy-trading](https://github.com/Virmage/hl-copy-trading).
- **Vibe coded, unaudited.** Use at your own risk. See the on-site disclaimer.

---

## What keys exist, where they live, and what they can do

HLOne uses three kinds of private keys during normal operation:

### 1. Your main wallet (Rabby, MetaMask, WalletConnect, etc.)
- **Location:** your wallet extension/app. HLOne never sees the private key.
- **Used for:** one-time signatures (approving HL agent, approving Derive builder, approving session key).
- **Risk:** standard wallet risk — guard your seed phrase as usual.

### 2. HL Agent Wallet
- **Generated:** locally in your browser on first trade.
- **Stored:** in `localStorage` under `hlone-agent-<your-eoa>`.
- **Used for:** signing individual HL orders without a wallet popup every trade.
- **Capabilities:** trade on your HL account. **Cannot withdraw, transfer, or modify account settings** — HL agents have constrained permissions.
- **Revocation:** go to HyperLiquid → API → revoke agent.

### 3. Derive Session Key
- **Generated:** on derive.xyz; you copy the private key and paste it into HLOne.
- **Stored:** in `localStorage` under `hlone-derive-sk-<your-eoa>`.
- **Used for:** signing Derive options orders without wallet popups.
- **Capabilities:** depends on the scope you chose on derive.xyz:
  - **Admin scope** (required for trading): can place orders, manage positions, and **withdraw**.
  - **Read-only scope:** can view data but not trade.
- **Revocation:** go to derive.xyz → Settings → Developer → Session Keys → revoke.

**Risk note:** if admin-scope Derive session keys are stolen, an attacker can withdraw your Derive account balance. Keep only what you're actively trading in your Derive wallet. Enable password protection (below).

---

## Password-encrypted key storage

HLOne offers optional password protection for stored keys at `/security`:

- **Algorithm:** AES-GCM-256 with PBKDF2 key derivation (100,000 iterations, SHA-256).
- **Implementation:** native Web Crypto API (no dependencies).
- **Stored format:** `{ v: 1, alg: "aes-gcm", salt, iv, ct }` as JSON in localStorage.
- **Password:** never stored. Held in JavaScript memory for the tab session only; gone on tab close or refresh.

**Tradeoffs:**
- Password enabled: XSS/extensions that read localStorage get encrypted ciphertext, useless without the password.
- Password disabled: XSS/extensions can read plaintext keys directly.

**Limitation:** if an attacker has already compromised your machine (malware) or can keylog your password input, encryption doesn't help.

### Forgotten password

There is **no recovery mechanism**. If you forget the password:
1. Clear all stored keys at `/security`.
2. Re-import your Derive session key from derive.xyz.
3. Re-approve your HL agent on HyperLiquid.

This is a deliberate choice — adding recovery creates attack surface.

---

## What we store, where, and why

| Data | Where | Sent to HLOne servers? |
|---|---|---|
| Wallet addresses (public) | localStorage, sent to HL/Derive APIs | Partially (for public data queries like whale tracking — your wallet, not ours) |
| HL agent private keys | localStorage (optionally encrypted) | **No** |
| Derive session keys (private) | localStorage (optionally encrypted) | **No** |
| Seed phrases, EOA private keys | never touched by HLOne | **No** |
| Trading activity | localStorage (for your UI) | HL sees trades you submit through them |
| Custom Studio configs | localStorage + optionally a Vercel env var on your own deploy | No, unless you export to a Studio deploy |

---

## Infrastructure

- **Frontend:** hosted on Vercel (`hlone.xyz`). Static JS bundle + API proxy to Railway.
- **Backend (API):** hosted on Railway. Provides whale tracking, sharp flow analytics, derived data. Does NOT handle user funds or keys.
- **HyperLiquid:** all orders go directly from your browser to HL's official API. Authenticated by your agent signature.
- **Derive:** all orders go from your browser to Derive's WebSocket API. Authenticated by your session key signature.

### Third-party services
- **Vercel / Railway:** hosting. No access to your keys (keys never leave your browser).
- **WalletConnect:** powers mobile wallet connection flows. Open source, widely used.
- **Infura / Alchemy / public RPCs:** for chain reads (account balances, etc.). Your wallet address is visible to these providers.
- **No analytics, trackers, or ad networks.**

---

## Common attack scenarios

### Phishing
An attacker tricks you into visiting a fake "hlone.xyz" clone that steals your keys.
**Mitigation:** bookmark the real URL. Verify the domain before entering anything.

### XSS on hlone.xyz
A vulnerability lets an attacker inject JavaScript into the real site, reads localStorage.
**Mitigation:**
- CSP headers set to prevent most XSS vectors.
- No third-party scripts beyond WalletConnect + Next.js runtime.
- Password encryption makes stolen localStorage values useless.
- Still possible if combined with keylogging — defense in depth isn't perfect.

### Malicious browser extension
An extension with "read all website data" permissions reads localStorage on hlone.xyz.
**Mitigation:**
- Install only extensions you trust.
- Password encryption protects the stored keys at rest.
- Doesn't protect against extensions that can hook JS execution directly (nothing can).

### Stolen device / compromised OS
Someone has physical or remote access to your computer.
**Mitigation:** full-disk encryption, OS login password, don't leave sessions unlocked. HLOne can't defend against OS-level compromise.

### Broken session key / agent
An attacker exploits a vulnerability in HL or Derive protocol.
**Mitigation:** out of our control. HL and Derive run audited smart contracts. Revoke keys immediately if you suspect anything.

---

## Security practices we follow

- `X-Frame-Options: SAMEORIGIN` (prevents clickjacking from external sites)
- `X-Content-Type-Options: nosniff`
- `Content-Security-Policy` restricting script origins and connect targets
- `Referrer-Policy: strict-origin-when-cross-origin`
- Secrets (API keys, tokens) never in source — stored as Vercel "Sensitive" env vars
- Regular dependency updates (Dependabot alerts on)
- Open source — all code is inspectable

## Security practices we haven't yet done (launch-time honesty)

- **No formal audit.** HLOne is "vibe coded" by one person with AI assistance. No paid security review yet.
- **No bug bounty program.** Looking to add post-launch.
- **Limited adversarial testing.** If you find issues, please report privately (see below).

---

## Reporting a security issue

Please **do not** open a public GitHub issue for security bugs.

Instead, email: (add your email here) or DM on X: (add your handle here)

Include:
- Clear reproduction steps
- Potential impact
- Your preferred contact method for follow-up

We'll respond within 48 hours.

---

## What to do if you suspect compromise

1. **Immediately revoke keys on-chain:**
   - Derive: derive.xyz → Settings → Developer → Session Keys → revoke
   - HyperLiquid: HL app → API → revoke agent
2. **Clear local keys:** HLOne → Security → Clear all stored keys
3. **Move remaining funds** from the compromised wallet to a fresh wallet (if main wallet compromised)
4. **Check wallet activity** on Arbiscan / HL explorer for unauthorized transactions

On-chain revocation is the real safety net. Clearing browser storage alone doesn't invalidate keys that an attacker may have already copied.

---

## Changelog

- **v1 (launch):** initial security model, optional AES-GCM password encryption, `/security` settings page.

Updates to this document are tracked in git history at [SECURITY.md on GitHub](https://github.com/Virmage/hl-copy-trading/blob/main/SECURITY.md).
