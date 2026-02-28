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
