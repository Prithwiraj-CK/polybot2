# @olympus/db

Database package for Olympus - Drizzle ORM schema and connection utilities.

## Overview

This package provides:

- **Drizzle ORM schema** - TypeScript-first schema definitions with full type safety
- **Connection utilities** - Optimized connections for both serverless (API) and long-running (Worker) environments
- **Migrations** - SQL migration files managed by Drizzle Kit

## Schema Organization

The schema is organized by domain into separate files:

```
src/schema/
├── users.ts          # User, UserSettings, WaitlistUser
├── copy-trading.ts   # LeaderWallet, FollowedWallet, CopyTradingSettings
├── trades.ts         # LeaderTrade, CopyOutcome, FollowerPosition
├── markets.ts        # Market metadata
├── settings.ts       # GlobalSettings
└── index.ts          # Exports and relations
```

## Connection Strategies

### Pool Connection (Serverless/API)

For serverless environments (Vercel, AWS Lambda):

```typescript
import { createPoolDb } from '@olympus/db/connections';

// Uses DATABASE_URL_POOLED (port 6543 with ?pgbouncer=true)
const db = createPoolDb(process.env.DATABASE_URL_POOLED!);
```

**Features:**

- Connection pooling optimized for Vercel Fluid Compute
- Integrated with `@vercel/functions` for proper cleanup
- Min pool: 1, Max: 10 connections
- 5-second idle timeout to prevent leaks

**Requirements:**

- Use Transaction Pooler connection string (port 6543)
- Add `?pgbouncer=true` parameter
- Example: `postgresql://user:pass@pooler.supabase.co:6543/db?pgbouncer=true`

### Client Connection (Workers/VPS)

For long-running processes (PM2 workers, background jobs):

```typescript
import { createClientDb } from '@olympus/db/connections';

// Uses DATABASE_URL_DIRECT (port 5432, direct connection)
const db = createClientDb(process.env.DATABASE_URL_DIRECT!);
```

**Features:**

- Single persistent connection
- Supports LISTEN/NOTIFY operations
- Designed for PM2-managed processes
- Better for long-running jobs

**Requirements:**

- Use direct connection string (port 5432)
- No `?pgbouncer=true` parameter
- Example: `postgresql://user:pass@db.supabase.co:5432/postgres`

## Usage in Apps

### In API (apps/api)

```typescript
import { createPoolDb } from '@olympus/db/connections';
import { users, leaderTrades } from '@olympus/db/schema';

const db = createPoolDb(process.env.DATABASE_URL_POOLED!);

// Query users
const allUsers = await db.select().from(users);

// Query with relations
const usersWithSettings = await db.query.users.findMany({
  with: {
    userSettings: true,
    followedWallets: true,
  },
});
```

### In Worker (apps/worker)

```typescript
import { createClientDb } from '@olympus/db/connections';
import { leaderTrades, copyOutcomes } from '@olympus/db/schema';

const db = createClientDb(process.env.DATABASE_URL_DIRECT!);

// Query trades
const recentTrades = await db
  .select()
  .from(leaderTrades)
  .orderBy(desc(leaderTrades.timestamp))
  .limit(100);
```

## Database Commands

All commands run from the **monorepo root** using Bun's workspace filter:

### Generate Migrations

```bash
# Generate migration from schema changes
bun db:generate

# This runs: bun --filter @olympus/db db:generate
# Which executes: drizzle-kit generate
```

### Push Schema to Database

```bash
# Push schema directly to database (dev only)
DATABASE_URL=$DATABASE_URL_DIRECT bun db:push

# Or load from worker .env
cd apps/worker && export $(cat .env | xargs) && cd ../.. && bun db:push
```

### Run Migrations

```bash
# Run pending migrations
DATABASE_URL=$DATABASE_URL_DIRECT bun db:migrate

# This runs: bun --filter @olympus/db db:migrate
# Which executes: drizzle-kit migrate
```

### Open Drizzle Studio

```bash
# Open database GUI
DATABASE_URL=$DATABASE_URL_DIRECT bun db:studio

# This runs: bun --filter @olympus/db db:studio
# Opens at http://localhost:4983
```

## Environment Variables

### For API (apps/api/.env)

```bash
DATABASE_URL_POOLED="postgresql://user:pass@pooler.region.supabase.co:6543/postgres?pgbouncer=true"
```

### For Worker (apps/worker/.env)

```bash
DATABASE_URL_DIRECT="postgresql://user:pass@db.region.supabase.co:5432/postgres"
```

### For Migrations

Use `DATABASE_URL_DIRECT` when running migrations:

