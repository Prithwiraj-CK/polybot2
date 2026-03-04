import { callAI as callGemini, hasAIKeys as hasGeminiKeys, sanitize } from './aiClient';
import type { ReadExplainerInput } from '../discord/DiscordMessageRouter';

/**
 * System prompt for the READ-mode AI assistant.
 */
const READ_SYSTEM_PROMPT = [
	'You are a helpful Polymarket assistant inside a Discord server.',
	'You answer user questions about prediction markets, odds, market status, and general Polymarket concepts.',
	'You are given factual market data as context — use it when relevant.',
	'Be concise, accurate, and conversational. Keep responses under 300 words.',
	'You have NO ability to execute trades, access wallets, or modify anything.',
	'If the user asks you to place a trade or wants to bet, tell them the command format:',
	'  • \"bet $[amount] on [market name] [outcome]\" — where outcome is the market\'s actual label (e.g. YES/NO, UP/DOWN, OKC/NYK, Thunder/Knicks).',
	'IMPORTANT: For sports matchups, the outcomes are the team names or abbreviations, NOT yes/no. Show the actual team names from the market data as the outcome options.',
	'Never fabricate market data.',
	'IMPORTANT: For sports/esports queries (teams, players, matches), the search returns the top active markets from that league or sport.',
	'RULE: If sample markets are provided (even just 1), you MUST present them clearly as what is available. NEVER say "could not find" or "could not find" when markets are shown - that is confusing and wrong.',
	'RULE: Only say you could not find a market if search matches = 0 AND no sample markets are listed at all.',
	'If the found market question uses different phrasing or abbreviations than the user query (e.g. user says "G2 Ares vs WW Team" but market says "Will G2 win on 2026-03-03"), present the market anyway - it is the closest Polymarket has for that matchup.',
	'Do NOT fabricate results or show random unrelated markets when there are no search matches.',
	'Format responses for Discord (markdown is OK, no HTML).',
	'IMPORTANT: Whenever you include any links in your response, surround them with angle brackets like <https://example.com> to suppress Discord embeds.',
	'Do NOT include any Olympus or Polymarket links in your response — they are appended automatically after your answer.',
].join(' ');

/**
 * Creates an AI-powered read explainer using OpenAI (primary) with Gemini fallback.
 * No backend, no database, no auth required.
 */
export function createAiReadExplainer(): (input: ReadExplainerInput) => Promise<string> {
	return async (input: ReadExplainerInput): Promise<string> => {
		if (!hasGeminiKeys()) {
			return fallbackExplainer(input);
		}

		const contextBlock = buildMarketContext(input);
		const fullPrompt = READ_SYSTEM_PROMPT + '\n\nCurrent market context:\n' + contextBlock;

		const text = await callGemini({
			contents: sanitize(input.message, 500),
			systemInstruction: fullPrompt,
			temperature: 0.4,
			maxOutputTokens: 500,
		});

		if (!text) {
			return fallbackExplainer(input);
		}

		// Append Olympus links deterministically — don't rely on AI to include them
		const olympusLinks = buildOlympusLinks(input);
		return olympusLinks ? `${text}\n\n${olympusLinks}` : text;
	};
}

/**
 * Builds a compact market-context string for the system prompt.
 * Keeps token usage low while giving the model enough to be useful.
 */
function buildMarketContext(input: ReadExplainerInput): string {
	const lines: string[] = [];

	lines.push(`Live markets: ${input.liveMarketCount}`);
	lines.push(`Search matches for user query: ${input.searchResultsCount}`);

	if (input.sampleMarketSummaries.length > 0) {
		lines.push('');
		lines.push('Sample markets:');
		for (const summary of input.sampleMarketSummaries) {
			const priceInfo = summary.outcomes.map((o, i) => `${o}: ${Math.round((summary.outcomePrices[i] ?? 0) * 100)}%`).join(', ');
			const vol = summary.volume >= 1_000_000 ? `$${(summary.volume / 1_000_000).toFixed(1)}M` : summary.volume >= 1_000 ? `$${(summary.volume / 1_000).toFixed(0)}K` : `$${Math.round(summary.volume)}`;
			const olympusLink = '';
			lines.push(`- [${summary.status}] "${summary.question}" (${priceInfo}) vol=${vol}${olympusLink}`);
		}
	}

	return lines.join('\n');
}

/**
 * Graceful fallback when Gemini is unavailable or rate-limited.
 * Returns basic factual data without AI generation.
 */
function fallbackExplainer(input: ReadExplainerInput): string {
	const parts: string[] = [];

	parts.push(`I found **${input.liveMarketCount}** live markets`);
	if (input.searchResultsCount > 0) {
		parts.push(` and **${input.searchResultsCount}** matching your query`);
	}
	parts.push('.');

	if (input.sampleMarketSummaries.length > 0) {
		parts.push('\n\nHere are some markets:');
		for (const summary of input.sampleMarketSummaries) {
			const priceInfo = summary.outcomes.map((o, i) => {
				const pct = Math.round((summary.outcomePrices[i] ?? 0) * 100);
				return `${o}: ${pct}%`;
			}).join(' / ');
			const vol = summary.volume >= 1_000_000 ? `$${(summary.volume / 1_000_000).toFixed(1)}M` : summary.volume >= 1_000 ? `$${(summary.volume / 1_000).toFixed(0)}K` : `$${Math.round(summary.volume)}`;
			parts.push(`\n• **${summary.question}** — ${priceInfo} (Vol: ${vol})`);
		}
	}

	// Append Olympus links deterministically
	const olympusLinks = buildOlympusLinks(input);
	if (olympusLinks) {
		parts.push(`\n\n${olympusLinks}`);
	}

	return parts.join('');
}

/**
 * Builds Olympus links block appended after AI or fallback responses.
 * Guarantees links are always present regardless of AI token limits.
 */
function buildOlympusLinks(input: ReadExplainerInput): string {
	const links: string[] = [];
	for (const summary of input.sampleMarketSummaries) {
		// Prefer the parent event slug (e.g. lol-jdg-blg-2026-03-04) — that is the
		// correct Olympus URL path. The market-level slug is an internal Gamma ID
		// that does not match the Olympus/Polymarket URL.
		const linkSlug = summary.eventSlug ?? summary.slug;
		if (linkSlug) {
			// Use angle brackets to suppress Discord embeds
			links.push(`<https://olympusx.app/app/market/${linkSlug}>`);
		}
	}
	return links.length > 0 ? `View on Olympus:\n${links.join('\n')}` : '';
}
