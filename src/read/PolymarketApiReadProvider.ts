import type { PolymarketReadProvider } from './PolymarketReadService';
import type { Market, MarketId, Outcome } from '../types';
import { callGemini, hasGeminiKeys } from './geminiClient';

/**
 * Base URL for the Polymarket Gamma API (market metadata).
 * This is the public, unauthenticated endpoint for reading market data.
 */
const GAMMA_API_BASE = 'https://gamma-api.polymarket.com';

/**
 * Maximum number of markets to fetch per list/search request.
 */
const DEFAULT_PAGE_LIMIT = 50;
const SEARCH_PAGE_LIMIT = 200;
const MAX_SEARCH_PAGES = 25; // safety cap to avoid unbounded requests

/**
 * Sports metadata cache — the /sports list rarely changes.
 */
interface SportEntry {
	readonly id: number;
	readonly sport: string;
	readonly tags: string; // comma-separated tag IDs, e.g. "1,64,65,100639"
	readonly series: string;
}

let sportsCache: SportEntry[] | null = null;
let sportsCacheExpiresAt = 0;
const SPORTS_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Aliases that map common user terms to Gamma API sport codes.
 * The /sports endpoint uses short codes (e.g. "lol", "nba", "cs2").
 */
const SPORT_ALIASES: Record<string, string[]> = {
	// Esports
	lol: ['league of legends', 'lol', 'lck', 'lpl', 'lec', 'lcs', 'worlds', 'msi',
		// LCK teams
		'kt rolster', 'kt', 'ktc', 'drx', 'drxc', 't1', 'gen.g', 'geng', 'gen g',
		'hanwha', 'hle', 'dplus', 'dk', 'dplus kia', 'bnk', 'fearx', 'bnk fearx',
		'brion', 'bro', 'freecs', 'dnf', 'nongshim', 'ns', 'ns redforce', 'redforce',
		// LPL teams
		'jdg', 'jd gaming', 'blg', 'bilibili', 'weibo', 'wbg', 'al', "anyone's legend",
		'anyones legend', 'tes', 'top esports', 'we', 'team we', 'ig', 'invictus',
		'nip', 'ninjas in pyjamas', 'ra', 'royal academy', 'lng', 'edg', 'rng',
		'fpx', 'funplus', 'jdg', 'omg', 'nv', 'team nv',
		// LCP teams
		'cfo', 'ctbc', 'flying oyster', 'tsw', 'team secret whales', 'dcg', 'deep cross',
		'gz', 'ground zero', 'shg', 'softbank hawks',
		// LCS/LEC/other
		'c9', 'cloud9', 'tl', 'team liquid', 'fly', 'flyquest', '100t', '100 thieves',
		'eg', 'evil geniuses', 'nrg', 'lyon', 'giantx', 'karmine', 'fnatic', 'g2'],
	cs2: ['counter strike', 'counter-strike', 'cs2', 'csgo', 'cs go', 'cs:go', 'hltv',
		'navi', 'faze', 'vitality', 'g2 esports', 'astralis', 'cloud9', 'mouz', 'spirit',
		'heroic', 'ence', 'liquid', 'complexity', 'fnatic', 'big', 'nip', 'virtus.pro'],
	dota2: ['dota', 'dota2', 'dota 2', 'the international',
		// Major Dota 2 teams
		'tundra', 'tundra esports', 'betboom', 'og', 'team spirit', 'spirit',
		'gaimin', 'gaimin gladiators', 'entity', 'beastcoast', 'nine pandas',
		'talon esports', 'talon', 'shopify rebellion', 'shopify', 'azure ray',
		'xtreme gaming', 'lgd', 'psg lgd', 'ehome', 'vici', 'vici gaming',
		'newbee', 'alliance', 'boom esports', 'boom', 'blacklist', 'execration',
		'1win', 'yakutou', 'team yandex', 'soniqs', 'wildcard', 'hokori',
		'virtus.pro', 'natus vincere', 'navi'],
	val: ['valorant', 'vct', 'val', 'sentinels', 'loud', 'paper rex', 'prx', 'nrg',
		'team heretics', 'heretics', 'leviatán', 'mibr', 'bleed', 'trace', 'optic'],
	mlbb: ['mobile legends', 'mlbb'],
	ow: ['overwatch', 'overwatch 2', 'ow2'],
	codmw: ['call of duty', 'cod', 'warzone'],
	rl: ['rocket league'],
	sc2: ['starcraft', 'starcraft 2', 'sc2'],
	pubg: ['pubg', 'playerunknown'],
	// Traditional sports
	nba: ['nba', 'basketball', 'lakers', 'celtics', 'warriors', 'bucks', 'nets', 'knicks'],
	nfl: ['nfl', 'football', 'super bowl', 'superbowl', 'patriots', 'chiefs', 'eagles'],
	mlb: ['mlb', 'baseball', 'world series', 'yankees', 'dodgers', 'mets'],
	nhl: ['nhl', 'hockey', 'stanley cup'],
	epl: ['premier league', 'epl', 'manchester united', 'arsenal', 'chelsea', 'liverpool', 'man city', 'tottenham'],
	lal: ['la liga', 'laliga', 'barcelona', 'real madrid', 'atletico madrid'],
	bun: ['bundesliga', 'bayern', 'bayern munich', 'dortmund', 'borussia'],
	sea: ['serie a', 'seria a', 'juventus', 'inter milan', 'ac milan', 'napoli', 'roma'],
	ucl: ['champions league', 'ucl', 'uefa champions'],
	uel: ['europa league', 'uel'],
	mls: ['mls', 'major league soccer'],
	ipl: ['ipl', 'indian premier league', 'cricket'],
	ufc: ['ufc', 'mma', 'mixed martial arts', 'ultimate fighting'],
	atp: ['atp', 'tennis', 'djokovic', 'nadal', 'federer', 'alcaraz', 'sinner'],
	wta: ['wta', 'women tennis'],
	ncaab: ['march madness', 'ncaa basketball', 'ncaab', 'college basketball'],
	cfb: ['college football', 'cfb', 'ncaa football'],
	kbo: ['kbo', 'korean baseball'],
};