```bash
DATABASE_URL=$DATABASE_URL_DIRECT bun db:push
```

## Monorepo Integration

This package is consumed by:

- **apps/api** - Uses pooled connection for serverless
- **apps/worker** - Uses direct connection for long-running processes

Package exports:

```json
{
  ".": "./src/index.ts",
  "./connections": "./src/connections/index.ts",
  "./schema": "./src/schema/index.ts"
}
```

## Type Safety

All tables export both runtime schema and TypeScript types:

```typescript
import { users } from '@olympus/db/schema';
import type { User } from '@olympus/db/schema';

// Insert with type safety
const newUser: typeof users.$inferInsert = {
  discordId: '123456789',
  walletAddress: '0x...',
};

// Select with type safety
type UserSelect = typeof users.$inferSelect;
```

## Schema Features

- **UUID primary keys** with database-generated defaults
- **Decimal types** for financial precision
- **JSON fields** with TypeScript types
- **Timestamps** with timezone support
- **Relations** using Drizzle's relational queries
- **Indexes** for optimal query performance
- **Cascade deletes** for referential integrity

## Migration Workflow

1. **Modify schema** in `src/schema/*.ts`
2. **Generate migration**: `bun db:generate`
3. **Review SQL** in `migrations/` directory
4. **Apply migration**: `DATABASE_URL=$DATABASE_URL_DIRECT bun db:migrate`

Or for development, skip migrations:

```bash
DATABASE_URL=$DATABASE_URL_DIRECT bun db:push
```

## Troubleshooting

### Error: "prepared statement already exists"

You're using a pooled connection (PgBouncer) without the `?pgbouncer=true` parameter. Add it to your connection string.

### Error: "too many connections"

You're using a direct connection (port 5432) in a serverless environment. Switch to the pooled connection (port 6543) with `createPoolDb()`.

### Migrations not applying

Make sure you're using `DATABASE_URL_DIRECT` (port 5432) when running migrations. Pooled connections don't support all DDL operations.

## Development

```bash
# Type check
bun run check-types

# Watch mode (in VS Code)
# Open packages/db in editor for instant type feedback
```

## Locked Balance (Trading Wallet Panel on home page)

The "Locked" value in the Trading Wallet Panel represents **funds committed to the unfilled portion of LIVE BUY limit orders**. It is only displayed when > 0.

### Formula

```
locked_usd = SUM(price × (shares_normalized - shares_matched_normalized))
             WHERE status = 'LIVE' AND side = 'BUY'
```

- `price` — the limit order price per share
- `shares_normalized` — total shares in the order
- `shares_matched_normalized` — shares already filled (default 0)
- The difference `(shares_normalized - shares_matched_normalized)` is the **unfilled portion**
- Multiplied by `price` gives the USD still committed to that order
- Summed across all LIVE BUY orders for the user

### Data Flow

1. **Frontend** — `TradingWalletPanel.tsx` reads `limitOrdersLockedUsd` from the `useTradingWallet` hook
2. **Hook** — `useTradingWallet.ts` calls the tRPC procedure `trpc.userWallet.getTradingWalletBalance`
3. **API** — `apps/api/src/routers/user-wallet.ts` → `getTradingWalletBalance` procedure calls `repos.limitOrders.getLiveBuyOrdersTotalUsd(userId)` in parallel with the on-chain balance fetch
4. **Repository** — `packages/db/src/repositories/limit-order.repository.ts` → `getLiveBuyOrdersTotalUsd()` runs the SQL aggregation query against the `pending_limit_orders` table
5. **Caching** — result is cached in Redis with 30-second TTL

### SQL

```sql
SELECT COALESCE(
  SUM(price::numeric * (shares_normalized::numeric - shares_matched_normalized::numeric)),
  0
) AS locked_usd
FROM pending_limit_orders
WHERE user_id = :userId
  AND status = 'LIVE'
  AND side = 'BUY';
```

### Schema

Table: `pending_limit_orders` (defined in `src/schema/limit-orders.ts`)

| Column                       | Type              | Role in calculation          |
| ---------------------------- | ----------------- | ---------------------------- |
| `user_id`                    | `uuid`            | Filter to current user       |
| `status`                     | `text`            | Must be `'LIVE'`             |
| `side`                       | `text`            | Must be `'BUY'`              |
| `price`                      | `decimal(18, 8)`  | Price per share              |
| `shares_normalized`          | `decimal(18, 6)`  | Total shares ordered         |
| `shares_matched_normalized`  | `decimal(18, 6)`  | Shares already filled        |

