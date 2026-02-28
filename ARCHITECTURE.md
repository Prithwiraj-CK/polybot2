# Discord Polymarket Bot — Architecture

## High-Level Overview

PolyBot is a Discord bot for interacting with Polymarket prediction markets. It has **two operating modes**:

1. **AI Assistant (READ)** — Users ask natural-language questions about Polymarket and get AI-generated answers backed by live market data. Requires only `GEMINI_API_KEY`.
2. **CLOB Trading (WRITE)** — Users place BUY and SELL orders directly from Discord. Trades execute on-chain via Polymarket's CLOB API using a shared leader wallet with `SignatureType.POLY_GNOSIS_SAFE`. Supports timed up/down markets (BTC/ETH 5m/15m/1h/4h/1d).

**Key design decision:** All users trade through a single leader-controlled wallet. No login, wallet connection, or account linking is required. Per-user spend limits ($5/day) are enforced via Discord user ID tracking.

AI is used for intent parsing (WRITE) and conversational responses (READ).
All execution, validation, and security logic is handled by deterministic, auditable TypeScript code.

---

## Architecture

```
Discord Message
      │
      ▼
  index.ts          ← Discord client, @mention listener, per-user cooldown
      │
      ▼
  DiscordMessageRouter.ts   ← Routes to READ, WRITE, or BALANCE pipeline
      │
      ├── READ ──────────────────────────────────────────────┐
      │   classifyMessageIntent.ts  (regex, no AI)           │
      │        │                                             │
      │        ▼                                             │
      │   PolymarketReadService.ts  (service layer)          │
      │        │                                             │
      │        ▼                                             │
      │   PolymarketApiReadProvider.ts  (Gamma API client)   │
      │        │                                             │
      │        ▼                                             │
      │   aiReadExplainer.ts  (Gemini → Discord response)    │
      │                                                      │
      └──────────────────────────────────────────────────────┘
      │
      ├── WRITE ─────────────────────────────────────────────┐
      │   intentParser.ts        (Gemini → structured JSON)  │
      │   ┌─ OR ──────────────────────────────────────────┐  │
      │   │ tryDeterministicWriteFallback (regex-based)    │  │
      │   │  Detects: buy/sell/exit/close + $amount + side │  │
      │   └───────────────────────────────────────────────┘  │
      │   validateAgentOutput.ts (deterministic rules)       │
      │   buildTradeRequest.ts   (assembles TradeRequest)    │
      │   UserAccountTrader.ts   (execution gateway)         │
      │        │                                             │
      │        ▼                                             │
      │   wire.ts → ClobPolymarketExecutionGateway           │
      │        │    (CLOB API + Gnosis Safe signing)         │
      │        │    Falls back to leader's PROXY_WALLET      │
      │        ▼                                             │
      │   Polymarket CLOB API (on-chain trade)               │
      └──────────────────────────────────────────────────────┘
      │
      ├── BALANCE ───────────────────────────────────────────┐
      │   User provides 0x address → public wallet lookup    │
      │   ├── On-chain USDC balance (Polygon RPC)            │
      │   ├── Position value (Polymarket data API)           │
      │   ├── Open positions with details (data API)         │
      │   └── No auth or login required                      │
      │                                                      │
      │   No address → shows trading wallet + daily spend    │
      └──────────────────────────────────────────────────────┘
```

---

## File Map

### Entry & Wiring

| File | Purpose |
|------|---------|
| `src/index.ts` | Discord client setup, @mention handler, per-user cooldown (5s), message deduplication |
| `src/wire.ts` | Dependency injection — wires all services; contains `ClobPolymarketExecutionGateway`; resolves to leader wallet when no linked account |
| `src/types.ts` | All TypeScript types/interfaces (branded IDs, Market, TradeRequest, TradeAction, etc.) |

### `src/discord/` — Discord Layer

| File | Purpose |
|------|---------|
| `DiscordMessageRouter.ts` | Routes messages to READ, WRITE, or BALANCE pipeline; wallet balance lookup; deterministic trade fallback |
| `classifyMessageIntent.ts` | Deterministic regex classifier — READ unless explicit trade verb + money amount |
| `AccountLinkCommands.ts` | Handles `/status` and `/balance` slash commands (falls back to leader wallet for unlinked users) |