/**
 * Extra tag labels to search as fallbacks (lowercase).
 * These are used to search events by tag name when sport detection matches.
 */
const ESPORTS_TAG_LABELS = ['esports', 'lol', 'league of legends', 'cs2', 'dota2', 'valorant'];

/**
 * Raw market shape returned by the Gamma API.
 * Only the fields we actually use are typed here; the real payload has many more.
 */

interface GammaMarketResponse {
	readonly id?: string;
	readonly condition_id?: string;
	readonly question?: string;
	readonly title?: string; // events payload may use title
	readonly slug?: string; // URL-friendly slug for constructing Polymarket/Olympus links
	readonly active?: boolean;
	readonly closed?: boolean;
	readonly outcomes?: string | string[]; // Gamma markets use JSON string; events may send string[]
	readonly outcomePrices?: string | string[]; // JSON string or array of price strings
	readonly volume?: string | number;
	readonly accepting_orders?: boolean;
	readonly events?: ReadonlyArray<{ readonly slug?: string }>; // parent event(s) — slug used for Polymarket event URLs
}

/**
 * PolymarketReadProvider backed by the public Polymarket Gamma API.
 *
 * This provider is read-only and requires NO authentication.
 * It can power the full READ pipeline (AI assistant mode) without any backend.
 */
export class PolymarketApiReadProvider implements PolymarketReadProvider {
	/**
	 * Fetches ALL active markets from the Gamma API via pagination.
	 */
	public async listMarkets(): Promise<readonly Market[]> {
		const baseUrl = `${GAMMA_API_BASE}/markets?closed=false`;
		const all = await this.fetchAllMarkets(baseUrl);
		console.log(`[listMarkets] Fetched ${all.length} active markets`);
		return all;
	}

	/**
	 * Fetches a single market by its condition ID / slug.
	 */
	public async getMarket(marketId: MarketId): Promise<Market | null> {
		try {
			const url = `${GAMMA_API_BASE}/markets/${encodeURIComponent(marketId)}`;
			const response = await fetch(url);

			if (!response.ok) {
				return null;
			}

			const raw = (await response.json()) as GammaMarketResponse;
			return mapGammaMarketToMarket(raw);
		} catch {
			return null;
		}
	}

	/**
	 * Searches markets by text using the Gamma API's slug/text filtering.
	 */
	public async searchMarkets(query: string): Promise<readonly Market[]> {
		const normalized = query.trim();
		if (normalized.length === 0) {
			return this.listMarkets();
		}

		console.log(`[search] Raw query: "${normalized}"`);

		// Use AI to extract search keywords from conversational queries
		const searchTerms = await extractSearchKeywords(normalized);
		console.log(`[search] AI-extracted keywords: "${searchTerms}"`);

		// Try events endpoint with multiple slug candidates
		let eventMarkets: Market[] = [];
		const eventSlugCandidates = buildEventSlugCandidates(searchTerms);
		console.log(`[search] Event slug candidates:`, eventSlugCandidates.slice(0, 5));
		const eventScopes = ['closed=false', 'closed=true'];
		for (const scope of eventScopes) {
			if (eventMarkets.length > 0) break;
			for (const slug of eventSlugCandidates) {
				try {
					const eventUrl = `${GAMMA_API_BASE}/events?${scope}&limit=1&slug=${encodeURIComponent(slug)}`;
					const eventResp = await fetch(eventUrl);
					if (eventResp.ok) {
						const events = await eventResp.json();
						if (Array.isArray(events) && events.length > 0 && Array.isArray(events[0].markets)) {
							console.log(`[search] Event hit! slug="${slug}" title="${events[0].title}" markets=${events[0].markets.length}`);
							eventMarkets = events[0].markets
								.map(mapGammaMarketToMarket)
								.filter((m: Market | null): m is Market => m !== null);
							if (eventMarkets.length > 0) {
								break;
							}
						}
					}
				} catch {
					// best-effort; ignore and try next slug
				}
			}
		}

		// If event search found results, return them directly.
		// When an event has many markets (e.g. 128 candidates in "2028 Democratic Nominee"),
		// score each market by how many query keywords appear in its question so that
		// the specific entity the user asked about (e.g. "Gavin Newsom") floats to the top.
		if (eventMarkets.length > 0) {
			// Build a keyword set from the searchTerms for relevance scoring.
			// Use the same stopwords as the series search to avoid matching noise.
			// Only strip true conversational/structural noise — do NOT stop-word
			// political terms or years, since those may distinguish events.
			// Names like "Gavin Newsom", "Bernie Sanders" must pass through intact.
			const SCORE_STOPWORDS = new Set([
				'the', 'a', 'an', 'of', 'for', 'in', 'on', 'at', 'to', 'is', 'are', 'be',
				'will', 'who', 'what', 'how', 'which', 'and', 'or', 'vs', 'versus',
				'market', 'odds', 'about', 'show', 'tell', 'me', 'please', 'check',
				'hi', 'hey', 'can', 'you', 'give', 'find', 'get', 'status', 'update',
			]);
			const scoreKeywords = searchTerms
				.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/)
				.filter(w => w.length >= 2 && !SCORE_STOPWORDS.has(w));

			const scoreMarket = (m: Market): number => {
				if (scoreKeywords.length === 0) return 0;
				const q = m.question.toLowerCase();
				return scoreKeywords.filter(kw => q.includes(kw)).length;
			};

			eventMarkets.sort((a, b) => {
				// Primary: status (active first)
				const rankStatus = (s: Market['status']): number => s === 'active' ? 0 : s === 'paused' ? 1 : 2;
				const statusDiff = rankStatus(a.status) - rankStatus(b.status);
				if (statusDiff !== 0) return statusDiff;
				// Secondary: keyword relevance score (higher = better match)
				return scoreMarket(b) - scoreMarket(a);
			});

			const activeCount = eventMarkets.filter(m => m.status === 'active').length;
			console.log(`[search] Event results: ${eventMarkets.length} total, ${activeCount} active. Top market: "${eventMarkets[0]?.question}"`);
			return eventMarkets;
		}

