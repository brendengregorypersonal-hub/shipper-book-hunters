// A shared pace for every outside request (about one a second) and a fetch that retries politely.
// Public data sources are free because people are gentle with them: never go faster than this.

export const USER_AGENT = "ShipperBookHunters/0.1 (collects public open data; contact in the repository README)";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Runs jobs one after another with at least `minGapMs` between the starts of two jobs */
export function createLimiter({ minGapMs = 1000, now = () => Date.now(), wait = sleep } = {}) {
  let last = -Infinity;
  let chain = Promise.resolve();
  return function schedule(job) {
    const run = chain.then(async () => {
      const gap = last + minGapMs - now();
      if (gap > 0) await wait(gap);
      last = now();
      return job();
    });
    chain = run.catch(() => {}); // one failed job doesn't stop the line
    return run;
  };
}

export const shared = createLimiter({ minGapMs: Number(process.env.HUNTER_MIN_GAP_MS) || 1000 });

/**
 * GET a JSON address through the shared pace. Retries 429 and 5xx answers (and network errors) with growing waits,
 * and honours a Retry-After header. Gives up with a clear error.
 */
export async function fetchJson(url, { headers = {}, retries = 4, schedule = shared, fetchImpl = fetch, wait = sleep, baseDelayMs = 2000 } = {}) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await schedule(() => fetchImpl(url, { headers: { "User-Agent": USER_AGENT, Accept: "application/json", ...headers } }));
      if (res.ok) return await res.json();
      if (res.status === 429 || res.status >= 500) {
        const retryAfter = Number(res.headers?.get?.("retry-after"));
        lastError = new Error(`${res.status} from ${new URL(url).host}`);
        if (attempt < retries) await wait(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : baseDelayMs * 2 ** attempt);
        continue;
      }
      throw Object.assign(new Error(`${res.status} from ${new URL(url).host}`), { permanent: true });
    } catch (e) {
      if (e.permanent) throw e;
      lastError = e;
      if (attempt < retries) await wait(baseDelayMs * 2 ** attempt);
    }
  }
  throw lastError ?? new Error("request failed");
}
