import { parseIntent } from '../agent/intentParser';
import { buildTradeRequest } from '../backend/buildTradeRequest';
import {
	type ValidationErrorCode,
	type ValidationContext,
	validateAgentOutput,
} from '../backend/validateAgentOutput';
import { classifyMessageIntent } from './classifyMessageIntent';
import { PolymarketReadService, type MarketSummary } from '../read/PolymarketReadService';
import type { DiscordUserId, Market, MarketId, TradeAction, TradeResult, Trader, UserIdentity, UsdCents } from '../types';
import {
	DAILY_LIMIT_CENTS,
	canSpend,
	getSpentToday,
	getRemainingToday,
	isOwnerExempt,
	recordSpend,
} from '../storage/limits';
import crypto from 'crypto';

/**
 * Result of routing a Discord message.
 * Either a plain text response or a trade confirmation request.
 */
export type RouteResult =
	| { readonly type: 'text'; readonly content: string }
	| {
		readonly type: 'confirm';
		readonly confirmId: string;
		readonly marketQuestion: string;
		readonly outcome: 'YES' | 'NO';
		readonly action: TradeAction;
		readonly amountDollars: string;
	};

/**
 * Data passed to the READ explainer.
 * The explainer is intentionally read-only and receives factual inputs only.
 */
export interface ReadExplainerInput {
	readonly message: string;
	readonly liveMarketCount: number;
	readonly sampleMarketSummaries: readonly MarketSummary[];
	readonly searchResultsCount: number;
}

/**
 * Dependency contract for Discord orchestration.
 *
 * Routing is centralized here so lower layers stay focused:
 * - READ layer returns market information only.
 * - WRITE layers parse/validate/build/execute only.
 * - This router is the first user-facing message boundary.
 */
export interface DiscordMessageRouterDependencies {
	readonly readService: PolymarketReadService;
	readonly trader: Trader;
	readonly buildValidationContext: (discordUserId: DiscordUserId) => Promise<ValidationContext>;
	readonly nowMs: () => number;
	readonly readExplainer?: (input: ReadExplainerInput) => Promise<string>;
}

/**
 * Orchestrates inbound Discord message handling.
 *
 * This class intentionally contains presentation mapping, while business rules remain
 * in deterministic validation/execution layers.
 */
export class DiscordMessageRouter {
	private readonly readExplainer: (input: ReadExplainerInput) => Promise<string>;
	/** Pending trade confirmations: confirmId → executor + expiry */
	private readonly pendingTrades = new Map<string, { execute: () => Promise<string>; expiresAtMs: number }>();

	public constructor(private readonly deps: DiscordMessageRouterDependencies) {
		this.readExplainer = deps.readExplainer ?? defaultReadExplainer;
		// Purge expired pending trades every 2 minutes
		setInterval(() => {
			const now = Date.now();
			for (const [id, p] of this.pendingTrades) {
				if (p.expiresAtMs < now) this.pendingTrades.delete(id);
			}
		}, 2 * 60 * 1000);
	}

	/**
	 * Execute a previously confirmed pending trade. Returns the result message.
	 * Returns null if the confirmId is unknown or expired.
	 */
	public async executePendingTrade(confirmId: string): Promise<string | null> {
		const pending = this.pendingTrades.get(confirmId);
		if (!pending) return null;
		this.pendingTrades.delete(confirmId);
		if (pending.expiresAtMs < Date.now()) return null;
		return pending.execute();
	}

	/** Cancel a pending trade. Returns true if it existed. */
	public cancelPendingTrade(confirmId: string): boolean {
		if (!this.pendingTrades.has(confirmId)) return false;
		this.pendingTrades.delete(confirmId);
		return true;
	}

	/** Store a pending trade and return its confirmId. Expires in 5 minutes. */
	private storePendingTrade(execute: () => Promise<string>): string {
		const confirmId = crypto.randomUUID();
		this.pendingTrades.set(confirmId, { execute, expiresAtMs: Date.now() + 5 * 60 * 1000 });
		return confirmId;
	}

	/** Read on-chain USDC balance for any wallet address. Returns cents. */
	private async readOnchainUsdcBalance(address: string): Promise<number> {
		const USDC_CONTRACT = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';
		const RPC_ENDPOINTS = [
			process.env.POLYGON_RPC_URL,
			'https://polygon-bor-rpc.publicnode.com',
			'https://1rpc.io/matic',
		].filter((v): v is string => Boolean(v && v.length > 0));

		const addressHex = address.toLowerCase().replace(/^0x/, '');
		if (addressHex.length !== 40) return 0;

		const data = `0x70a08231000000000000000000000000${addressHex}`;

		for (const endpoint of RPC_ENDPOINTS) {
			try {
				const response = await fetch(endpoint, {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({
						jsonrpc: '2.0', method: 'eth_call',
						params: [{ to: USDC_CONTRACT, data }, 'latest'], id: 1,
					}),
				});
				if (!response.ok) continue;
				const payload = (await response.json()) as { result?: string };
				if (!payload.result?.startsWith('0x')) continue;
				const raw = BigInt(payload.result);
				const cents = raw / 10_000n;
				return Number(cents > BigInt(Number.MAX_SAFE_INTEGER) ? BigInt(Number.MAX_SAFE_INTEGER) : cents);
			} catch { continue; }
		}
		return 0;
	}