### Edge Cases

- **No LIVE BUY orders** → returns `0` (via `COALESCE`), and the Locked section is hidden in the UI
- **Fully matched order** → `shares_normalized == shares_matched_normalized` → contributes `0` (status would typically be `MATCHED` at that point)
- **Query failure** → API returns `0` as default, logs the error internally

## Followed Wallet Stats (wallets on home page)

Each followed wallet displays several stats to the user. Some are persisted in the database, others are fetched live from external APIs on every request.

### Stored in Database (`followed_wallets` table)

| Column                  | Type            | Source                                                       | When Updated                       |
| ----------------------- | --------------- | ------------------------------------------------------------ | ---------------------------------- |
| `polymarket_views`      | `integer`       | Polymarket Profile Stats API                                 | On wallet add; manually via script |
| `target_unrealized_pnl` | `decimal(18,2)` | Polymarket Data API (sum of `cashPnl` across open positions) | On wallet add; manually via script |

- **Views** require `polymarket_username` to be set on the followed wallet (the Polymarket stats API needs both `proxyAddress` and `username`).
- **Unrealized PnL** is the sum of `cashPnl` across all open positions for the target wallet at the time of capture.

### Fetched Live (NOT stored in DB)

| Stat                      | Source                                                                | Cached?                                   |
| ------------------------- | --------------------------------------------------------------------- | ----------------------------------------- |
| PnL (overall profit/loss) | Polymarket Leaderboard API (`data-api.polymarket.com/v1/leaderboard`) | Yes, via Redis (5 min TTL in API service) |
| Win Rate                  | `polymarketanalytics.com` API                                         | Yes, via Redis (5 min TTL in API service) |
| Total Positions           | `polymarketanalytics.com` API                                         | Yes, via Redis (5 min TTL in API service) |
| Active Positions          | `polymarketanalytics.com` API                                         | Yes, via Redis (5 min TTL in API service) |

These live stats are returned in the `stats` field of `FollowedWalletWithStats` and come from the `PolymarketAnalyticsService`. PnL and the other stats are fetched in parallel from different sources — PnL from the Polymarket Leaderboard API, and winRate/positions from `polymarketanalytics.com`.

### Refresh Script

To manually refresh the DB-stored stats (`polymarketViews` + `targetUnrealizedPnl`) for a specific user's wallets:

```bash
cd apps/worker
bun run src/scripts/update-followed-wallet-stats.ts
```

Edit the `DISCORD_ID` constant in the script to target a different user. The script also logs the live PnL and win rate from polymarketanalytics.com for reference.

## Top Wallets Page Stats (`/app/top-wallets`)

The top wallets page displays a leaderboard of ~100 curated wallets. **No stats are stored in the database** — everything is fetched from external APIs and cached in Redis.

### Data Sources

| Stat             | Source                        | Notes                                        |
| ---------------- | ----------------------------- | -------------------------------------------- |
| PnL (realized)   | Polymarket Leaderboard API    | Overrides `polymarketanalytics.com` PnL      |
| Win Rate         | `polymarketanalytics.com` API | `win_rate` field (0–1 decimal)               |
| Total Positions  | `polymarketanalytics.com` API | `total_positions` field                      |
| Active Positions | `polymarketanalytics.com` API | `active_positions` field                     |
| Total Volume     | `polymarketanalytics.com` API | Sum of `total_current_value` + `loss_amount` |
| Trade Count      | `polymarketanalytics.com` API | `event_ct` field                             |
| Pseudonym        | `polymarketanalytics.com` API | `trader_name` or `trader` field              |
| Views            | Polymarket Profile Stats API  | Requires `proxyAddress` + `username`         |
| Avatar URL       | Polymarket Profile API        | `profileImage` field                         |
| Cash (USDC)      | Polygon RPC (Multicall3)      | Native USDC + bridged USDC.e                 |
| Positions Value  | Polymarket Data API           | Total USD value of open positions            |
| Unrealized PnL   | Polymarket Data API           | Sum of `cashPnl` across open positions       |

## Trader Profile Page Stats (`/trader/[address]`)

The individual trader profile page uses a **hybrid frontend-first + server-side** approach. Public CORS-friendly data is fetched directly from the browser; CORS-blocked or RPC data goes through tRPC.

**No stats are stored in the database** — everything is fetched live and cached at the client or server level.

### Tier 1: Browser-Direct (Polymarket public APIs)

Fetched directly from the browser with no backend proxy. Client-side cache via React Query (3 min `staleTime`).