		// Sports-aware search: detect if the query matches a known sport/esports category
		// and search events by series_id with keyword matching.
		console.log(`[search] Attempting sports-aware search for: "${searchTerms}"`);
		const sportsResults = await this.searchSportsMarkets(searchTerms);
		if (sportsResults.length > 0) {
			console.log(`[search] Sports search found ${sportsResults.length} markets, returning as primary results`);
			return sportsResults;
		}

		// Fallback: try slug, tag, and text_query searches (limited to 1 page each)
		const searchSlug = searchTerms.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
		let slugResults: Market[] = [];
		let tagResults: Market[] = [];
		let textResults: Market[] = [];
		for (const scope of ['closed=false', 'closed=true']) {
			const slugUrl = `${GAMMA_API_BASE}/markets?${scope}&limit=${DEFAULT_PAGE_LIMIT}&slug=${encodeURIComponent(searchSlug)}`;
			slugResults = slugResults.concat(await this.fetchAndMapMarkets(slugUrl));

			const tagUrl = `${GAMMA_API_BASE}/markets?${scope}&limit=${DEFAULT_PAGE_LIMIT}&tag=${encodeURIComponent(searchTerms)}`;
			tagResults = tagResults.concat(await this.fetchAndMapMarkets(tagUrl));

			const textUrl = `${GAMMA_API_BASE}/markets?${scope}&limit=${DEFAULT_PAGE_LIMIT}&text_query=${encodeURIComponent(searchTerms)}`;
			textResults = textResults.concat(await this.fetchAndMapMarkets(textUrl));
		}