	/**
	 * Main entry point for routing a Discord message.
	 * Returns either a plain text response or a trade confirmation request.
	 */
	public async routeMessage(message: string, discordUserId: DiscordUserId): Promise<RouteResult> {
		try {
			if (isDeterministicWriteMessage(message)) {
				return this.handleWrite(message, discordUserId);
			}

			const pipeline = classifyMessageIntent(message);

			if (pipeline === 'READ') {
				const content = await this.handleRead(message);
				return { type: 'text', content };
			}

			return this.handleWrite(message, discordUserId);
		} catch {
			return { type: 'text', content: 'Something went wrong while handling your request. Please try again.' };
		}
	}

	private async handleRead(message: string): Promise<string> {
		console.log(`[router] handleRead: "${message}"`);
		const liveMarkets = await this.deps.readService.listLiveMarkets();
		console.log(`[router] Live markets: ${liveMarkets.length}`);
		const searchResults = await this.deps.readService.searchMarketsByText(message);
		console.log(`[router] Search results: ${searchResults.length}`);
		const sampleSource = searchResults.length > 0 ? searchResults : liveMarkets;
		const sampleSummaries = await summarizeUpToThree(this.deps.readService, sampleSource, message);
		console.log(`[router] Sample summaries: ${sampleSummaries.map(s => s.question).join(' | ')}`);

		return this.readExplainer({
			message,
			liveMarketCount: liveMarkets.length,
			sampleMarketSummaries: sampleSummaries,
			searchResultsCount: searchResults.length,
		});
	}