| Stat                         | Source                     | Endpoint                                   |
| ---------------------------- | -------------------------- | ------------------------------------------ |
| PnL (realized)               | Polymarket Leaderboard API | `data-api.polymarket.com/v1/leaderboard`   |
| Total Volume                 | Polymarket Leaderboard API | Same as above                              |
| Pseudonym / Profile Image    | Polymarket Leaderboard API | Same as above                              |
| Views                        | Polymarket User Stats API  | `data-api.polymarket.com/v1/user-stats`    |
| Trade Count                  | Polymarket User Stats API  | Same as above                              |
| Position Value               | Polymarket Value API       | `data-api.polymarket.com/value`            |
| Open Positions (list + uPnL) | Polymarket Data API        | `data-api.polymarket.com/positions`        |
| Closed Positions             | Polymarket Data API        | `data-api.polymarket.com/closed-positions` |
| Trade Activity               | Polymarket Data API        | `data-api.polymarket.com/activity`         |
| PnL History (chart)          | Polymarket User PnL API    | `user-pnl-api.polymarket.com/user-pnl`     |

Hook: `useTraderPublicStats` — fires 3 parallel requests (leaderboard, user-stats, value).

### Tier 2: Server-Side (tRPC backend)

Fetched via `trpc.trader.getProfile` for CORS-blocked or RPC data.

| Stat                  | Source                        | Cache                                          |
| --------------------- | ----------------------------- | ---------------------------------------------- |
| Win Rate              | `polymarketanalytics.com` API | Redis `trader-profile-v3:{address}`, 3 min TTL |
| Total Positions Count | `polymarketanalytics.com` API | Same cache key                                 |
| Cash (USDC balance)   | Polygon RPC (Multicall3)      | Same cache key                                 |

Router: `apps/api/src/routers/trader.ts` — public procedure, checks Redis cache first, on miss fetches analytics + balance in parallel via `Promise.allSettled()`.

### Total Gains / Total Losses Calculation

Calculated **client-side** via the `useTraderGainsLosses` hook. Sums PnL across **all** open and closed positions:

- **Open positions**: `cashPnl` (unrealized, current value minus cost basis) **+ `realizedPnl`** (locked-in profit/loss from partial sells within the still-open position). Both fields come from `useTraderOpenPositions` (500/page, up to 10k).
- **Closed positions**: `realizedPnl` per position (eagerly fetched by the hook, 50/page — auto-paginates all pages)

For each position (open or closed), if the combined PnL is positive it is added to **Total Gains**; if negative it is added to **Total Losses**.

#### Why both fields matter for open positions

The Polymarket Data API returns two separate PnL fields on open positions:

| Field | Meaning |
| --- | --- |
| `cashPnl` | Unrealized PnL on the **current** holding (`currentValue - initialValue`) |
| `realizedPnl` | Already locked-in profit/loss from **partial sells** within that position |

A trader who buys 1000 shares, sells 500 at a profit, and still holds 500 will have a positive `realizedPnl` (the profit from the 500 sold) and a separate `cashPnl` (unrealized gain/loss on the remaining 500). Both must be summed to get the true PnL for that position.

#### Verification

The sum `cashPnl(open) + realizedPnl(open) + realizedPnl(closed)` closely matches the Polymarket Leaderboard API's `pnl` field (small differences are due to real-time price movement between fetches).

> Previously this slot showed Unrealized PnL (open positions only) and Open Positions count. Those stats are commented out in `TraderStatsGrid.tsx`.

### Stats Displayed (TraderStatsGrid)

8 metrics shown: PnL, Total Gains, Total Losses, Win Rate, Views, Total Assets (position value + cash), Position Value, Volume.

### Position Data

- **Open positions**: Infinite pagination via `useTraderOpenPositions` — 500 per page, auto-fetches all pages, deduplicates, shows 100 initially with lazy-load scroll
- **Closed positions**: Lazy-loaded only when tab is active — 50 per page (Polymarket API hard cap)
- **Trade activity**: Lazy-loaded only when tab is active — 100 per page, filters out `YIELD` and `REDEEM` types client-side

## Stat Implementation Differences: All Three Pages