		// Merge and deduplicate by market id — use Map to preserve insertion order
		const deduped = new Map<string, Market>();
		for (const m of [...slugResults, ...tagResults, ...textResults]) {
			if (!deduped.has(m.id)) {
				deduped.set(m.id, m);
			}
		}
		const results = [...deduped.values()];
		console.log(`[search] Results: slug=${slugResults.length} tag=${tagResults.length} text=${textResults.length} total=${results.length}`);
		return results;
	}

	/**
	 * Shared fetch + parse logic for list/search endpoints.
	 */
	private async fetchAndMapMarkets(url: string): Promise<readonly Market[]> {
		try {
			const response = await fetch(url);

			if (!response.ok) {
				return [];
			}

			const raw = (await response.json()) as GammaMarketResponse[] | GammaMarketResponse;

			// API may return a single object or an array
			const items = Array.isArray(raw) ? raw : [raw];
			const mapped = items.map(mapGammaMarketToMarket).filter((m): m is Market => m !== null);
			return mapped;
		} catch {
			return [];
		}
	}

	/**
	 * Paginates through markets using limit/offset until exhausted or capped.
	 */
	private async fetchAllMarkets(urlBase: string): Promise<Market[]> {
		const results: Market[] = [];
		for (let page = 0; page < MAX_SEARCH_PAGES; page++) {
			const offset = page * SEARCH_PAGE_LIMIT;
			const url = `${urlBase}&limit=${SEARCH_PAGE_LIMIT}&offset=${offset}`;
			const pageResults = await this.fetchAndMapMarkets(url);
			if (pageResults.length === 0) {
				break;
			}
			results.push(...pageResults);
			if (pageResults.length < SEARCH_PAGE_LIMIT) {
				break;
			}
		}
		return results;
	}

	/**
	 * Searches the Gamma events endpoint directly by text query.
	 * This catches specific matchup queries like "KTC vs DRXC" that have no
	 * matching slug but ARE findable via the events text search index.
	 */
	/**
	 * Sports-aware search: detects sport/esports categories from the query,
	 * then tries two strategies:
	 *
	 * 1. Series-specific search — paginates the sport's series_id events and
	 *    matches event slugs/titles against the query keywords. This catches
	 *    specific matchup queries like "KTC vs DRXC" that sit below the
	 *    top-volume events returned by tag-based searches.
	 *
	 * 2. Tag-based search — returns the top active events for that sport
	 *    (used when the user asks a general question like "show me lol markets").
	 */
	private async searchSportsMarkets(query: string): Promise<Market[]> {
		const detectedSports = detectSportsFromQuery(query);
		const lowerQuery = query.toLowerCase();
		const isVsQuery = lowerQuery.includes(' vs ') || lowerQuery.includes(' versus ');

		// If no sport detected but query has "X vs Y", still try all esport series —
		// this handles unknown teams without needing to maintain a complete alias list.
		if (detectedSports.length === 0 && !isVsQuery) {
			return [];
		}

		if (detectedSports.length > 0) {
			console.log(`[search] Sports detected from query: ${detectedSports.join(', ')}`);
		} else {
			console.log('[search] No sport detected — vs-query, will try all esport series');
		}

		// Fetch sports metadata (cached)
		const sportsMeta = await fetchSportsMetadata();
		if (sportsMeta.length === 0) {
			console.log('[search] Failed to fetch sports metadata, skipping sports search');
			return [];
		}

		// When a specific sport was detected, search only that sport's series.
		// When no sport detected (unknown teams in a vs-query), search ALL esport series
		// so any team name works without needing to maintain a complete alias list.
		const ESPORT_CODES = ['lol', 'cs2', 'dota2', 'val', 'mlbb', 'ow', 'codmw', 'rl', 'sc2', 'pubg', 'csa', 'lcs'];
		const sportsToSearch = detectedSports.length > 0 ? detectedSports : ESPORT_CODES;

		// --- Strategy 1: Series-specific search ---
		// Extract meaningful keywords from the query (abbreviations, team names, etc.)
		// Slugs use these abbreviations (e.g. "ktc", "drxc"), so matching against
		// the event slug is far more reliable than matching against the full title.
		const STOPWORDS = new Set([
			// conversational words
			'the', 'can', 'you', 'about', 'check', 'market', 'what', 'this', 'that', 'going',
			'hi', 'hello', 'show', 'tell', 'find', 'get', 'me', 'please', 'will', 'win',
			'who', 'which', 'how', 'is', 'are', 'and', 'or', 'for', 'in', 'of', 'a', 'an',
			'vs', 'versus', 'status', 'live', 'current', 'update', 'updates', 'score', 'now', 'rn',
			'do', 'does', 'did', 'has', 'have', 'been', 'would', 'should', 'could', 'any',
			'today', 'tonight', 'right', 'currently', 'latest', 'looking', 'see',
			// sport/league words
			'lol', 'lck', 'lpl', 'lec', 'lcs', 'nba', 'nfl', 'mlb', 'nhl', 'cs2', 'val',
			'esports', 'sports', 'season', 'match', 'game', 'series', 'playoffs', 'league',
			'cup', 'tournament', 'kickoff', 'regular', 'bo3', 'bo5', 'bo1', 'bo2',
		]);
		const queryKeywords = lowerQuery
			.replace(/[^a-z0-9\s]/g, ' ')
			.split(/\s+/)
			.filter(w => w.length >= 2 && !STOPWORDS.has(w));

		console.log(`[search] Series search keywords: ${queryKeywords.join(', ')}`);

		if (queryKeywords.length > 0) {
			const seriesDeduped = new Map<string, Market>();
			const seriesMarkets: Market[] = [];

			for (const sportCode of sportsToSearch) {
				const entry = sportsMeta.find(s => s.sport === sportCode);
				if (!entry?.series) continue;

				const seriesIds = entry.series.split(',').map(s => s.trim()).filter(Boolean);
				for (const seriesId of seriesIds.slice(0, 2)) { // max 2 series per sport
					// Paginate up to 3 pages (60 events) looking for keyword matches
					for (let offset = 0; offset <= 40; offset += 20) {
						try {
							const url = `${GAMMA_API_BASE}/events?series_id=${seriesId}&closed=false&limit=20&offset=${offset}`;
							const resp = await fetch(url);
							if (!resp.ok) break;

							const events = await resp.json() as Array<{
								title?: string;
								slug?: string;
								markets?: GammaMarketResponse[];
							}>;
							if (!Array.isArray(events) || events.length === 0) break;

							for (const event of events) {
								if (!Array.isArray(event.markets)) continue;

								// Match against the event SLUG (uses abbreviations like "ktc", "drxc")
								// OR fall back to matching the title.
								// REQUIRE ALL keywords to match (not just any one) to avoid returning
								// hundreds of irrelevant events when query contains common words.
								const eventSlug = (event.slug ?? '').toLowerCase();
								const eventTitle = (event.title ?? '').toLowerCase();
								const haystack = eventSlug + ' ' + eventTitle;
								const matchCount = queryKeywords.filter(kw => haystack.includes(kw)).length;
								const isMatch = matchCount === queryKeywords.length; // ALL keywords must match
								if (!isMatch) continue;

								console.log(`[search] Series hit: "${event.title}" (slug=${event.slug})`);
								for (const raw of event.markets) {
									const m = mapGammaMarketToMarket(raw);
									if (m && !seriesDeduped.has(m.id)) {
										seriesDeduped.set(m.id, m);
										seriesMarkets.push(m);
									}
								}
							}

							if (events.length < 20) break; // last page
						} catch {
							break;
						}
					}
				}

				// Also check recent closed events in case the match just ended
				if (seriesMarkets.length === 0) {
					for (const seriesId of seriesIds.slice(0, 1)) {
						for (let offset = 0; offset <= 20; offset += 20) {
							try {
								const url = `${GAMMA_API_BASE}/events?series_id=${seriesId}&closed=true&limit=20&offset=${offset}`;
								const resp = await fetch(url);
								if (!resp.ok) break;

								const events = await resp.json() as Array<{
									title?: string;
									slug?: string;
									markets?: GammaMarketResponse[];
								}>;
								if (!Array.isArray(events) || events.length === 0) break;

								for (const event of events) {
									if (!Array.isArray(event.markets)) continue;
									const eventSlug = (event.slug ?? '').toLowerCase();
									const eventTitle = (event.title ?? '').toLowerCase();
									const haystack = eventSlug + ' ' + eventTitle;
									const isMatch = queryKeywords.some(kw => haystack.includes(kw));
									if (!isMatch) continue;
									console.log(`[search] Series (closed) hit: "${event.title}"`);
									for (const raw of event.markets) {
										const m = mapGammaMarketToMarket(raw);
										if (m && !seriesDeduped.has(m.id)) {
											seriesDeduped.set(m.id, m);
											seriesMarkets.push(m);
										}
									}
								}
								if (events.length < 20) break;
							} catch {
								break;
							}
						}
					}
				}
			}

			if (seriesMarkets.length > 0) {
				seriesMarkets.sort((a, b) => {
					const rank = (s: Market['status']): number => s === 'active' ? 0 : s === 'paused' ? 1 : 2;
					return rank(a.status) - rank(b.status);
				});
				console.log(`[search] Series search found ${seriesMarkets.length} markets for "${query}"`);
				return seriesMarkets;
			}
		}

		// --- Strategy 2: Tag-based search (general sport queries) ---
		// Build a frequency map to skip broad/generic tags
		const tagFrequency = new Map<string, number>();
		for (const entry of sportsMeta) {
			for (const tagId of entry.tags.split(',')) {
				const t = tagId.trim();
				if (t) tagFrequency.set(t, (tagFrequency.get(t) ?? 0) + 1);
			}
		}
		const GENERIC_TAG_THRESHOLD = 10;

		const tagIds = new Set<string>();
		for (const sportCode of detectedSports) {
			const entry = sportsMeta.find(s => s.sport === sportCode);
			if (entry) {
				for (const tagId of entry.tags.split(',')) {
					const trimmed = tagId.trim();
					if (!trimmed) continue;
					const freq = tagFrequency.get(trimmed) ?? 0;
					if (freq < GENERIC_TAG_THRESHOLD) tagIds.add(trimmed);
				}
			}
		}

		if (tagIds.size === 0) {
			console.log('[search] No specific tags found, skipping tag search');
			return [];
		}

		const sportKeywords: string[] = [];
		for (const sportCode of detectedSports) {
			sportKeywords.push(sportCode);
			const aliases = SPORT_ALIASES[sportCode];
			if (aliases) sportKeywords.push(...aliases.filter(a => a.length > 2));
		}

		const allMarkets: Market[] = [];
		const deduped = new Map<string, Market>();

		for (const tagId of [...tagIds].slice(0, 3)) {
			try {
				const eventUrl = `${GAMMA_API_BASE}/events?tag_id=${tagId}&closed=false&limit=20&active=true`;
				const resp = await fetch(eventUrl);
				if (!resp.ok) continue;

				const events = await resp.json() as Array<{ title?: string; markets?: GammaMarketResponse[] }>;
				if (!Array.isArray(events)) continue;

				for (const event of events) {
					if (!Array.isArray(event.markets)) continue;
					const eventTitle = (event.title ?? '').toLowerCase();
					const isRelevant = sportKeywords.some(kw => eventTitle.includes(kw));
					if (!isRelevant) {
						console.log(`[search] Skipping irrelevant event: "${event.title}"`);
						continue;
					}
					console.log(`[search] Tag event: "${event.title}" (${event.markets.length} markets)`);
					for (const raw of event.markets) {
						const m = mapGammaMarketToMarket(raw);
						if (m && !deduped.has(m.id)) {
							deduped.set(m.id, m);
							allMarkets.push(m);
						}
					}
				}
			} catch {
				// best-effort; skip this tag
			}
		}

		allMarkets.sort((a, b) => {
			const rank = (s: Market['status']): number => s === 'active' ? 0 : s === 'paused' ? 1 : 2;
			const statusDiff = rank(a.status) - rank(b.status);
			if (statusDiff !== 0) return statusDiff;
			return b.volume - a.volume;
		});

		const activeCount = allMarkets.filter(m => m.status === 'active').length;
		console.log(`[search] Tag search: ${allMarkets.length} total markets, ${activeCount} active`);
		return allMarkets;
	}
}