	private async handleWrite(message: string, discordUserId: DiscordUserId): Promise<RouteResult> {
		const agentOutput = await parseIntent(message, discordUserId);
		if (agentOutput === null) {
			const fallback = await this.tryDeterministicWriteFallback(message, discordUserId);
			if (fallback !== null) {
				return fallback;
			}
			return { type: 'text', content: 'I could not confidently parse that request. Please try again with a clearer command.' };
		}

		// --- get_balance ---
		if (agentOutput.intent === 'get_balance') {
			// Check if the user provided a wallet address in their message
			const rawText = agentOutput.rawText ?? message;
			const addrMatch = rawText.match(/0x[a-fA-F0-9]{40}/);
			const userProvidedAddr = addrMatch ? addrMatch[0] : null;

			if (userProvidedAddr) {
				// User wants to check a specific wallet — use public APIs (no login needed)
				const shortAddr = `${userProvidedAddr.slice(0, 6)}...${userProvidedAddr.slice(-4)}`;

				let cashDollars = '0.00';
				let positionValueDollars = '0.00';
				let openPositionsCount = 0;
				interface PositionRow { title?: string; curPrice?: number; size?: number; outcome?: string; }
				let topPositions: PositionRow[] = [];

				try {
					const [balResp, valueResp, posResp] = await Promise.all([
						this.readOnchainUsdcBalance(userProvidedAddr),
						fetch(`https://data-api.polymarket.com/value?user=${encodeURIComponent(userProvidedAddr)}`),
						fetch(`https://data-api.polymarket.com/positions?user=${encodeURIComponent(userProvidedAddr)}&sizeThreshold=.1`),
					]);

					cashDollars = (balResp / 100).toFixed(2);

					if (valueResp.ok) {
						const rows = (await valueResp.json()) as Array<{ value?: number }>;
						positionValueDollars = (rows?.[0]?.value ?? 0).toFixed(2);
					}
					if (posResp.ok) {
						const positions = (await posResp.json()) as PositionRow[];
						openPositionsCount = Array.isArray(positions) ? positions.length : 0;
						topPositions = Array.isArray(positions) ? positions.slice(0, 5) : [];
					}
				} catch { /* fallback to defaults */ }

				const lines = [
					`💰 **Wallet Balance**`,
					`• Wallet: \`${shortAddr}\``,
					`• Cash (USDC): **$${cashDollars}**`,
					`• Position value: **$${positionValueDollars}**`,
					`• Open positions: **${openPositionsCount}**`,
				];

				if (topPositions.length > 0) {
					lines.push('', '📊 **Top Positions:**');
					for (const pos of topPositions) {
						const title = pos.title ?? 'Unknown market';
						const price = pos.curPrice != null ? `$${Number(pos.curPrice).toFixed(2)}` : '?';
						const size = pos.size != null ? Number(pos.size).toFixed(2) : '?';
						const outcome = pos.outcome ?? '';
						lines.push(`• ${title} — ${outcome} ${size} shares @ ${price}`);
					}
				}

				return { type: 'text', content: lines.join('\n') };
			}

			// No wallet address provided — show trading wallet balance + daily spend limit
			const balance = await this.deps.trader.getBalance(discordUserId);
			const availableDollars = (balance.availableCents / 100).toFixed(2);
			const tradingWallet = process.env.POLYMARKET_PROXY_WALLET ?? '';
			const shortAddr = tradingWallet ? `${tradingWallet.slice(0, 6)}...${tradingWallet.slice(-4)}` : 'N/A';

			if (isOwnerExempt(discordUserId)) {
				return {
					type: 'text', content: [
						`💰 **Trading Wallet**`,
						`• Wallet: \`${shortAddr}\``,
						`• Cash (USDC): **$${availableDollars}**`,
						`• Daily limit: **unlimited** (owner)`,
						``,
						`💡 *Tip: To check any wallet, include its address — e.g. \`balance 0xABC...\`*`,
					].join('\n')
				};
			}

			const spent = await getSpentToday(discordUserId);
			const remaining = await getRemainingToday(discordUserId);
			const limitDollars = (DAILY_LIMIT_CENTS / 100).toFixed(2);
			const spentDollars = (spent / 100).toFixed(2);
			const remainingDollars = (remaining / 100).toFixed(2);
			return {
				type: 'text', content: [
					`💰 **Trading Wallet**`,
					`• Wallet: \`${shortAddr}\``,
					`• Cash (USDC): **$${availableDollars}**`,
					`• Your daily spend: **$${spentDollars}** / $${limitDollars}`,
					`• Remaining today: **$${remainingDollars}**`,
					``,
					`💡 *Tip: To check your own wallet, include your proxy address — e.g. \`balance 0xABC...\`*`,
				].join('\n')
			};
		}

		// --- get_trade_history ---
		if (agentOutput.intent === 'get_trade_history') {
			const limit = agentOutput.limit ?? 5;

			const validationContext = await this.deps.buildValidationContext(discordUserId);
			const linkedAccountId = validationContext.polymarketAccountId ?? (process.env.POLYMARKET_PROXY_WALLET || null);
			if (!linkedAccountId) {
				return { type: 'text', content: 'Trading is not available right now. Please contact an admin.' };
			}

			const activities = await fetchPolymarketActivity(linkedAccountId, limit);
			if (activities.length > 0) {
				const lines = activities.map((activity, index) => formatActivityLine(activity, index));
				return { type: 'text', content: [`**Your last ${Math.min(limit, activities.length)} activity entries:**`, ...lines].join('\n') };
			}

			const trades = await this.deps.trader.getRecentTrades(discordUserId, limit);
			if (trades.length === 0) {
				return { type: 'text', content: 'You have no recent trades yet.' };
			}
			const lines = trades.map((t, i) => {
				if (!t.ok) return `${i + 1}. ❌ Trade failed (${t.errorCode})`;
				const dollars = (t.amountCents / 100).toFixed(2);
				const date = new Date(t.executedAtMs).toUTCString();
				return `${i + 1}. ✅ **${t.outcome}** $${dollars} on \`${t.marketId}\` — ${date}`;
			});
			return { type: 'text', content: [`**Your last ${limit} trades:**`, ...lines].join('\n') };
		}

		// --- place_bet ---
		if (agentOutput.intent !== 'place_bet') {
			return { type: 'text', content: 'I could not confirm a trade placement request. Please restate the trade with explicit action and amount.' };
		}

		// Enforce daily spend limit before doing anything else (only for BUY — sells return funds)
		// Owner is exempt from spend limits for testing purposes.
		const actionForSpend = (agentOutput.intent === 'place_bet' ? (agentOutput.action ?? 'BUY') : 'BUY') as TradeAction;
		if (actionForSpend === 'BUY' && !isOwnerExempt(discordUserId) && !(await canSpend(discordUserId, agentOutput.amountCents))) {
			const remaining = await getRemainingToday(discordUserId);
			const remainingDollars = (remaining / 100).toFixed(2);
			const limitDollars = (DAILY_LIMIT_CENTS / 100).toFixed(2);
			return { type: 'text', content: `⛔ Daily limit reached. You can spend **$${remainingDollars}** more today (limit: $${limitDollars}/day).` };
		}

		const resolvedMarket = await this.deps.readService.getMarketById(agentOutput.marketId);
		const timedResolution = await tryResolveTimedUpDownMarket(this.deps.readService, message);
		const effectiveMarket = timedResolution?.market ?? resolvedMarket;
		const effectiveSlug = timedResolution?.slug ?? null;
		const effectiveIntent = {
			...agentOutput,
			marketId: (effectiveMarket?.id ?? agentOutput.marketId) as MarketId,
		};

		const baseValidationContext = await this.deps.buildValidationContext(discordUserId);
		const validationContext: ValidationContext = {
			...baseValidationContext,
			marketLookup: (marketId) => {
				if (marketId !== effectiveIntent.marketId) {
					return baseValidationContext.marketLookup(marketId);
				}
				if (effectiveMarket === null) return null;
				return { id: effectiveMarket.id, status: effectiveMarket.status };
			},
		};

		const validation = validateAgentOutput(effectiveIntent, validationContext);
		if (!validation.ok) {
			return { type: 'text', content: mapValidationErrorToUserMessage(validation.error.code) };
		}

		if (effectiveMarket === null) {
			return { type: 'text', content: mapValidationErrorToUserMessage('INVALID_MARKET') };
		}

		const polymarketAccountId = validationContext.polymarketAccountId as NonNullable<
			ValidationContext['polymarketAccountId']
		>;

		const identity: UserIdentity = {
			discordUserId,
			polymarketAccountId,
		};

		const tradeRequest = buildTradeRequest(effectiveIntent, {
			identity,
			market: effectiveMarket,
			nowMs: this.deps.nowMs(),
		});

		// Store pending trade and return confirmation prompt
		const amountCentsNum = Number(effectiveIntent.amountCents);
		const confirmId = this.storePendingTrade(async () => {
			const tradeResult = await this.deps.trader.placeTrade(tradeRequest);
			if (tradeResult.ok && actionForSpend === 'BUY') {
				await recordSpend(discordUserId, amountCentsNum);
			}
			return formatTradeResultMessage(tradeResult, {
				marketQuestion: effectiveMarket.question,
				outcome: effectiveIntent.outcome,
				action: actionForSpend,
				amountCents: amountCentsNum,
			});
		});

		return {
			type: 'confirm',
			confirmId,
			marketQuestion: effectiveMarket.question,
			outcome: effectiveIntent.outcome,
			action: actionForSpend,
			amountDollars: (amountCentsNum / 100).toFixed(2),
		};
	}

