import { setTimeout as delay } from "node:timers/promises";
import { chinaClock, quoteTimestamp } from "../shared/time.js";
import { historyClient, DataError } from "./history-client.js";
import { baoClient, parseBaoStock } from "./baostock.js";
import { createSinaHistoryProvider } from "./sina-history.js";
import {
  numberOrNull as n,
  symbolBoard,
  validSymbol,
} from "../shared/rules.js";

const nextSlots = new Map();
async function request(
  url,
  { signal, encoding = "utf-8", interval = 450 } = {},
) {
  const host = new URL(url).host;
  const scheduled = Math.max(Date.now(), nextSlots.get(host) || 0);
  nextSlots.set(host, scheduled + interval);
  await delay(Math.max(0, scheduled - Date.now()), undefined, { signal });
  const combined = signal
    ? AbortSignal.any([signal, AbortSignal.timeout(12000)])
    : AbortSignal.timeout(12000);
  const response = await fetch(url, {
    signal: combined,
    headers: {
      "User-Agent": "Mozilla/5.0",
      Referer: host.includes("gtimg")
        ? "https://gu.qq.com/"
        : "https://quote.eastmoney.com/",
    },
  });
  if (!response.ok)
    throw new Error(
      response.status === 429
        ? "数据源限制请求频率，请稍后重试。"
        : `数据源返回 HTTP ${response.status}`,
    );
  const bytes = await response.arrayBuffer();
  if (bytes.byteLength > 10 * 1024 * 1024) throw new Error("数据源响应过大");
  return new TextDecoder(encoding).decode(bytes);
}

export function parseEastmoney(row) {
  const code = String(row.f12 || "");
  const symbol = `${Number(row.f13) === 1 ? "sh" : "sz"}${code}`;
  if (!validSymbol(symbol)) return null;
  const epoch = n(row.f124);
  const quoteAt =
    epoch && epoch > 1e9 && epoch < 4e9
      ? new Date(epoch * 1000).toISOString()
      : null;
  return {
    symbol,
    code,
    name: String(row.f14 || code),
    board: symbolBoard(code),
    price: n(row.f2),
    changePct: n(row.f3),
    volume: n(row.f5) === null ? null : n(row.f5) * 100,
    amount: n(row.f6),
    turnover: n(row.f8),
    sourceVolumeRatio: n(row.f10),
    open: n(row.f17),
    high: n(row.f15),
    low: n(row.f16),
    previousClose: n(row.f18),
    quoteAt,
    quoteDate: quoteAt ? chinaClock(quoteAt).date : null,
    source: "东方财富",
  };
}

export function assertCoverage(rows, total) {
  if (!Number.isInteger(total) || total < 1000 || total > 10000)
    throw new Error("市场总数异常，未保存不完整数据。");
  if (
    new Set(rows.map((r) => r.symbol)).size !== total ||
    rows.length !== total
  )
    throw new Error(
      `分页覆盖不完整：${new Set(rows.map((r) => r.symbol)).size}/${total}，请重新刷新。`,
    );
}

export async function fetchMarket({ signal, onProgress } = {}) {
  const rows = [];
  let total = 0;
  const startedAt = new Date().toISOString();
  for (let page = 1; page === 1 || rows.length < total; page++) {
    if (page > 100) throw new Error("市场分页数量超限");
    const url = new URL("https://push2.eastmoney.com/api/qt/clist/get");
    url.search = new URLSearchParams({
      pn: String(page),
      pz: "100",
      po: "0",
      np: "1",
      fltt: "2",
      invt: "2",
      fid: "f12",
      fs: "m:1+t:2,m:1+t:23,m:0+t:6,m:0+t:80",
      fields: "f2,f3,f5,f6,f8,f10,f12,f13,f14,f15,f16,f17,f18,f124",
    }).toString();
    const payload = JSON.parse(await request(url, { signal, interval: 1500 }));
    if (
      payload.rc !== 0 ||
      !Array.isArray(payload.data?.diff) ||
      !payload.data.diff.length
    )
      throw new Error(`第 ${page} 页没有有效行情，未替换上次数据。`);
    if (page === 1) total = payload.data.total;
    if (total !== payload.data.total)
      throw new Error("刷新期间市场数量发生变化，请重试。");
    if (!Number.isInteger(total) || total < 1000 || total > 10000)
      throw new Error("市场数量异常");
    rows.push(...payload.data.diff.map(parseEastmoney).filter(Boolean));
    onProgress?.({
      done: rows.length,
      total,
      page,
      pages: Math.ceil(total / 100),
    });
  }
  assertCoverage(rows, total);
  const dates = rows
    .map((s) => s.quoteDate)
    .filter(Boolean)
    .sort();
  const date = dates.at(-1);
  const validDates = rows.filter((s) => s.quoteDate === date).length;
  if (!date || validDates < rows.length * 0.9)
    throw new Error("行情日期不一致，未替换上次数据。");
  return {
    stocks: rows,
    total,
    date,
    source: "东方财富",
    startedAt,
    fetchedAt: new Date().toISOString(),
    coverage: rows.length,
  };
}

