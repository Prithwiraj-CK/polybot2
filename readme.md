# PolyBot — Polymarket Discord Bot

A Discord bot that queries [Polymarket](https://polymarket.com) prediction markets and executes real on-chain trades — all from Discord.

**@mention the bot** in any channel to ask about markets or place trades. It fetches real-time odds from Polymarket's APIs and responds conversationally using Google Gemini.

## Features

- **Natural language market search** — Ask `"what are the odds on BTC going up?"` and get live prices for matching markets
- **Live market data** — Prices, volume, and status pulled from the Polymarket Gamma API
- **AI-powered responses** — Gemini generates conversational answers with market context
- **Real trade execution** — BUY and SELL orders via Polymarket's CLOB API with Gnosis Safe signing
- **Timed market support** — Auto-resolves current BTC/ETH 5m and 15m up/down windows
- **Deterministic fallback** — Common trade patterns (`bet $5 on up`, `sell $5 of down`) work via regex without AI
- **Graceful degradation** — Falls back to structured data responses when AI quota is exhausted
- **Multi-key rotation** — Supports up to 6 Gemini API keys with automatic failover on rate limits
- **Wallet linking** — EIP-191 signature challenge flow for connecting Polymarket accounts
- **Security hardened** — CORS-restricted auth server, masked wallet logs, per-user cooldowns, daily spend limits

## Quick Start

```bash
git clone https://github.com/Prithwiraj-CK/polybot.git
cd polybot
npm install
```

Create a `.env` file (see [.env.example](.env.example) for all options):

```env
DISCORD_BOT_TOKEN=your_discord_bot_token
DISCORD_CLIENT_ID=your_discord_client_id
DISCORD_GUILD_ID=your_discord_guild_id

GEMINI_API_KEY=your_gemini_api_key

SUPABASE_URL=https://your-project.supabase.co
SUPABASE_KEY=your_supabase_anon_key

AUTH_BASE_URL=http://localhost:3001

# Polymarket CLOB API
POLYMARKET_API_KEY=your_polymarket_api_key
POLYMARKET_API_SECRET=your_polymarket_api_secret
POLYMARKET_PASSPHRASE=your_polymarket_passphrase
WALLET_PRIVATE_KEY=0xYOUR_PRIVATE_KEY
POLYMARKET_PROXY_WALLET=0xYOUR_PROXY_WALLET
```

Run:

```bash
npx tsx src/index.ts
```

The bot will log in and respond to @mentions in the configured server.

## Usage

### Market Queries (READ)
```
@PolyBot what are the odds on the next US election?
@PolyBot tell me about Bitcoin markets
@PolyBot show me trending crypto markets
```

### Trading (WRITE)
```
@PolyBot bet $5 on up on the current btc 15 min market
@PolyBot sell $5 of up on the current btc 15 min market
@PolyBot buy $5 on yes for "Will BTC hit 100k?"
@PolyBot exit $5 of down on the btc 5 minute market
```

### Account Management
```
/connect   — Link your Polymarket wallet
/status    — Check linked wallet
/balance   — View USDC balance and positions
/disconnect — Unlink wallet
```

## How It Works

```
User @mentions bot → Message Router → READ or WRITE pipeline

READ (default):
  1. Extract search keywords (AI or regex)
  2. Search Polymarket events/markets API
  3. Fetch prices, volume, status
  4. Generate conversational response (Gemini)
  5. Reply in Discord

WRITE (trade commands):
  1. Parse intent via AI or deterministic regex fallback
  2. Resolve timed market slug if applicable
  3. Validate deterministically (account, market, amount, limits)
  4. Execute BUY/SELL order via CLOB API (Fill-or-Kill)
  5. Reply with trade confirmation or error
```

## What Gemini Does

Gemini is used for **three things**, all non-authoritative:

| Use | File | What happens without it |
|-----|------|------------------------|
| **Keyword extraction** | `PolymarketApiReadProvider.ts` | Falls back to regex prefix stripping |
| **Conversational responses** | `aiReadExplainer.ts` | Falls back to structured data template |
| **Intent parsing** (WRITE) | `intentParser.ts` | Deterministic regex handles common patterns |

**Gemini is untrusted.** All AI output passes through deterministic validation before any action is taken.

## Project Structure

```
src/
├── index.ts                 # Discord client, @mention handler, per-user cooldown
├── wire.ts                  # Dependency injection + ClobPolymarketExecutionGateway
├── types.ts                 # Branded types (MarketId, UsdCents, TradeAction, etc.)
│
├── read/                    # READ pipeline
│   ├── geminiClient.ts      # Shared Gemini client with 6-key rotation
│   ├── PolymarketApiReadProvider.ts  # Gamma API client + timed market resolution
│   ├── PolymarketReadService.ts      # Service layer
│   └── aiReadExplainer.ts   # AI response generator + fallback
│
├── discord/                 # Discord layer
│   ├── DiscordMessageRouter.ts    # Routes READ/WRITE, deterministic trade fallback
│   ├── classifyMessageIntent.ts   # Regex classifier (no AI)
│   └── AccountLinkCommands.ts     # Slash commands: connect/status/balance/disconnect
│
├── agent/                   # AI intent parsing
│   └── intentParser.ts      # Gemini → structured JSON (BUY/SELL action)
│
├── backend/                 # Deterministic validation
│   ├── validateAgentOutput.ts     # Pure precondition checks
│   ├── buildTradeRequest.ts       # Trade assembly + idempotency
│   └── buildValidationContext.ts  # Context construction
│
├── auth/                    # EVM wallet linking
│   ├── AccountLinkChallengeService.ts
│   ├── AccountLinkVerificationService.ts
│   ├── AccountLinkPersistenceService.ts
│   ├── EvmSignatureVerifier.ts
│   └── polymarketAuth.ts
│
├── trading/                 # Trade execution
│   └── UserAccountTrader.ts # Executes BUY/SELL via CLOB gateway
│
├── storage/                 # Persistence
│   ├── limits.ts            # Per-user daily spend tracking ($5/day)
│   └── SupabaseAccountLinkStore.ts  # Supabase-backed account links
│
├── server/                  # Auth HTTP server
│   └── authServer.ts        # Express server for wallet-link flow
│
public/                      # Web UI for wallet connection
├── connect.html
└── trade-confirm.html
```

## Tech Stack

| Component | Technology |
|-----------|------------|
| Language | TypeScript (ES2022, strict mode) |
| Discord | discord.js v14 |
| AI | Google Gemini via `@google/genai` SDK |
| Trade Execution | `@polymarket/clob-client` + `@polymarket/order-utils` |
| Market Data | Polymarket Gamma API (public, no auth) |
| Wallet/Signing | ethers v6 (Gnosis Safe signature type) |
| Auth Server | Express v5, CORS-restricted |
| Persistence | Supabase (`@supabase/supabase-js`) |
| Config | dotenv |

## Security

- All credentials loaded from environment variables — no hardcoded secrets
- Wallet addresses masked in all log output
- CORS restricted to configured origins on auth server
- Auth endpoints protected with `BOT_API_SECRET` header
- Session store size-capped to prevent memory DoS
- Per-user 5-second command cooldown
- $5/day per-user spend limit with atomic enforcement
- Sell orders bypass spend limits (returns funds)
- Order result logs sanitized to `status`/`success`/`orderID` only

## Architecture

See [ARCHITECTURE.md](ARCHITECTURE.md) for the full file map, data flows, CLOB execution details, and design principles.