	private async tryDeterministicWriteFallback(
		message: string,
		discordUserId: DiscordUserId,
	): Promise<RouteResult | null> {
		const normalized = message.trim().toLowerCase();

		if (/\b(past | last | recent) \b.*\btrades ?\b |\btrade\s + history\b /.test(normalized)) {
			const wordToNumber: Record<string, number> = {
				one: 1, two: 2, three: 3, four: 4, five: 5,
				six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
			};

			const numericMatch = normalized.match(/\b(last|past)\s+(\d+)\s+trades?\b/);
			const wordMatch = normalized.match(/\b(last|past)\s+(one|two|three|four|five|six|seven|eight|nine|ten)\s+trades?\b/);
			const limit = numericMatch
				? Math.max(1, Math.min(20, Number(numericMatch[2])))
				: wordMatch
					? wordToNumber[wordMatch[2]]
					: 5;

			const trades = await this.deps.trader.getRecentTrades(discordUserId, limit);
			if (trades.length === 0) {
				return { type: 'text', content: 'You have no recent trades yet.' };
			}

			const lines = trades.map((trade, index) => {
				if (!trade.ok) return `${index + 1}. ❌ Trade failed (${trade.errorCode})`;
				const dollars = (trade.amountCents / 100).toFixed(2);
				const date = new Date(trade.executedAtMs).toUTCString();
				return `${index + 1}. ✅ **${trade.outcome}** $${dollars} on \`${trade.marketId}\` — ${date}`;
			});

			return { type: 'text', content: [`**Your last ${limit} trades:**`, ...lines].join('\n') };
		}

		const amountMatch = normalized.match(/\$\s*(\d+(?:\.\d{1,2})?)/)
			?? normalized.match(/\b(\d+(?:\.\d{1,2})?)\s*(dollars?|usd|bucks?)\b/);

		// Detect trade action: sell/exit/close => SELL, everything else => BUY
		const isSell = /\b(sell|exit|close)\b/.test(normalized);
		const action: TradeAction = isSell ? 'SELL' : 'BUY';

		// Detect outcome: up/yes/long => YES, down/no/short => NO
		// For sells, buy/sell words refer to the action, not the outcome
		const outcome: 'YES' | 'NO' | null = /\b(up|yes|long)\b/.test(normalized)
			? 'YES'
			: /\b(down|no|short)\b/.test(normalized)
				? 'NO'
				: null;

		if (!amountMatch || !outcome || !/\b(bet|buy|sell|trade|market|exit|close)\b/.test(normalized)) {
			return null;
		}

		const amountDollars = Number(amountMatch[1]);
		if (!Number.isFinite(amountDollars) || amountDollars <= 0) {
			return { type: 'text', content: 'The trade amount is invalid. Please provide a positive amount.' };
		}

		const amountCents = Math.round(amountDollars * 100);
		const assetQuery = /\b(bitcoin|btc)\b/.test(normalized)
			? 'bitcoin up or down'
			: /\b(ethereum|eth)\b/.test(normalized)
				? 'ethereum up or down'
				: null;

		if (!assetQuery) {
			return null;
		}

		const timeframe = /\b(5|five)\s*(m|min|minute)\b/.test(normalized)
			? '5 minute'
			: /\b(15|fifteen)\s*(m|min|minute)\b/.test(normalized)
				? '15 minute'
				: '';

		// Try direct Gamma events API slug-based resolution first (reliable for timed markets)
		const timedResult = await tryResolveTimedUpDownMarket(this.deps.readService, message);
		let selectedMarket: Market | null = timedResult?.market ?? null;
		let selectedSlug: string | null = timedResult?.slug ?? null;

		if (!selectedMarket) {
			// Fallback to text search
			const candidates = await this.deps.readService.searchMarketsByText(assetQuery);
			selectedMarket = pickBestNaturalTradeMarket(candidates, normalized, timeframe);
		}

		if (!selectedMarket) {
			return { type: 'text', content: 'I could not find an active matching market right now. Please specify the market ID.' };
		}
		const pseudoIntent = {
			intent: 'place_bet' as const,
			userId: discordUserId,
			marketId: selectedMarket.id as MarketId,
			outcome,
			action,
			amountCents: amountCents as UsdCents,
			rawText: message,
		};

		if (action === 'BUY' && !isOwnerExempt(discordUserId) && !(await canSpend(discordUserId, pseudoIntent.amountCents))) {
			const remaining = await getRemainingToday(discordUserId);
			const remainingDollars = (remaining / 100).toFixed(2);
			const limitDollars = (DAILY_LIMIT_CENTS / 100).toFixed(2);
			return { type: 'text', content: `⛔ Daily limit reached. You can spend **$${remainingDollars}** more today (limit: $${limitDollars}/day).` };
		}

		const baseValidationContext = await this.deps.buildValidationContext(discordUserId);
		const validationContext: ValidationContext = {
			...baseValidationContext,
			marketLookup: (marketId) => {
				if (marketId !== pseudoIntent.marketId) {
					return baseValidationContext.marketLookup(marketId);
				}
				return { id: selectedMarket.id, status: selectedMarket.status };
			},
		};

		const validation = validateAgentOutput(pseudoIntent, validationContext);
		if (!validation.ok) {
			return { type: 'text', content: mapValidationErrorToUserMessage(validation.error.code) };
		}

		const polymarketAccountId = validationContext.polymarketAccountId as NonNullable<
			ValidationContext['polymarketAccountId']
		>;

		const identity: UserIdentity = {
			discordUserId,
			polymarketAccountId,
		};

		const tradeRequest = buildTradeRequest(pseudoIntent, {
			identity,
			market: selectedMarket,
			nowMs: this.deps.nowMs(),
		});

		// Store pending trade and return confirmation prompt
		const amountCentsNum = Number(pseudoIntent.amountCents);
		const confirmId = this.storePendingTrade(async () => {
			const tradeResult = await this.deps.trader.placeTrade(tradeRequest);
			if (tradeResult.ok && action === 'BUY') {
				await recordSpend(discordUserId, amountCentsNum);
			}
			return formatTradeResultMessage(tradeResult, {
				marketQuestion: selectedMarket.question,
				outcome: pseudoIntent.outcome,
				action: pseudoIntent.action,
				amountCents: amountCentsNum,
			});
		});

		return {
			type: 'confirm',
			confirmId,
			marketQuestion: selectedMarket.question,
			outcome: pseudoIntent.outcome,
			action: pseudoIntent.action,
			amountDollars: (amountCentsNum / 100).toFixed(2),
		};
	}
}