/**
 * Fetches the /sports metadata from the Gamma API with in-memory caching.
 */
async function fetchSportsMetadata(): Promise<SportEntry[]> {
	if (sportsCache && Date.now() < sportsCacheExpiresAt) {
		return sportsCache;
	}

	try {
		const resp = await fetch(`${GAMMA_API_BASE}/sports`);
		if (!resp.ok) {
			console.log(`[sports] Failed to fetch /sports: ${resp.status}`);
			return sportsCache ?? [];
		}

		const data = await resp.json() as SportEntry[];
		if (Array.isArray(data)) {
			sportsCache = data;
			sportsCacheExpiresAt = Date.now() + SPORTS_CACHE_TTL_MS;
			console.log(`[sports] Cached ${data.length} sports entries`);
			return data;
		}
	} catch (err) {
		console.log(`[sports] Error fetching /sports: ${err}`);
	}

	return sportsCache ?? [];
}

/**
 * Detects sport/esports categories from a user query by matching
 * against known aliases and team names.
 * Returns an array of sport codes (e.g. ['lol', 'cs2']).
 */
function detectSportsFromQuery(query: string): string[] {
	const lower = query.toLowerCase();
	const words = lower.replace(/[^a-z0-9\s.]/g, ' ').split(/\s+/).filter(Boolean);
	const matches: string[] = [];

	for (const [sportCode, aliases] of Object.entries(SPORT_ALIASES)) {
		for (const alias of aliases) {
			// Check if the alias appears in the query as a whole word or substring
			if (alias.includes(' ')) {
				// Multi-word alias: check as substring
				if (lower.includes(alias)) {
					if (!matches.includes(sportCode)) matches.push(sportCode);
					break;
				}
			} else {
				// Single-word alias: check as exact word match
				if (words.includes(alias)) {
					if (!matches.includes(sportCode)) matches.push(sportCode);
					break;
				}
			}
		}
	}

	// If the query contains generic sport/esports terms, check for "vs" pattern
	// which strongly suggests a match-specific sports query
	if (matches.length === 0 && (lower.includes(' vs ') || lower.includes(' versus '))) {
		// Try to match against all sport aliases more loosely
		for (const [sportCode, aliases] of Object.entries(SPORT_ALIASES)) {
			for (const alias of aliases) {
				if (lower.includes(alias.slice(0, 3)) && alias.length >= 3) {
					if (!matches.includes(sportCode)) matches.push(sportCode);
					break;
				}
			}
			if (matches.length > 0) break; // found at least one loose match
		}
	}

	return matches;
}

