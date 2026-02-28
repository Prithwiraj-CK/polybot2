import { GoogleGenAI } from '@google/genai';

/**
 * Shared Gemini API client with automatic key rotation.
 *
 * Loads all keys from GEMINI_API_KEY (primary) and GEMINI_API_KEY_2, GEMINI_API_KEY_3, etc.
 * When a key hits a rate limit (429), it is temporarily disabled and the next key is tried.
 *
 * This module is intentionally a singleton — all callers share the same rotation state
 * so a key exhausted by keyword extraction is also skipped by the explainer.
 */

interface GeminiCallOptions {
	contents: string;
	systemInstruction?: string;
	temperature?: number;
	maxOutputTokens?: number;
	responseMimeType?: string;
}

/** How long to disable a key after a 429 (ms). */
const COOLDOWN_MS = 60_000; // 1 minute

interface KeyState {
	key: string;
	disabledUntil: number; // epoch ms, 0 = available
}

const keyStates: KeyState[] = [];
let initialized = false;

function ensureInitialized(): void {
	if (initialized) return;
	initialized = true;

	// Load primary key + any numbered keys (GEMINI_API_KEY_2, _3, _4, ...)
	const primary = process.env.GEMINI_API_KEY;
	if (primary) keyStates.push({ key: primary, disabledUntil: 0 });

	for (let i = 2; i <= 20; i++) {
		const k = process.env[`GEMINI_API_KEY_${i}`];
		if (!k) break;
		keyStates.push({ key: k, disabledUntil: 0 });
	}

	console.log(`[gemini] Initialized with ${keyStates.length} API key(s)`);
}

function getAvailableKey(): string | null {
	ensureInitialized();
	const now = Date.now();
	for (const state of keyStates) {
		if (now >= state.disabledUntil) {
			return state.key;
		}
	}
	return null;
}

function disableKey(key: string): void {
	const state = keyStates.find(s => s.key === key);
	if (state) {
		state.disabledUntil = Date.now() + COOLDOWN_MS;
		const idx = keyStates.indexOf(state);
		console.log(`[gemini] Key #${idx + 1} rate-limited, disabled for ${COOLDOWN_MS / 1000}s`);
	}
}

function isRateLimitError(err: unknown): boolean {
	if (err instanceof Error) {
		const msg = err.message.toLowerCase();
		return msg.includes('429') || msg.includes('rate') || msg.includes('quota') || msg.includes('resource_exhausted');
	}
	return false;
}

/**
 * Calls Gemini with automatic key rotation on rate-limit errors.
 * Returns the response text, or null if all keys are exhausted/unavailable.
 */
export async function callGemini(options: GeminiCallOptions): Promise<string | null> {
	ensureInitialized();

	const model = process.env.GEMINI_MODEL ?? 'gemini-2.5-flash';
	const triedKeys = new Set<string>();

	while (true) {
		const key = getAvailableKey();
		if (!key || triedKeys.has(key)) {
			console.log('[gemini] All keys exhausted or rate-limited');
			return null;
		}
		triedKeys.add(key);

		try {
			const ai = new GoogleGenAI({ apiKey: key });
			const response = await ai.models.generateContent({
				model,
				contents: options.contents,
				config: {
					systemInstruction: options.systemInstruction,
					temperature: options.temperature ?? 0.4,
					maxOutputTokens: options.maxOutputTokens ?? 500,
					responseMimeType: options.responseMimeType,
				},
			});

			const text = response.text?.trim();
			return text && text.length > 0 ? text : null;
		} catch (err) {
			if (isRateLimitError(err)) {
				disableKey(key);
				continue; // try next key
			}
			console.error('[gemini] Non-rate-limit error:', err instanceof Error ? err.message : err);
			return null;
		}
	}
}

/**
 * Returns true if at least one Gemini key is configured.
 */
export function hasGeminiKeys(): boolean {
	ensureInitialized();
	return keyStates.length > 0;
}
