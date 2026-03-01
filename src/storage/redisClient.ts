import Redis from 'ioredis';

/**
 * Singleton Redis client for PolyBot persistence.
 *
 * Reads REDIS_URL from environment. If not set, exports null
 * and consumers fall back to in-memory storage.
 */

let redis: Redis | null = null;

export function getRedis(): Redis | null {
	if (redis) return redis;

	const url = process.env.REDIS_URL;
	if (!url) {
		console.log('⚠️  REDIS_URL not set — using in-memory storage (data lost on restart)');
		return null;
	}

	try {
		redis = new Redis(url, {
			maxRetriesPerRequest: 3,
			retryStrategy(times) {
				if (times > 5) return null; // stop retrying after 5 attempts
				return Math.min(times * 200, 2000);
			},
			lazyConnect: false,
		});

		redis.on('connect', () => console.log('🟢 Redis connected'));
		redis.on('error', (err) => console.error('🔴 Redis error:', err.message));

		return redis;
	} catch (err) {
		console.error('🔴 Failed to create Redis client:', err);
		return null;
	}
}

/**
 * Cache-or-fetch pattern: tries Redis first, falls back to fetcher.
 * Stores result in Redis with the given TTL (in seconds).
 * If Redis is unavailable, always calls the fetcher directly.
 */
export async function getOrFetch<T>(
	key: string,
	fetcher: () => Promise<T>,
	ttlSeconds: number = 30,
): Promise<T> {
	const r = getRedis();
	if (r) {
		try {
			const cached = await r.get(key);
			if (cached) {
				console.log(`[cache] hit: ${key}`);
				return JSON.parse(cached) as T;
			}
		} catch {
			// Redis read failed — fall through to fetcher
		}
	}

	const data = await fetcher();

	// Store in cache (non-blocking, best-effort)
	if (r) {
		r.setex(key, ttlSeconds, JSON.stringify(data)).catch(() => { });
	}

	return data;
}

/**
 * Invalidate all keys matching a glob pattern.
 */
export async function invalidateCache(pattern: string): Promise<void> {
	const r = getRedis();
	if (!r) return;

	try {
		const stream = r.scanStream({ match: pattern, count: 100 });
		const keys: string[] = [];
		stream.on('data', (batch: string[]) => keys.push(...batch));
		await new Promise<void>((resolve) => stream.on('end', resolve));
		if (keys.length > 0) await r.del(...keys);
	} catch {
		// best-effort
	}
}