/**
 * Uses Gemini to extract the core topic/search keywords from a conversational
 * Discord message. Falls back to simple prefix stripping if AI is unavailable.
 *
 * Example: "tell me about US strikes Iran by...?" → "US strikes Iran by"
 * Example: "what about Democratic Presidential Nominee 2028" → "Democratic Presidential Nominee 2028"
 */
async function extractSearchKeywords(message: string): Promise<string> {
	// Always run prefix stripping first — removes conversational framing.
	// For "X vs Y" queries this already gives perfect keywords; return immediately.
	// For everything else use it as a pre-processing step before AI.
	const stripped = stripConversationalPrefix(message);
	const isVsQuery = /\b(vs\.?|versus)\b/i.test(stripped) && stripped.split(/\s+/).length <= 6;
	if (isVsQuery) {
		console.log(`[extractSearchKeywords] vs-match strip: "${stripped}"`);
		return stripped;
	}

	// Short results after stripping (≤5 words) need no further cleanup.
	const strippedWords = stripped.trim().split(/\s+/).length;
	if (strippedWords <= 5) {
		console.log(`[extractSearchKeywords] Short after strip, using: "${stripped}"`);
		return stripped;
	}

	// For longer queries, run AI on the already-stripped string so it only
	// needs to remove residual noise (e.g. "of Gavin Newsom" → clean topic).
	if (!hasGeminiKeys()) {
		return stripped;
	}

	try {
		const text = await callGemini({
			contents: stripped,    // use pre-stripped string — less noise for AI
			systemInstruction: [
				'Extract the core topic or search keywords from the user message.',
				'Return ONLY the keywords — no explanation, no quotes, no punctuation except what is part of the topic name.',
				'Remove conversational words like "tell me about", "what is", "current status", "live status", etc.',
				'Keep team names, abbreviations, and specific identifiers EXACTLY as the user wrote them.',
				'Examples:',
				'  "tell me about US strikes Iran by...?" → US strikes Iran by',
				'  "what about Democratic Presidential Nominee 2028" → Democratic Presidential Nominee 2028',
				'  "show me the trump deportation markets" → trump deportation',
				'  "current live status of KTC vs DRXC market" → KTC vs DRXC',
				'  "hi can you check about KTC vs DRXC market" → KTC vs DRXC',
				'  "what are the lakers celtics odds" → lakers celtics',
			].join('\n'),
			temperature: 0,
			maxOutputTokens: 50,
		});

		// Validate AI output — reject if it dropped important entities from the input
		if (text && text.length >= 2 && text.length < 200) {
			const inputWords = stripped.trim().split(/\s+/).filter(w => w.length > 2);
			const outputWords = text.trim().split(/\s+/);

			// Reject: multi-word input collapsed to a single token (too aggressive)
			const tooAggressive = inputWords.length >= 4 && outputWords.length === 1;
			if (tooAggressive) {
				console.log('[extractSearchKeywords] AI collapsed too much, using stripped');
				return stripped;
			}

			// Reject: AI dropped proper nouns (capitalized words like "Gavin", "Newsom", "Sanders")
			// These are the most important search terms and must never be silently removed.
			const inputProperNouns = stripped.split(/\s+/).filter(w => /^[A-Z][a-z]{1,}/.test(w));
			const outputLower = text.toLowerCase();
			const droppedProperNoun = inputProperNouns.some(noun => !outputLower.includes(noun.toLowerCase()));
			if (inputProperNouns.length > 0 && droppedProperNoun) {
				console.log(`[extractSearchKeywords] AI dropped proper nouns (${inputProperNouns.join(', ')}), using stripped`);
				return stripped;
			}

			return text;
		}
	} catch (err) {
		console.log(`[extractSearchKeywords] AI call failed: ${err}`);
	}

	return stripped; // fallback to prefix-stripped version if AI fails or returns invalid
}