function formatTradeResultMessage(
	result: import('../types').TradeResult,
	context: { marketQuestion: string; outcome: 'YES' | 'NO'; action: TradeAction; amountCents: number },
): string {
	const amountDollars = (context.amountCents / 100).toFixed(2);
	const actionLabel = context.action === 'SELL' ? 'Sold' : 'Bought';
	const actionVerb = context.action === 'SELL' ? 'SELL' : 'BUY';
	if (result.ok) {
		const isTxHash = result.tradeId.startsWith('0x');
		const tradeIdLine = isTxHash
			? `• Trade: [${result.tradeId.substring(0, 10)}…${result.tradeId.slice(-6)}](https://polygonscan.com/tx/${result.tradeId})`
			: `• Trade ID: \`${result.tradeId}\``;
		return [
			`✅ **${actionLabel}!**`,
			`• Market: **${context.marketQuestion}**`,
			`• Action: **${actionVerb}**`,
			`• Side: **${context.outcome}**`,
			`• Amount: **$${amountDollars}**`,
			tradeIdLine,
			`• Time: ${new Date(result.executedAtMs).toUTCString()}`,
		].join('\n');
	}

	const errorMessages: Record<string, string> = {
		INVALID_AMOUNT: 'Invalid amount — Polymarket minimum order is $5.',
		INVALID_MARKET: 'Market not found or not tradeable on Polymarket.',
		MARKET_NOT_ACTIVE: 'Market is not currently accepting orders.',
		UPSTREAM_UNAVAILABLE: 'Polymarket API is temporarily unavailable. Try again shortly.',
		RATE_LIMITED: 'Rate limited — please wait a moment and try again.',
		LIMIT_EXCEEDED: 'Daily spending limit exceeded.',
		ABUSE_BLOCKED: 'Trade blocked by risk controls.',
		INTERNAL_ERROR: 'Internal error — please try again.',
	};

	const msg = errorMessages[result.errorCode] ?? `Trade failed: ${result.errorCode}`;
	return `❌ **Trade failed** — ${msg}`;
}

function isDeterministicWriteMessage(message: string): boolean {
	const normalized = message.trim().toLowerCase();
	if (normalized.length === 0) {
		return false;
	}

	const accountScopedPattern = /\b(balance|portfolio|positions?|trade\s+history|history|recent\s+trades?|past\s+\w+\s+trades?|last\s+\w+\s+trades?|connect\s+account|verify|disconnect|status|linked\s+wallet)\b/;
	if (accountScopedPattern.test(normalized)) {
		return true;
	}

	const hasTradeVerb = /\b(bet|place|buy|sell|exit|close|trade|market)\b/.test(normalized);
	const hasAmount = /(\$\s*\d+(?:\.\d{1,2})?)|(\b\d+(?:\.\d{1,2})?\s*(dollars?|usd|bucks?)\b)/.test(normalized);
	return hasTradeVerb && hasAmount;
}