### `src/read/` — READ Pipeline (Market Data + AI Responses)

| File | Purpose |
|------|---------|
| `PolymarketReadService.ts` | Service layer — filters, searches, summarizes markets via provider |
| `PolymarketApiReadProvider.ts` | Gamma API client — fetches markets, events, paginated search with slug matching; timed up/down market resolution |
| `aiReadExplainer.ts` | Gemini-powered conversational response generator with fallback |
| `geminiClient.ts` | Shared Gemini client with multi-key rotation (up to 6 keys) and rate-limit handling |

### `src/agent/` — AI Intent Parsing (WRITE Pipeline)

| File | Purpose |
|------|---------|
| `intentParser.ts` | Gemini → structured JSON intent (place_bet with BUY/SELL action, get_balance, etc.) with deterministic validation |

### `src/backend/` — Trade Validation & Assembly

| File | Purpose |
|------|---------|
| `validateAgentOutput.ts` | Pure deterministic validator — checks market status, amounts, limits |
| `buildTradeRequest.ts` | Assembles validated TradeRequest with idempotency key and trade action (BUY/SELL) |
| `buildValidationContext.ts` | Builds ValidationContext from persistence services; **falls back to leader's `POLYMARKET_PROXY_WALLET`** when no linked account |

### `src/auth/` — Account Linking (Legacy, Not User-Facing)

| File | Purpose |
|------|---------|
| `AccountLinkChallengeService.ts` | Issues/validates time-limited nonce challenges |
| `AccountLinkVerificationService.ts` | Verifies EVM signatures against challenges |
| `AccountLinkPersistenceService.ts` | Persists Discord ↔ Polymarket account mappings |
| `EvmSignatureVerifier.ts` | EIP-191 personal_sign verification via ethers.js |
| `polymarketAuth.ts` | Type definitions for redirect-based auth flow |

> **Note:** The auth module exists in the codebase but is not exposed to end users. The `/connect` and `/disconnect` commands have been removed. All users automatically use the leader's wallet.

### `src/trading/` — Trade Execution

| File | Purpose |
|------|---------|
| `UserAccountTrader.ts` | Executes validated trades (BUY/SELL) via PolymarketExecutionGateway; resolves to leader wallet; maps errors to TradeErrorCode |

### `src/storage/` — Persistence

| File | Purpose |
|------|---------|
| `limits.ts` | Per-user daily spend tracking ($5/day limit) with atomic `trySpend()`, Redis-backed (in-memory fallback) |
| `redisClient.ts` | Redis client singleton (optional, falls back to in-memory if `REDIS_URL` not set) |
| `SupabaseAccountLinkStore.ts` | Supabase-backed persistence for Discord ↔ Polymarket account links |

### `src/server/` — Auth HTTP Server

| File | Purpose |
|------|---------|
| `authServer.ts` | Express server for wallet-link challenge/verify flow; CORS-restricted; `BOT_API_SECRET` auth |

### `public/` — Web UI

| File | Purpose |
|------|---------|
| `connect.html` | Wallet connection page (legacy) |
| `trade-confirm.html` | Trade confirmation page (legacy) |

---

## Shared Wallet Model

All Discord users trade through the **leader's Polymarket wallet**:

1. The leader's wallet credentials (`WALLET_PRIVATE_KEY`, `POLYMARKET_API_KEY`, etc.) are configured in `.env`.
2. When any user sends a trade command, the bot executes the trade using the leader's wallet.
3. **No user login, wallet connection, or account linking is required.**
4. Per-user spend limits ($5/day) are tracked by Discord user ID via Redis or in-memory storage.
5. The bot owner (`OWNER_DISCORD_ID`) is exempt from spend limits for testing.

### Wallet Balance Lookup

Any user can check any wallet's public data by including a `0x` address:

1. **USDC balance** — read on-chain from Polygon via public RPC
2. **Position value** — fetched from `data-api.polymarket.com/value`
3. **Open positions** — fetched from `data-api.polymarket.com/positions`

All APIs are public and require no authentication.

---

## CLOB Trade Execution