(polymarketanalytics.com is never used for PnL; it's called alongside the Leaderboard API to fetch winRate, totalPositions, and activePositions (which the Leaderboard API does not provide)—PnL always comes from the Leaderboard API on all three pages.)

| Stat                       | Followed Wallets (home)                                             | Top Wallets (`/app/top-wallets`)                               | Trader Profile (`/trader/[address]`)                                 | Differences                                                                                                                                                                                              |
| -------------------------- | ------------------------------------------------------------------- | -------------------------------------------------------------- | -------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PnL                        | Polymarket Leaderboard API via backend, Redis 5 min TTL             | Polymarket Leaderboard API via worker scheduler, Redis 1hr TTL | Polymarket Leaderboard API via **browser-direct**, React Query 3 min | Same source on all three (Leaderboard API), different delivery — backend-proxied 5 min cache (FOLLOWED) vs worker-prebuilt 1hr cache (TOP WALLETS) vs browser-direct 3 min client cache (TRADER PROFILE) |
| Win Rate                   | `polymarketanalytics.com` via backend, Redis 5 min TTL              | `polymarketanalytics.com` via worker scheduler, Redis 1hr TTL  | `polymarketanalytics.com` via tRPC backend, Redis 3 min TTL          | Same source, different caching — 5 min (FOLLOWED) vs 1hr WORKER (TOP WALLETS) vs 3 MIN (TRADER PROFILE)                                                                                                  |
| Unrealized PnL             | **STORED IN DB** (`target_unrealized_pnl`) — point-in-time snapshot | Fetched live via worker, cached in Redis 1hr                   | _Removed from stats grid_ (commented out)                            | DIFFERENT ON ALL THREE — DB SNAPSHOT (FOLLOWED) vs REDIS LIVE (TOP WALLETS) vs REMOVED (TRADER PROFILE)                                                                                                  |
| Total Gains / Total Losses | Not displayed                                                       | Not displayed                                                  | **CALCULATED CLIENT-SIDE** from all open (`cashPnl + realizedPnl`) + all closed (`realizedPnl`) positions via `useTraderGainsLosses` | TRADER PROFILE ONLY — eagerly fetches all closed position pages to build complete totals                                                                                  |
| Views                      | **STORED IN DB** (`polymarket_views`)                               | Polymarket Profile Stats API via worker, Redis 1hr             | Polymarket User Stats API via **browser-direct**                     | DIFFERENT ON ALL THREE — DB (FOLLOWED) vs PROFILE STATS API IN WORKER (TOP WALLETS) vs USER STATS API FROM BROWSER (TRADER PROFILE)                                                                      |
| Cash (USDC)                | Not displayed                                                       | Polygon RPC via worker, Redis 1hr                              | Polygon RPC via tRPC backend, Redis 3 min                            | NOT SHOWN ON FOLLOWED WALLETS; TOP WALLETS AND TRADER PROFILE BOTH USE RPC BUT WITH DIFFERENT CACHE TTLs (1hr vs 3 MIN)                                                                                  |
| Positions Value            | Not displayed                                                       | Polymarket Data API via worker, Redis 1hr                      | Polymarket Value API via **browser-direct**                          | NOT SHOWN ON FOLLOWED WALLETS; DIFFERENT API ENDPOINTS — TOP WALLETS USE DATA API SERVER-SIDE; TRADER PROFILE USES VALUE API FROM BROWSER                                                                |
| Total Volume               | Not displayed                                                       | `polymarketanalytics.com` via worker, Redis 1hr                | Polymarket Leaderboard API via **browser-direct**                    | NOT SHOWN ON FOLLOWED WALLETS; DIFFERENT SOURCE — TOP WALLETS USE POLYMARKETANALYTICS.COM; TRADER PROFILE USES LEADERBOARD API                                                                           |
| Trade Count                | Not displayed                                                       | `polymarketanalytics.com` via worker, Redis 1hr                | Polymarket User Stats API via **browser-direct**                     | NOT SHOWN ON FOLLOWED WALLETS; DIFFERENT SOURCE — TOP WALLETS USE POLYMARKETANALYTICS.COM; TRADER PROFILE USES USER STATS API                                                                            |
| Total/Active Positions     | `polymarketanalytics.com` via backend, Redis 5 min TTL              | `polymarketanalytics.com` via worker, Redis 1hr TTL            | `polymarketanalytics.com` via tRPC backend, Redis 3 min TTL          | Same source, different caching — 5 min (FOLLOWED) vs 1hr (TOP WALLETS) vs 3 min (TRADER PROFILE)                                                                                                         |
| Open/Closed Positions list | Not displayed                                                       | Not displayed                                                  | Polymarket Data API via **browser-direct** with infinite pagination  | TRADER PROFILE ONLY                                                                                                                                                                                      |
| PnL History chart          | Not displayed                                                       | Not displayed                                                  | `user-pnl-api.polymarket.com` via **browser-direct**                 | TRADER PROFILE ONLY                                                                                                                                                                                      |
