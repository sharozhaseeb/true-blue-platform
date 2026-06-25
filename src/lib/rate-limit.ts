type RateLimitBucket = {
  count: number;
  resetAt: number;
};

export type RateLimitDecision = {
  allowed: boolean;
  limit: number;
  remaining: number;
  resetAt: number;
};

export type RateLimitConfig = {
  key: string;
  limit: number;
  windowMs: number;
  now?: number;
  commit?: boolean;
};

const buckets = new Map<string, RateLimitBucket>();

function cleanupExpiredBuckets(now: number) {
  for (const [key, bucket] of buckets) {
    if (bucket.resetAt <= now) {
      buckets.delete(key);
    }
  }
}

export function checkRateLimit(config: RateLimitConfig): RateLimitDecision {
  const now = config.now ?? Date.now();
  const commit = config.commit ?? true;
  cleanupExpiredBuckets(now);
  const current = buckets.get(config.key);

  if (!current || current.resetAt <= now) {
    const resetAt = now + config.windowMs;
    if (commit) {
      buckets.set(config.key, { count: 1, resetAt });
    }

    return {
      allowed: true,
      limit: config.limit,
      remaining: Math.max(config.limit - 1, 0),
      resetAt,
    };
  }

  const nextCount = current.count + 1;
  if (current.count >= config.limit) {
    return {
      allowed: false,
      limit: config.limit,
      remaining: 0,
      resetAt: current.resetAt,
    };
  }

  if (commit) {
    current.count = nextCount;
  }
  return {
    allowed: true,
    limit: config.limit,
    remaining: Math.max(config.limit - nextCount, 0),
    resetAt: current.resetAt,
  };
}

export function checkChatRateLimits(input: {
  firmId: string;
  userId: string;
  now?: number;
}): RateLimitDecision {
  const windowMs = 60_000;
  const userLimit = Number.parseInt(process.env.CHAT_USER_RATE_LIMIT_PER_MINUTE ?? "60", 10);
  const firmLimit = Number.parseInt(process.env.CHAT_FIRM_RATE_LIMIT_PER_MINUTE ?? "300", 10);
  const safeUserLimit = Number.isFinite(userLimit) && userLimit > 0 ? userLimit : 60;
  const safeFirmLimit = Number.isFinite(firmLimit) && firmLimit > 0 ? firmLimit : 300;
  const userDecision = checkRateLimit({
    key: `chat:user:${input.userId}`,
    limit: safeUserLimit,
    windowMs,
    now: input.now,
    commit: false,
  });
  if (!userDecision.allowed) {
    return userDecision;
  }

  const firmDecision = checkRateLimit({
    key: `chat:firm:${input.firmId}`,
    limit: safeFirmLimit,
    windowMs,
    now: input.now,
    commit: false,
  });
  if (!firmDecision.allowed) {
    return firmDecision;
  }

  const committedUserDecision = checkRateLimit({
    key: `chat:user:${input.userId}`,
    limit: safeUserLimit,
    windowMs,
    now: input.now,
    commit: true,
  });
  const committedFirmDecision = checkRateLimit({
    key: `chat:firm:${input.firmId}`,
    limit: safeFirmLimit,
    windowMs,
    now: input.now,
    commit: true,
  });

  return committedUserDecision.remaining <= committedFirmDecision.remaining
    ? committedUserDecision
    : committedFirmDecision;
}

export function resetRateLimitsForTests() {
  buckets.clear();
}