function pickBestNaturalTradeMarket(
	markets: readonly Market[],
	normalizedMessage: string,
	timeframeHint: string,
): Market | null {
	const activeMarkets = markets.filter((market) => market.status === 'active');
	if (activeMarkets.length === 0) {
		return null;
	}

	const wantsBitcoin = /\b(bitcoin|btc)\b/.test(normalizedMessage);
	const wantsEthereum = /\b(ethereum|eth)\b/.test(normalizedMessage);
	const wantsFiveMin = /\b(5|five)\s*(m|min|minute)\b/.test(normalizedMessage);
	const wantsFifteenMin = /\b(15|fifteen)\s*(m|min|minute)\b/.test(normalizedMessage);

	const strictCandidates = activeMarkets.filter((market) => {
		const q = market.question.toLowerCase();
		const hasAsset = wantsBitcoin
			? q.includes('bitcoin') || q.includes('btc')
			: wantsEthereum
				? q.includes('ethereum') || q.includes('eth')
				: true;
		const hasTimedLabel = q.includes('up or down') || q.includes('updown');
		const minutes = extractQuestionMinuteRange(q);
		const timeframeOk = wantsFifteenMin
			? minutes === 15
			: wantsFiveMin
				? minutes === 5
				: true;

		return hasAsset && hasTimedLabel && timeframeOk;
	});

	const pool = strictCandidates.length > 0 ? strictCandidates : activeMarkets;

	const scored = pool.map((market) => {
		const q = market.question.toLowerCase();
		let score = 0;

		if (wantsBitcoin) {
			if (q.includes('bitcoin')) score += 8;
			if (q.includes('btc')) score += 5;
		}
		if (wantsEthereum) {
			if (q.includes('ethereum')) score += 8;
			if (q.includes('eth')) score += 5;
		}

		if (q.includes('up or down')) score += 4;
		if (q.includes('updown')) score += 3;

		const rangeMinutes = extractQuestionMinuteRange(q);
		if (wantsFifteenMin) {
			if (rangeMinutes === 15) score += 6;
			else if (rangeMinutes !== null) score -= 3;
		}
		if (wantsFiveMin) {
			if (rangeMinutes === 5) score += 6;
			else if (rangeMinutes !== null) score -= 3;
		}

		if (timeframeHint && q.includes(timeframeHint.replace(' minute', ''))) {
			score += 2;
		}

		if (q.includes('current')) score += 1;

		return { market, score };
	});

	scored.sort((a, b) => b.score - a.score);
	return scored[0]?.score > 0 ? scored[0].market : pool[0] ?? null;
}

interface TimedMarketResult {
	market: Market;
	slug: string;
}