The bot executes real on-chain trades via Polymarket's CLOB API:

1. **Wallet**: EOA wallet derived from `WALLET_PRIVATE_KEY` with ethers v6 (`_signTypedData` shim for v5 compat)
2. **Signing**: `SignatureType.POLY_GNOSIS_SAFE` (type 2) — the proxy wallet is a Gnosis Safe-style contract
3. **Proxy**: `POLYMARKET_PROXY_WALLET` set as `funderAddress` — this is where USDC balance lives
4. **Orders**: Fill-or-Kill (FOK) market orders via `createAndPostMarketOrder()`
5. **BUY**: `amount` = dollars to spend
6. **SELL**: `amount` = shares to sell; action detected via `sell|exit|close` keywords
7. **Minimum**: $5 per order (Polymarket enforced)

### Timed Market Resolution

For timed up/down markets (e.g., BTC 15-minute), the bot:
1. Calculates the current time window: `Math.floor(now / intervalSec) * intervalSec`
2. Builds the slug: `btc-updown-15m-{timestamp}`
3. Fetches the market via Gamma events API
4. Falls back to text search if slug resolution fails

Supported assets: BTC, ETH, SOL, XRP
Supported timeframes: 5m, 15m, 1h, 4h, 1d

---

## What Gemini Does

Gemini (Google's LLM) is used in **three places**, all read-only and non-authoritative:

1. **Keyword Extraction** (`PolymarketApiReadProvider.ts`)
   - Extracts search keywords from conversational queries
   - Falls back to simple prefix stripping if Gemini is unavailable

2. **Conversational Response** (`aiReadExplainer.ts`)
   - Generates natural-language Discord responses from market data
   - Falls back to a structured template if Gemini is unavailable

3. **Intent Parsing** (`intentParser.ts`)
   - Parses trade commands into structured JSON (including BUY/SELL action)
   - Output is **never trusted** — always validated by deterministic code
   - The deterministic fallback regex handles most common trade patterns directly

**Key principle:** Gemini is untrusted. All AI output passes through deterministic validation before any action is taken. The bot works without Gemini — it just uses template responses and regex-based parsing instead.

---

## Key Rotation

The bot supports up to 6 Gemini API keys (`GEMINI_API_KEY`, `GEMINI_API_KEY_2` through `_6`). When a key hits its rate limit (429), it's automatically disabled for 60 seconds and the next key is tried.

---

## Search Strategy

When a user asks about a market, the search pipeline:

1. **Prefix strip / AI keyword extraction** — cleans conversational noise
2. **Event slug search** — tries the Gamma `/events?slug=...` endpoint with sliding-window slug candidates
3. **If events found** → return them (sorted: active first, then closed)
4. **If no events** → fallback to `/markets?slug=...&tag=...&text_query=...`
5. **Dedup + merge** results across all search methods

---

## Security

- **No hardcoded secrets** — all credentials loaded from `process.env`
- **Wallet addresses masked in logs** — only `0xf7eB…60aB` format
- **Shared wallet model** — users never provide private keys; all trades go through leader's wallet
- **CORS restricted** — auth server locked to configured origins (`CORS_ORIGINS`)
- **Per-user cooldown** — 5-second delay between Discord commands
- **Daily spend limit** — $5/day per user with atomic `trySpend()`
- **Sanitized logging** — order results log only `status`/`success`/`orderID`; errors truncated
- **Sell orders skip spend limits** — selling returns funds, not spends them
- **Public wallet lookup** — balance/position queries use only public APIs (no auth)

---

## Tech Stack

- **TypeScript** (ES2022, strict mode, CommonJS)
- **discord.js** v14 — Discord client
- **@google/genai** — Gemini SDK for AI features
- **@polymarket/clob-client** — CLOB API for trade execution
- **@polymarket/order-utils** — Order signing (SignatureType, OrderType)
- **ethers** v6 — EVM signature verification + wallet management
- **express** v5 — Auth server
- **@supabase/supabase-js** — Account link persistence
- **ioredis** — Redis client for spend tracking (optional)
- **dotenv** — env config
- **Polymarket Gamma API** — public, no auth, market data
- **Polymarket Data API** — public, no auth, wallet balances + positions
