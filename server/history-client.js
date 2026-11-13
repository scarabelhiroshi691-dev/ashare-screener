import { setTimeout as delay } from "node:timers/promises";

export class DataError extends Error {
  constructor(message, kind = "data", extra = {}) {
    super(message);
    this.kind = kind;
    Object.assign(this, extra);
  }
}
export function retryAfterMs(value, now = Date.now()) {
  if (!value) return 0;
  if (/^\d+(\.\d+)?$/.test(value)) return Number(value) * 1000;
  return Math.max(0, Date.parse(value) - now) || 0;
}

export function abortable(task, signal) {
  if (!signal) return task;
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    task
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", abort));
  });
}

// One shared queue for scans AND detail views; never rotate proxies or evade a denial.
export function createHistoryClient({
  fetchImpl = fetch,
  sleep = delay,
  now = Date.now,
  interval = 2000,
  maxAttempts = 3,
  decode = JSON.parse,
  referer = "https://quote.eastmoney.com/",
} = {}) {
  let tail = Promise.resolve(),
    nextAt = 0,
    blockedUntil = 0,
    blockedReason = "";
  async function perform(url, { signal, onEvent } = {}) {
    signal?.throwIfAborted();
    if (blockedUntil > now())
      throw new DataError(blockedReason, "blocked", { retryAt: blockedUntil });
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const wait = Math.max(0, nextAt - now());
      if (wait > 120000)
        throw new DataError("数据源要求较长冷却，请稍后续跑。", "cooldown", {
          retryAt: nextAt,
        });
      if (wait) {
        onEvent?.({ type: "waiting", until: nextAt, attempt });
        await sleep(wait, undefined, { signal });
      }
      signal?.throwIfAborted();
      nextAt = now() + interval;
      onEvent?.({ type: "request", attempt });
      try {
        const timeout = AbortSignal.timeout(15000);
        const response = await fetchImpl(url, {
          signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
          headers: {
            "User-Agent": "Mozilla/5.0",
            Referer: referer,
          },
        });
        const text = await response.text();
        if (text.length > 5 * 1024 * 1024)
          throw new DataError("历史数据响应过大", "data");
        if (
          [401, 403].includes(response.status) ||
          (/<html|<!doctype/i.test(text) &&
            /waf\.|captcha|access.denied/i.test(text))
        ) {
          blockedUntil = now() + 30 * 60 * 1000;
          blockedReason = `历史数据源拒绝访问（HTTP ${response.status}），已暂停 30 分钟；不会自动绕过防护。`;
          throw new DataError(blockedReason, "blocked", {
            status: response.status,
            retryAt: blockedUntil,
          });
        }
        if (!response.ok) {
          const transient = [408, 425, 429, 500, 502, 503, 504].includes(
            response.status,
          );
          throw new DataError(
            `历史数据源返回 HTTP ${response.status}`,
            transient ? "transient" : "permanent",
            {
              status: response.status,
              retryAfter: retryAfterMs(
                response.headers.get("retry-after"),
                now(),
              ),
            },
          );
        }
        let payload;
        try {
          payload = decode(text);
        } catch (error) {
          if (error instanceof DataError) throw error;
          throw new DataError("历史数据响应不是有效 JSON", "data");
        }
        onEvent?.({ type: "received", attempt });
        return payload;
      } catch (error) {
        if (signal?.aborted) throw signal.reason;
        const e =
          error instanceof DataError
            ? error
            : new DataError(
                `历史数据网络错误：${error.message}${/^[A-Z][A-Z0-9_]+$/.test(error.cause?.code || error.code || "") ? `（${error.cause?.code || error.code}）` : ""}`,
                "transient",
              );
        if (e.kind !== "transient") throw e;
        // Honor Retry-After even after this stock has exhausted its attempt budget.
        const cooldown = Math.max(e.retryAfter || 0, 5000 * 3 ** (attempt - 1));
        nextAt = Math.max(nextAt, now() + cooldown);
        if (attempt === maxAttempts) throw e;
        onEvent?.({
          type: "retry",
          attempt: attempt + 1,
          until: nextAt,
          message: e.message,
        });
        // A very long server cooldown should become a resumable pause, not an invisible wait.
        if (cooldown > 120000)
          throw new DataError("数据源要求较长冷却，请稍后续跑。", "cooldown", {
            retryAt: nextAt,
          });
      }
    }
  }
  return {
    request(url, options) {
      const task = tail.then(() => perform(url, options));
      tail = task.catch(() => {});
      return abortable(task, options?.signal);
    },
    status() {
      return { nextAt, blockedUntil, blockedReason };
    },
    restore(saved = {}) {
      if (Number.isFinite(saved.nextAt))
        nextAt = Math.max(nextAt, saved.nextAt);
      if (Number.isFinite(saved.blockedUntil))
        blockedUntil = Math.max(blockedUntil, saved.blockedUntil);
      if (typeof saved.blockedReason === "string")
        blockedReason = saved.blockedReason;
    },
  };
}
export const historyClient = createHistoryClient();