async function tryResolveTimedUpDownMarket(
	_readService: PolymarketReadService,
	message: string,
): Promise<TimedMarketResult | null> {
	const normalized = message.trim().toLowerCase();

	// --- detect asset ---
	const wantsBitcoin = /\b(bitcoin|btc)\b/.test(normalized);
	const wantsEthereum = /\b(ethereum|eth)\b/.test(normalized);
	const wantsSolana = /\b(solana|sol)\b/.test(normalized);
	const wantsXrp = /\b(xrp|ripple)\b/.test(normalized);

	const assetSlug = wantsBitcoin ? 'btc' : wantsEthereum ? 'eth' : wantsSolana ? 'sol' : wantsXrp ? 'xrp' : null;
	if (!assetSlug) return null;

	// --- detect timeframe ---
	const wantsFifteen = /\b(15|fifteen)\s*(m|min|minute)/i.test(normalized);
	const wantsFive = /\b(5|five)\s*(m|min|minute)/i.test(normalized);
	const wantsOneHour = /\b(1|one)\s*(h|hr|hour)/i.test(normalized) || /\b(60)\s*(m|min)/i.test(normalized);
	const wantsFourHour = /\b(4|four)\s*(h|hr|hour)/i.test(normalized);
	const wantsOneDay = /\b(1|one)\s*(d|day)/i.test(normalized) || /\b(24)\s*(h|hr|hour)/i.test(normalized);

	const timeframeSlug = wantsFifteen ? '15m' : wantsFive ? '5m' : wantsOneHour ? '1h' : wantsFourHour ? '4h' : wantsOneDay ? '1d' : null;
	if (!timeframeSlug) return null;

	const timeframeSeconds: Record<string, number> = { '5m': 300, '15m': 900, '1h': 3600, '4h': 14400, '1d': 86400 };
	const intervalSec = timeframeSeconds[timeframeSlug] ?? 900;

	// Must also mention up/down/bet/market to be a timed trade request
	if (!/\b(up|down|bet|market|buy|sell)\b/.test(normalized)) return null;

	// --- Calculate the current time window slug ---
	// Polymarket timed markets use slugs like btc-updown-15m-TIMESTAMP
	// where TIMESTAMP is the unix epoch of the window start, aligned to the interval
	const nowSec = Math.floor(Date.now() / 1000);
	const windowStart = Math.floor(nowSec / intervalSec) * intervalSec;

	// Try current window first, then previous window (in case current hasn't been created yet)
	const candidates = [windowStart, windowStart - intervalSec];

	for (const startTs of candidates) {
		const slug = `${assetSlug}-updown-${timeframeSlug}-${startTs}`;
		console.log(`[tryResolveTimedUpDownMarket] Trying slug: ${slug}`);

		try {
			const url = `https://gamma-api.polymarket.com/events?slug=${slug}`;
			const resp = await fetch(url);
			if (!resp.ok) continue;

			const events: GammaEventResponse[] = await resp.json() as GammaEventResponse[];
			if (events.length === 0) continue;

			const event = events[0];
			const eventMarket = event.markets?.[0];
			if (!eventMarket) continue;

			// Skip if market is already closed
			if (eventMarket.closed) {
				console.log(`[tryResolveTimedUpDownMarket] ${slug} is closed, skipping`);
				continue;
			}

			console.log(`[tryResolveTimedUpDownMarket] Found: ${event.title} (slug: ${event.slug})`);

			const outcomes = safeParse<string[]>(eventMarket.outcomes, ['YES', 'NO']).map((o: string) => o.toUpperCase()) as Market['outcomes'];
			const outcomePrices = safeParse<string[]>(eventMarket.outcomePrices, []).map((p: string) => parseFloat(p) || 0);

			return {
				market: {
					id: (eventMarket.conditionId ?? eventMarket.id) as MarketId,
					question: eventMarket.question ?? event.title,
					status: eventMarket.closed ? 'closed' : eventMarket.active === false ? 'paused' : 'active',
					outcomes,
					outcomePrices,
					volume: typeof eventMarket.volume === 'number' ? eventMarket.volume : parseFloat(String(eventMarket.volume ?? '0')) || 0,
				},
				slug: event.slug,
			};
		} catch (err) {
			console.error(`[tryResolveTimedUpDownMarket] Error fetching ${slug}:`, err);
		}
	}

	// Fallback: fetch recent open events with matching prefix
	console.log(`[tryResolveTimedUpDownMarket] Calculated slugs failed, falling back to prefix search`);
	const slugPrefix = `${assetSlug}-updown-${timeframeSlug}`;
	try {
		const url = `https://gamma-api.polymarket.com/events?closed=false&active=true&order=id&ascending=false&limit=50`;
		const resp = await fetch(url);
		if (!resp.ok) return null;

		const events: GammaEventResponse[] = await resp.json() as GammaEventResponse[];
		const matching = events.filter((e) => e.slug?.startsWith(slugPrefix));

		if (matching.length === 0) return null;

		// Pick the event whose slug timestamp is closest to now (prefer current/past over far future)
		matching.sort((a, b) => {
			const tsA = parseInt(a.slug.split('-').pop() ?? '0');
			const tsB = parseInt(b.slug.split('-').pop() ?? '0');
			return Math.abs(tsA - nowSec) - Math.abs(tsB - nowSec);
		});

		const bestEvent = matching[0];
		const eventMarket = bestEvent.markets?.[0];
		if (!eventMarket) return null;

		console.log(`[tryResolveTimedUpDownMarket] Fallback selected: ${bestEvent.title} (slug: ${bestEvent.slug})`);

		const outcomes = safeParse<string[]>(eventMarket.outcomes, ['YES', 'NO']).map((o: string) => o.toUpperCase()) as Market['outcomes'];
		const outcomePrices = safeParse<string[]>(eventMarket.outcomePrices, []).map((p: string) => parseFloat(p) || 0);

		return {
			market: {
				id: (eventMarket.conditionId ?? eventMarket.id) as MarketId,
				question: eventMarket.question ?? bestEvent.title,
				status: eventMarket.closed ? 'closed' : eventMarket.active === false ? 'paused' : 'active',
				outcomes,
				outcomePrices,
				volume: typeof eventMarket.volume === 'number' ? eventMarket.volume : parseFloat(String(eventMarket.volume ?? '0')) || 0,
			},
			slug: bestEvent.slug,
		};
	} catch (err) {
		console.error('[tryResolveTimedUpDownMarket] Fallback error:', err);
		return null;
	}
}

/** Gamma event response shape (minimal) */
interface GammaEventResponse {
	id: string;
	title: string;
	slug: string;
	closed: boolean;
	active: boolean;
	markets?: GammaEventMarket[];
}

interface GammaEventMarket {
	id: string;
	conditionId?: string;
	question?: string;
	outcomes?: string;
	outcomePrices?: string;
	volume?: number | string;
	active?: boolean;
	closed?: boolean;
}

function safeParse<T>(value: string | T | undefined, fallback: T): T {
	if (value === undefined || value === null) return fallback;
	if (typeof value !== 'string') return value;
	try { return JSON.parse(value) as T; } catch { return fallback; }
}

function extractQuestionMinuteRange(question: string): number | null {
	const match = question.match(/(\d{1,2}):(\d{2})(am|pm)\s*-\s*(\d{1,2}):(\d{2})(am|pm)/i);
	if (!match) {
		return null;
	}

	const start = toMinuteOfDay(Number(match[1]), Number(match[2]), match[3].toUpperCase());
	const end = toMinuteOfDay(Number(match[4]), Number(match[5]), match[6].toUpperCase());
	if (start === null || end === null) {
		return null;
	}

	let diff = end - start;
	if (diff < 0) {
		diff += 24 * 60;
	}
	return diff;
}

function toMinuteOfDay(hourRaw: number, minute: number, ampm: string): number | null {
	if (!Number.isFinite(hourRaw) || !Number.isFinite(minute)) {
		return null;
	}
	if (hourRaw < 1 || hourRaw > 12 || minute < 0 || minute > 59) {
		return null;
	}

	let hour = hourRaw % 12;
	if (ampm === 'PM') {
		hour += 12;
	}

	return hour * 60 + minute;
}