/**
 * Words that are conversational noise — NOT part of team/event names.
 * Used when extracting team1 from text before "vs".
 */
const VS_STOPWORDS = new Set([
	'the', 'a', 'an', 'of', 'for', 'in', 'on', 'at', 'to', 'is', 'are', 'be',
	'hi', 'hey', 'hello', 'can', 'you', 'please', 'about', 'check', 'what',
	'how', 'who', 'which', 'tell', 'me', 'show', 'give', 'find', 'get', 'do',
	'current', 'live', 'status', 'going', 'this', 'that', 'game', 'match',
	'market', 'series', 'will', 'win', 'beat', 'score', 'update', 'info',
	'between', 'and', 'with', 'vs', 'versus', 'right', 'now', 'today',
	'tonight', 'odds', 'predict', 'prediction', 'look', 'like', 'think',
]);

/**
 * Strips conversational noise and extracts search keywords without AI.
 *
 * Priority:
 *   1. "X vs Y" anywhere in the message → returns "X vs Y" (team names only)
 *   2. Known conversational prefix → strip and return rest
 *   3. Returns the original query unchanged (caller can try AI next)
 */
function stripConversationalPrefix(query: string): string {
	const lower = query.toLowerCase().trim();

	// --- Priority 1: "X vs Y" pattern anywhere in the message ---
	// Match both "vs" and "versus", with optional trailing noise
	const vsRe = /\b(vs\.?|versus)\b/i;
	const vsMatch = vsRe.exec(lower);
	if (vsMatch && vsMatch.index !== undefined) {
		const vsIdx = vsMatch.index;
		const vsLen = vsMatch[0].length;

		// Everything before "vs"
		const beforeVs = query.slice(0, vsIdx).trim().split(/\s+/);
		// Everything after "vs", strip trailing noise words
		const afterVsRaw = query.slice(vsIdx + vsLen).trim()
			.replace(/\s*(market|game|match|series|right\s*now|rn|going|today|tonight|\?)\s*$/i, '').trim();

		// Filter stopwords from beforeVs, keep meaningful words (team names, abbreviations)
		const team1Words = beforeVs.filter(w => !VS_STOPWORDS.has(w.toLowerCase().replace(/[^a-z0-9]/g, '')));
		const team1 = team1Words.slice(-2).join(' ').trim(); // last 1-2 meaningful words

		// Take first 1-2 words after "vs" as team2 (team names are short)
		const team2Words = afterVsRaw.split(/\s+/).filter(w => w.length > 0);
		const team2 = team2Words.slice(0, 2).join(' ').trim();

		if (team1 && team2) {
			return `${team1} vs ${team2}`;
		}
	}

	// --- Priority 2: Known conversational prefixes (longest match first) ---
	const prefixes = [
		// Multi-word specific prefixes first (to prevent partial matches)
		'hi can you check about ', 'hi can you check ',
		'can you tell me about ', 'can you tell me ',
		'can you check about ', 'can you check ',
		'please tell me about ', 'please check ',
		'could you check ', 'could you tell me about ',
		'current live status of ', 'current status of ', 'live status of ',
		'what is the status of ', 'what is the score of ',
		'what are the odds for ', 'what are the odds on ',
		'how are the odds for ', 'how are the odds on ',
		'how is this game going', 'how is the game going', 'how is this match going',
		'how is this going', 'how is it going',
		'i want to know about ', 'do you have info on ', 'do you have info about ',
		'info on ', 'info about ', 'any updates on ',
		// Short prefixes last
		'tell me about ', 'what about ', 'what is ', 'what are ',
		'show me ', 'give me ', 'check on ', 'check about ',
		'how about ', 'who will win ',
	];
	for (const p of prefixes) {
		if (lower.startsWith(p)) {
			const rest = query.slice(p.length).trim()
				.replace(/\s*(market|right\s*now|rn|today|tonight|at the moment|\?)\s*$/i, '').trim();
			if (rest.length > 0) return rest;
		}
	}

	return query; // unchanged — caller may try AI
}