export async function fetchMarketBackup({ signal, onProgress } = {}) {
  const base =
    "https://vip.stock.finance.sina.com.cn/quotes_service/api/json_v2.php/";
  const total = Number(
    JSON.parse(
      await request(base + "Market_Center.getHQNodeStockCount?node=hs_a", {
        signal,
        interval: 1000,
      }),
    ),
  );
  if (!Number.isInteger(total) || total < 1000 || total > 10000)
    throw new Error("备用股票目录总数异常");
  const directory = [];
  for (let page = 1; page <= Math.ceil(total / 100); page++) {
    const rows = JSON.parse(
      await request(
        base +
          `Market_Center.getHQNodeData?page=${page}&num=100&sort=symbol&asc=1&node=hs_a&symbol=`,
        { signal, interval: 1000 },
      ),
    );
    if (!Array.isArray(rows) || !rows.length)
      throw new Error("备用股票目录分页缺失");
    directory.push(...rows);
    onProgress?.({
      done: directory.length,
      total: total * 2,
      page,
      pages: Math.ceil(total / 100) * 2,
    });
  }
  assertCoverage(directory, total);
  const symbols = directory.map((s) => s.symbol).filter(validSymbol),
    stocks = [];
  for (let i = 0; i < symbols.length; i += 200) {
    const result = await fetchQuotes(symbols.slice(i, i + 200), signal);
    if (result.missing.length)
      throw new Error(
        `备用报价缺少 ${result.missing.length} 只股票，未保存不完整行情。`,
      );
    stocks.push(...result.stocks);
    onProgress?.({
      done: total + stocks.length,
      total: total + symbols.length,
    });
  }
  assertCoverage(stocks, symbols.length);
  const date = stocks
    .map((s) => s.quoteDate)
    .sort()
    .at(-1);
  if (stocks.filter((s) => s.quoteDate === date).length < stocks.length * 0.9)
    throw new Error("备用行情日期不一致");
  return {
    stocks,
    total: stocks.length,
    date,
    source: "腾讯财经（新浪股票目录）",
    fetchedAt: new Date().toISOString(),
    coverage: stocks.length,
  };
}

export function parseTencent(text) {
  const result = [];
  for (const match of text.matchAll(/v_((?:sh|sz)\d{6})="([^"\r\n]*)";/g)) {
    const symbol = match[1],
      a = match[2].split("~");
    if (!validSymbol(symbol) || a.length < 40) continue;
    const quoteAt = quoteTimestamp(a[30]);
    if (!quoteAt || n(a[3]) === null) continue;
    result.push({
      symbol,
      code: a[2],
      name: a[1],
      board: symbolBoard(a[2]),
      price: n(a[3]),
      previousClose: n(a[4]),
      open: n(a[5]),
      volume: n(a[6]) === null ? null : n(a[6]) * 100,
      amount: n(a[37]) === null ? null : n(a[37]) * 10000,
      changePct: n(a[32]),
      high: n(a[33]),
      low: n(a[34]),
      turnover: n(a[38]),
      quoteAt,
      quoteDate: chinaClock(quoteAt).date,
      source: "腾讯财经",
    });
  }
  return result;
}

export async function fetchQuotes(symbols, signal) {
  if (
    !Array.isArray(symbols) ||
    !symbols.length ||
    symbols.length > 200 ||
    symbols.some((s) => !validSymbol(s))
  )
    throw new Error("每次报价请求需包含 1–200 个有效沪深股票代码。");
  const all = [];
  for (let i = 0; i < symbols.length; i += 50)
    all.push(
      ...parseTencent(
        await request(
          `https://qt.gtimg.cn/q=${symbols.slice(i, i + 50).join(",")}`,
          { signal, encoding: "gb18030" },
        ),
      ),
    );
  if (!all.length) throw new Error("报价源没有返回有效数据。");
  return {
    stocks: all,
    missing: symbols.filter((s) => !all.some((q) => q.symbol === s)),
    source: "腾讯财经",
    fetchedAt: new Date().toISOString(),
  };
}

export function parseHistory(payload, symbol, volumeMultiplier = 100) {
  const data = payload.data?.[symbol];
  // Never silently substitute unadjusted prices for a requested adjusted series.
  const raw = data?.qfqday;
  if (payload.code !== 0 || !Array.isArray(raw) || raw.length === 0)
    throw new Error("数据源没有返回前复权日线。");
  const bars = raw.map((row) => ({
    date: row[0],
    open: n(row[1]),
    close: n(row[2]),
    high: n(row[3]),
    low: n(row[4]),
    volume: n(row[5]) === null ? null : n(row[5]) * volumeMultiplier,
  }));
  if (
    bars.some(
      (b) =>
        !/^\d{4}-\d{2}-\d{2}$/.test(b.date) ||
        [b.open, b.close, b.high, b.low].some((v) => v === null || v <= 0) ||
        b.high < Math.max(b.open, b.close, b.low) ||
        b.low > Math.min(b.open, b.close) ||
        b.volume === null ||
        b.volume < 0,
    )
  )
    throw new Error("历史行情字段或价格范围异常。");
  bars.sort((a, b) => a.date.localeCompare(b.date));
  if (new Set(bars.map((b) => b.date)).size !== bars.length)
    throw new Error("历史行情日期重复。");
  return bars;
}

