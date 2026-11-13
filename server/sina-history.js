import { createHistoryClient, DataError } from "./history-client.js";
import { validSymbol, numberOrNull as number } from "../shared/rules.js";

export const CALENDAR_URL =
  "https://quotes.sina.cn/cn/api/jsonp_v2.php/=/CN_MarketDataService.getKLineData?symbol=sh000001&scale=240&ma=no&datalen=200";

// Accept only the two known JSON wrappers. Never evaluate a downloaded script.
export function parseSinaJSONP(text) {
  const body = text.replace(/\/\*[\s\S]*?\*\//g, "").trim();
  const bars = /^=\(([\s\S]+)\);?$/.exec(body);
  if (bars) return JSON.parse(bars[1]);
  const factors = /^var\s+((?:sh|sz)\d{6})qfq\s*=\s*(\{[\s\S]*\});?$/.exec(
    body,
  );
  if (factors) return { ...JSON.parse(factors[2]), symbol: factors[1] };
  throw new DataError("新浪日线响应格式异常", "data");
}

export function parseSinaHistory(rows, factors, symbol, asOf, parseBars) {
  if (!Array.isArray(rows) || !rows.length || rows.length > 1023)
    throw new DataError("新浪没有返回有效日线", "data");
  if (
    factors?.symbol !== symbol ||
    !Array.isArray(factors.data) ||
    !factors.data.length ||
    factors.data.length !== Number(factors.total)
  )
    throw new DataError("新浪前复权因子缺失或股票不符", "data");
  const dated = factors.data.map(({ d, f }) => ({
    date: d,
    factor: number(f),
  }));
  if (
    dated.some(
      (x) =>
        !/^\d{4}-\d{2}-\d{2}$/.test(x.date) ||
        x.factor === null ||
        !Number.isFinite(x.factor) ||
        x.factor <= 0,
    ) ||
    new Set(dated.map((x) => x.date)).size !== dated.length
  )
    throw new DataError("新浪前复权因子日期或数值异常", "data");
  dated.sort((a, b) => a.date.localeCompare(b.date));
  const factorAt = (date) => dated.findLast((x) => x.date <= date)?.factor;
  const anchor = factorAt(asOf);
  if (!anchor) throw new DataError("新浪缺少截止日复权因子", "data");
  // Daily scale=240 reports shares. Use the same date-matched factor for all OHLC.
  const raw = parseBars(
    {
      code: 0,
      data: {
        [symbol]: {
          qfqday: rows.map((row) => [
            row.day,
            row.open,
            row.close,
            row.high,
            row.low,
            row.volume,
          ]),
        },
      },
    },
    symbol,
    1,
  );
  const bars = raw
    .filter((b) => b.date <= asOf && b.volume > 0)
    .map((b) => {
      const factor = factorAt(b.date);
      if (!factor) throw new DataError("新浪历史行缺少对应复权因子", "data");
      const ratio = anchor / factor;
      return {
        ...b,
        ...Object.fromEntries(
          ["open", "close", "high", "low"].map((k) => [
            k,
            Math.round(b[k] * ratio * 100) / 100,
          ]),
        ),
      };
    });
  if (bars.at(-1)?.date !== asOf)
    throw new DataError("新浪尚无目标交易日的有效日线", "data");
  // Validate again after adjustment, including prices that round to zero.
  return parseBars(
    {
      code: 0,
      data: {
        [symbol]: {
          qfqday: bars.map((b) => [
            b.date,
            b.open,
            b.close,
            b.high,
            b.low,
            b.volume,
          ]),
        },
      },
    },
    symbol,
    1,
  ).slice(-180);
}

export function createSinaHistoryProvider(parseBars, { client } = {}) {
  client ??= createHistoryClient({
    decode: parseSinaJSONP,
    referer: "https://finance.sina.com.cn/",
  });
  return {
    status: () => client.status(),
    restore: (saved) => client.restore(saved),
    // Index dates only: share the stock-history queue and denial protection.
    // The index never enters validSymbol(), adjustment factors or a stock pool.
    async fetchCalendar(signal, onEvent) {
      return {
        rows: await client.request(new URL(CALENDAR_URL), { signal, onEvent }),
        source: CALENDAR_URL,
        fetchedAt: new Date().toISOString(),
      };
    },
    async fetchHistory(symbol, signal, asOf, onEvent) {
      if (!validSymbol(symbol) || !/^\d{4}-\d{2}-\d{2}$/.test(asOf))
        throw new DataError("无效股票或日线截止日期", "permanent");
      const url = new URL(
        "https://quotes.sina.cn/cn/api/jsonp_v2.php/=/CN_MarketDataService.getKLineData",
      );
      url.search = new URLSearchParams({
        symbol,
        scale: "240",
        ma: "no",
        datalen: "200",
      }).toString();
      const rows = await client.request(url, { signal, onEvent });
      const factors = await client.request(
        `https://finance.sina.com.cn/realstock/company/${symbol}/qfq.js`,
        { signal, onEvent },
      );
      return {
        symbol,
        bars: parseSinaHistory(rows, factors, symbol, asOf, parseBars),
        source: "新浪财经",
        adjustment: "前复权",
        fetchedAt: new Date().toISOString(),
      };
    },
  };
}