/**
 * Builds multiple slug candidates from conversational queries like
 * "tell me about US strikes Iran by...?" so the events endpoint can match.
 *
 * Strategy: generate sliding windows of the ORIGINAL words (not just filtered)
 * so country codes like "US" aren't stripped. Only strip leading conversational
 * prefixes like "tell me about", "what about", etc.
 */
function buildEventSlugCandidates(query: string): string[] {
	const words = query
		.toLowerCase()
		.replace(/[^a-z0-9\s]/g, ' ')
		.split(/\s+/)
		.filter(Boolean);

	const slugify = (tokens: string[]): string =>
		tokens
			.join('-')
			.replace(/-+/g, '-')
			.replace(/^-+|-+$/g, '');

	// Strip common conversational prefixes
	const prefixes = [
		['tell', 'me', 'about'],
		['what', 'about'],
		['what', 'is'],
		['what', 'are'],
		['show', 'me'],
		['can', 'you', 'tell', 'me', 'about'],
		['please', 'tell', 'me', 'about'],
		['i', 'want', 'to', 'know', 'about'],
		['do', 'you', 'have', 'info', 'on'],
		['info', 'on'],
		['info', 'about'],
	];

	let stripped = words;
	for (const prefix of prefixes) {
		if (words.length > prefix.length && words.slice(0, prefix.length).join(' ') === prefix.join(' ')) {
			stripped = words.slice(prefix.length);
			break;
		}
	}

	const candidates: string[] = [];
	const add = (s: string) => {
		if (s && !candidates.includes(s)) candidates.push(s);
	};

	// Stripped query is the best candidate (e.g. "us-strikes-iran-by")
	add(slugify(stripped));

	// Full query slug
	add(slugify(words));

	// Sliding windows on ALL words (not filtered) — largest first
	for (let size = Math.min(8, words.length); size >= 2; size--) {
		for (let start = 0; start + size <= words.length; start++) {
			add(slugify(words.slice(start, start + size)));
		}
		if (candidates.length >= 15) break;
	}

	return candidates.slice(0, 15);
}

/**
 * Maps a raw Gamma API market response to our internal Market shape.
 * Returns null if the response is malformed or missing required fields.
 */
function mapGammaMarketToMarket(raw: GammaMarketResponse): Market | null {
	const id = raw.id ?? raw.condition_id;
	const question = raw.question ?? raw.title;
	if (!id || !question) {
		return null;
	}

	const status = resolveMarketStatus(raw);
	const outcomes = parseOutcomes(raw.outcomes);
	const outcomePrices = parseOutcomePrices(raw.outcomePrices, outcomes.length);
	const volume = typeof raw.volume === 'number' ? raw.volume : parseFloat(String(raw.volume ?? '0')) || 0;

	// Derive slug: prefer Gamma API slug, fallback to slugifying the question
	const slug = raw.slug || question.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

	// Extract parent event slug for Polymarket event URL (used by Olympus links)
	const eventSlug = raw.events?.[0]?.slug ?? undefined;

	return {
		id: id as MarketId,
		question,
		status,
		outcomes,
		outcomePrices,
		volume,
		slug,
		eventSlug,
	};
}

/**
 * Derives our tri-state status from the Gamma API's boolean flags.
 */
function resolveMarketStatus(raw: GammaMarketResponse): Market['status'] {
	if (raw.closed === true) {
		return 'closed';
	}

	if (raw.active === false || raw.accepting_orders === false) {
		return 'paused';
	}

	return 'active';
}

/**
 * Parses the Gamma API's JSON-encoded outcomes string into typed Outcome array.
 * Falls back to binary ['YES','NO'] if parsing fails (Polymarket default).
 */
/**
 * Parses outcomePrices from the Gamma API into a number array.
 * Falls back to equal probabilities if parsing fails.
 */
function parseOutcomePrices(value: string | string[] | undefined, outcomeCount: number): readonly number[] {
	const fallback = Array(outcomeCount).fill(1 / outcomeCount);
	if (!value) return fallback;

	try {
		const arr: string[] = Array.isArray(value) ? value : JSON.parse(value);
		if (!Array.isArray(arr) || arr.length === 0) return fallback;
		return arr.map(v => parseFloat(v) || 0);
	} catch {
		return fallback;
	}
}

function parseOutcomes(outcomesValue: string | string[] | undefined): readonly Outcome[] {
	if (!outcomesValue) {
		return ['YES', 'NO'];
	}

	const normalize = (arr: string[]): Outcome[] => arr.map((o) => o.toUpperCase() as Outcome);

	if (Array.isArray(outcomesValue)) {
		return normalize(outcomesValue.length > 0 ? outcomesValue : ['YES', 'NO']);
	}

	try {
		const parsed = JSON.parse(outcomesValue) as string[];
		if (!Array.isArray(parsed) || parsed.length === 0) {
			return ['YES', 'NO'];
		}
		return normalize(parsed);
	} catch {
		return ['YES', 'NO'];
	}
}