interface PolymarketActivityRow {
	readonly timestamp?: number;
	readonly type?: string;
	readonly usdcSize?: number;
	readonly size?: number;
	readonly price?: number;
	readonly title?: string;
	readonly slug?: string;
	readonly conditionId?: string;
	readonly outcome?: string;
	readonly side?: string;
}

async function fetchPolymarketActivity(accountId: string, limit: number): Promise<readonly PolymarketActivityRow[]> {
	const safeLimit = Math.max(1, Math.min(20, Math.floor(limit || 5)));
	try {
		const response = await fetch(
			`https://data-api.polymarket.com/activity?user=${encodeURIComponent(accountId)}&limit=${safeLimit}`,
		);
		if (!response.ok) {
			return [];
		}

		const rows = (await response.json()) as unknown;
		if (!Array.isArray(rows)) {
			return [];
		}

		return rows as PolymarketActivityRow[];
	} catch {
		return [];
	}
}

function formatActivityLine(activity: PolymarketActivityRow, index: number): string {
	const type = (activity.type || activity.side || 'TRADE').toUpperCase();
	const amount =
		type === 'BUY' || type === 'SELL'
			? (Number(activity.size ?? 0) * Number(activity.price ?? 0))
			: Number(activity.usdcSize ?? activity.size ?? 0);
	const safeAmount = Number.isFinite(amount) ? amount : 0;
	const title =
		(activity.title && activity.title.trim().length > 0 && activity.title.trim())
		|| (activity.slug && activity.slug.trim().length > 0 && activity.slug.trim())
		|| (activity.conditionId ? activity.conditionId.slice(0, 18) : 'Unknown market');
	const side = activity.outcome ? ` (${activity.outcome})` : '';
	const date = activity.timestamp
		? new Date(activity.timestamp * 1000).toUTCString()
		: 'Unknown time';

	return `${index + 1}. **${type}${side}** $${safeAmount.toFixed(2)} — ${title} — ${date}`;
}

/**
 * Default READ-mode explainer stub.
 * This is intentionally a placeholder for a dedicated read-only AI explainer.
 */
async function defaultReadExplainer(input: ReadExplainerInput): Promise<string> {
	void input.message;
	return `I found ${input.liveMarketCount} live markets and ${input.searchResultsCount} matching results.`;
}

/**
 * Produces up to three factual summaries for READ responses.
 * For sports/esports events, prioritizes outright winner markets over prop/handicap markets.
 */
async function summarizeUpToThree(
	readService: PolymarketReadService,
	markets: readonly { id: MarketSummary['id'] }[],
	query?: string
): Promise<readonly MarketSummary[]> {
	// Get all market summaries
	const allSummaries = await Promise.all(
		markets.slice(0, 15).map((market) => readService.summarizeMarket(market.id)),
	);
	const validSummaries = allSummaries.filter((summary): summary is MarketSummary => summary !== null);

	// 1. Exact/strong match (active) always first
	let bestActive: MarketSummary | undefined;
	if (query) {
		const q = query.toLowerCase();
		bestActive = validSummaries.find(
			m => m.status === 'active' && m.question.toLowerCase().includes(q)
		);
	}
	if (!bestActive) {
		bestActive = validSummaries.find(m => m.status === 'active');
	}

	// 2. Fill with other active, then closed, but never duplicate
	const rest = validSummaries
		.filter(m => m !== bestActive)
		.sort((a, b) => {
			if (a.status === 'active' && b.status !== 'active') return -1;
			if (a.status !== 'active' && b.status === 'active') return 1;
			const aIsProp = isPropMarket(a.question);
			const bIsProp = isPropMarket(b.question);
			if (aIsProp !== bIsProp) return aIsProp ? 1 : -1;
			return 0;
		});

	const result = bestActive ? [bestActive, ...rest] : rest;
	return result.slice(0, 3);
}

/**
 * Returns true if a market question appears to be a prop/sub-market
 * rather than an outright winner market.
 */
function isPropMarket(question: string): boolean {
	const lower = question.toLowerCase();
	const propIndicators = [
		'game 1', 'game 2', 'game 3', 'game 4', 'game 5',
		'handicap', 'spread', 'total', 'o/u', 'over/under',
		'first blood', 'first to', 'kill handicap',
		'map 1', 'map 2', 'map 3',
	];
	return propIndicators.some(indicator => lower.includes(indicator));
}

/**
 * Validation errors are mapped to user-safe language at the orchestration boundary.
 * Internal error codes are not exposed directly to Discord users.
 */
function mapValidationErrorToUserMessage(errorCode: ValidationErrorCode): string {
	switch (errorCode) {
		case 'ACCOUNT_NOT_CONNECTED':
			return 'Trading is not available right now. Please contact an admin.';
		case 'INVALID_MARKET':
			return 'That market could not be found. Please check the market and try again.';
		case 'MARKET_NOT_ACTIVE':
			return 'That market is not currently active for trading.';
		case 'INVALID_AMOUNT':
			return 'The trade amount is invalid. Please provide a positive whole-number amount in cents.';
		case 'LIMIT_EXCEEDED':
			return 'This trade exceeds your current spending limit window.';
		default:
			return assertNever(errorCode);
	}
}

function assertNever(value: never): never {
	throw new Error(`Unhandled case: ${String(value)}`);
}
