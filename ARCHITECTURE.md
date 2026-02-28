# Discord Polymarket Bot — Architecture

## High-Level Overview

PolyBot is a Discord bot for interacting with Polymarket prediction markets. It has **two operating modes**:

1. **AI Assistant (READ)** — Users ask natural-language questions about Polymarket and get AI-generated answers backed by live market data. Requires only `GEMINI_API_KEY`.
2. **CLOB Trading (WRITE)** — Users place BUY and SELL orders directly from Discord. Trades execute on-chain via Polymarket's CLOB API using a Gnosis Safe proxy wallet with `SignatureType.POLY_GNOSIS_SAFE`. Supports timed up/down markets (BTC/ETH 5m/15m).

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
  DiscordMessageRouter.ts   ← Routes to READ or WRITE pipeline
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
      │        ▼                                             │
      │   Polymarket CLOB API (on-chain trade)               │
      └──────────────────────────────────────────────────────┘
```

---

## File Map

### Entry & Wiring

| File | Purpose |
|------|---------|
| `src/index.ts` | Discord client setup, @mention handler, per-user cooldown (5s), message deduplication |
| `src/wire.ts` | Dependency injection — wires all services; contains `ClobPolymarketExecutionGateway` (CLOB trade execution) |
| `src/types.ts` | All TypeScript types/interfaces (branded IDs, Market, TradeRequest, TradeAction, etc.) |

### `src/discord/` — Discord Layer

| File | Purpose |
|------|---------|
| `DiscordMessageRouter.ts` | Routes messages to READ or WRITE pipeline; deterministic fallback for trade commands; BUY/SELL support |
| `classifyMessageIntent.ts` | Deterministic regex classifier — READ unless explicit trade verb + money amount |
| `AccountLinkCommands.ts` | Handles `/connect`, `/status`, `/balance`, `/disconnect` slash commands |

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
| `validateAgentOutput.ts` | Pure deterministic validator — checks account link, market status, amounts, limits |
| `buildTradeRequest.ts` | Assembles validated TradeRequest with idempotency key and trade action (BUY/SELL) |
| `buildValidationContext.ts` | Builds ValidationContext from persistence services |

### `src/auth/` — Account Linking (EVM Signature Verification)

| File | Purpose |
|------|---------|
| `AccountLinkChallengeService.ts` | Issues/validates time-limited nonce challenges |
| `AccountLinkVerificationService.ts` | Verifies EVM signatures against challenges |
| `AccountLinkPersistenceService.ts` | Persists Discord ↔ Polymarket account mappings |
| `EvmSignatureVerifier.ts` | EIP-191 personal_sign verification via ethers.js |
| `polymarketAuth.ts` | Type definitions for redirect-based auth flow |

### `src/trading/` — Trade Execution

| File | Purpose |
|------|---------|
| `UserAccountTrader.ts` | Executes validated trades (BUY/SELL) via PolymarketExecutionGateway; maps errors to TradeErrorCode |

### `src/storage/` — Persistence

| File | Purpose |
|------|---------|
| `limits.ts` | Per-user daily spend tracking ($5/day limit) with atomic `trySpend()`, stale-entry eviction |
| `SupabaseAccountLinkStore.ts` | Supabase-backed persistence for Discord ↔ Polymarket account links |

### `src/server/` — Auth HTTP Server

| File | Purpose |
|------|---------|
| `authServer.ts` | Express server for wallet-link challenge/verify flow; CORS-restricted; `BOT_API_SECRET` auth; session size caps |

### `public/` — Web UI

| File | Purpose |
|------|---------|
| `connect.html` | Wallet connection page for EIP-191 signature flow |
| `trade-confirm.html` | Trade confirmation page (legacy, not used in CLOB flow) |

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

---

## What Gemini Does

Gemini (Google's LLM) is used in **three places**, all read-only and non-authoritative:

1. **Keyword Extraction** (`PolymarketApiReadProvider.ts`)
   - Extracts search keywords from conversational queries
   - Example: `"tell me about US strikes Iran by...?"` → `"US strikes Iran by"`
   - Falls back to simple prefix stripping if Gemini is unavailable

2. **Conversational Response** (`aiReadExplainer.ts`)
   - Generates natural-language Discord responses from market data
   - Receives factual market context (prices, volume, status) as system prompt
   - Falls back to a structured template if Gemini is unavailable

3. **Intent Parsing** (`intentParser.ts`)
   - Parses trade commands into structured JSON (including BUY/SELL action)
   - Output is **never trusted** — always validated by deterministic code
   - Used only for WRITE-classified messages (explicit trade verb + money amount)
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
- **CORS restricted** — auth server locked to configured origins (`CORS_ORIGINS`)
- **Auth endpoints protected** — `BOT_API_SECRET` header check on session creation/consumption
- **Session size caps** — max 10,000 active sessions to prevent memory DoS
- **Input format validation** — both wallet and Polymarket addresses validated with `0x[a-fA-F0-9]{40}`
- **Per-user cooldown** — 5-second delay between Discord commands
- **Daily spend limit** — $5/day per user with atomic `trySpend()`
- **Sanitized logging** — order results log only `status`/`success`/`orderID`; errors truncated
- **Sell orders skip spend limits** — selling returns funds, not spends them

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
- **dotenv** — env config
- **Polymarket Gamma API** — public, no auth, market data