export function parseEastmoneyHistory(payload, symbol) {
  const data = payload.data;
  if (
    payload.rc !== 0 ||
    data?.code !== symbol.slice(2) ||
    !Array.isArray(data.klines) ||
    !data.klines.length
  )
    throw new DataError("东方财富没有返回该股票的有效前复权日线。", "data");
  // Eastmoney: date, open, close, high, low, volume(lots), amount...
  const bars = parseHistory(
    {
      code: 0,
      data: {
        [symbol]: {
          qfqday: data.klines.map((row) => row.split(",").slice(0, 6)),
        },
      },
    },
    symbol,
  );
  return bars.slice(-180);
}

export async function fetchEastmoneyHistory(
  symbol,
  signal,
  asOf = chinaClock().date,
  onEvent,
) {
  if (!validSymbol(symbol)) throw new Error("无效股票代码。");
  const start = new Date(asOf + "T00:00:00Z");
  start.setUTCDate(start.getUTCDate() - 400);
  const url = new URL("https://push2his.eastmoney.com/api/qt/stock/kline/get");
  url.search = new URLSearchParams({
    secid: `${symbol.startsWith("sh") ? 1 : 0}.${symbol.slice(2)}`,
    klt: "101",
    fqt: "1",
    beg: start.toISOString().slice(0, 10).replaceAll("-", ""),
    end: asOf.replaceAll("-", ""),
    lmt: "180",
    fields1: "f1,f2,f3,f4,f5,f6",
    fields2: "f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61",
  }).toString();
  const payload = await historyClient.request(url, { signal, onEvent });
  return {
    symbol,
    bars: parseEastmoneyHistory(payload, symbol),
    source: "东方财富",
    adjustment: "前复权",
    fetchedAt: new Date().toISOString(),
  };
}

let baoUnavailableUntil = 0;
export const sinaProvider = createSinaHistoryProvider(parseHistory);
export function providerStatus() {
  return {
    sina: sinaProvider.status(),
    eastmoney: historyClient.status(),
    baostock: baoClient.status(),
    baoUnavailableUntil,
  };
}
export function restoreProviderStatus(saved) {
  if (!saved) return;
  if (saved.sina) sinaProvider.restore(saved.sina);
  historyClient.restore(saved.eastmoney);
  baoClient.restore(saved.baostock);
  if (Number.isFinite(saved.baoUnavailableUntil))
    baoUnavailableUntil = saved.baoUnavailableUntil;
}
export async function fetchHistory(
  symbol,
  signal,
  asOf = chinaClock().date,
  onEvent,
) {
  if (!validSymbol(symbol)) throw new DataError("无效股票代码。", "permanent");
  let sinaError;
  try {
    return await sinaProvider.fetchHistory(symbol, signal, asOf, onEvent);
  } catch (error) {
    if (signal?.aborted) throw signal.reason;
    sinaError = error;
  }
  let primaryError;
  if (Date.now() >= baoUnavailableUntil) {
    try {
      const payload = await baoClient.request(
        { symbol, asOf },
        { signal, onEvent },
      );
      const bars = parseBaoStock(payload, symbol, parseHistory);
      if (bars.at(-1)?.date !== asOf)
        throw new DataError("BaoStock 尚无目标交易日的日线。", "data");
      return {
        symbol,
        bars,
        source: "BaoStock",
        adjustment: "前复权",
        fetchedAt: new Date().toISOString(),
      };
    } catch (error) {
      if (signal?.aborted) throw signal.reason;
      primaryError =
        error instanceof DataError
          ? error
          : new DataError(error.message, "data");
      if (
        ["transient", "permanent", "blocked", "cooldown"].includes(error.kind)
      )
        baoUnavailableUntil = Math.max(Date.now() + 60000, error.retryAt || 0);
    }
  }
  try {
    return await fetchEastmoneyHistory(symbol, signal, asOf, onEvent);
  } catch (error) {
    if (signal?.aborted) throw signal.reason;
    if (primaryError)
      error.message = `BaoStock：${primaryError.message}；东方财富：${error.message}`;
    error.message = `新浪：${sinaError.message}；${error.message}`;
    // A valid primary response with missing per-stock data is not a global outage.
    if (primaryError?.kind === "data")
      throw new DataError(error.message, "data");
    throw error;
  }
}
