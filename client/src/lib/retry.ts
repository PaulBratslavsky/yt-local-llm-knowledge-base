// Generic retry-with-backoff wrapper for flaky network-level calls.
//
// Only retries errors that look transient (connection-level, timeout,
// abort). Schema-validation failures and HTTP 4xx errors are NOT retried
// — running the exact same prompt again won't produce a valid JSON the
// second time, and we don't want to hammer an endpoint that's telling us
// our request is malformed.
//
// Usage:
//   await withRetry(() => fetch(url), { attempts: 3, onRetry: (err, n, ms) => ... });

export type RetryOptions = {
  // Total attempts including the first try. Default 3 → 1 initial + 2 retries.
  attempts?: number;
  // Initial delay (ms). Doubles each retry, capped by `maxMs`.
  baseMs?: number;
  // Cap on the per-attempt delay to avoid absurd waits on repeated failures.
  maxMs?: number;
  // Custom classifier — return true to retry, false to throw immediately.
  shouldRetry?: (err: unknown) => boolean;
  // Observer callback fired before each retry sleep. Use for logging.
  onRetry?: (err: unknown, attempt: number, delayMs: number) => void;
};

// Patterns that indicate a transient network/runtime error worth retrying.
// These are the error strings Node, undici, the AI SDK, and the Ollama
// OpenAI-compat endpoint emit when the connection can't be made or got
// dropped. Match message text, not error class, because the SDK wraps
// underlying errors opaquely.
const TRANSIENT_PATTERNS: RegExp[] = [
  /ECONNREFUSED/i,
  /ECONNRESET/i,
  /ETIMEDOUT/i,
  /ENOTFOUND/i,
  /EAI_AGAIN/i,
  /EPIPE/i,
  /socket hang up/i,
  /network\s*error/i,
  /fetch failed/i,
  /request aborted/i,
  /\babort(ed)?\b/i,
  /\btimeout\b/i,
  /request failed/i,
  /upstream connect error/i,
];

function defaultShouldRetry(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return TRANSIENT_PATTERNS.some((p) => p.test(message));
}

// Exponential backoff with bounded jitter. Returns the delay to wait
// before attempt N (0-indexed). Jitter is ±10% so multiple concurrent
// retries don't synchronise into a thundering herd.
function computeDelay(attempt: number, base: number, max: number): number {
  const exp = Math.min(max, base * 2 ** attempt);
  const jitter = (Math.random() - 0.5) * 0.2 * exp;
  return Math.round(exp + jitter);
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: RetryOptions = {},
): Promise<T> {
  const attempts = opts.attempts ?? 3;
  const base = opts.baseMs ?? 500;
  const max = opts.maxMs ?? 8000;
  const shouldRetry = opts.shouldRetry ?? defaultShouldRetry;

  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const isLast = i === attempts - 1;
      if (isLast || !shouldRetry(err)) throw err;
      const delayMs = computeDelay(i, base, max);
      opts.onRetry?.(err, i + 1, delayMs);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  // Unreachable — the loop either returns or throws — but TS wants it.
  throw lastErr;
}
