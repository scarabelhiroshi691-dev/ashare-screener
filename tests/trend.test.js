import test from "node:test";
import assert from "node:assert/strict";
import { analyzeTrend } from "../server/trend-analysis.js";
import { validateTrend, trendDefaults } from "../shared/trend-rules.js";
import { Trend } from "../server/trend.js";
import { trendCSV } from "../src/trend-export.js";

const bars = (n = 180, price = (i) => 20 * Math.exp(i * 0.002)) =>
  Array.from({ length: n }, (_, i) => {
    const close = price(i),
      date = new Date(Date.UTC(2026, 0, 1 + i)).toISOString().slice(0, 10);
    return {
      date,
      close,
      open: close,
      high: close * 1.01,
      low: close * 0.99,
      volume: 10000 + i,
    };
  });
const cfg = validateTrend(),
  history = bars(),
  date = history.at(-1).date;
const stock = {
  symbol: "sh600000",
  code: "600000",
  name: "测试股票",
  quoteDate: date,
  board: "main",
  price: 30,
  amount: 4e8,
  volume: 100000,
  source: "测试",
};
test("stable exponential trend has analytically known fit, path efficiency, return and drawdown", () => {
  const a = analyzeTrend(history, date, cfg),
    m = a.metrics;
  assert(a.passed);
  assert(Math.abs(m.fit - 1) < 1e-12);
  assert.equal(m.efficiency, 100);
  assert.equal(m.maxDrawdown, 0);
  assert.equal(m.above, 100);
  assert(Math.abs(m.windowReturn - (Math.exp(119 * 0.002) - 1) * 100) < 1e-10);
  assert(Math.abs(m.score - 100) < 1e-10);
  assert(m.ma20 > m.ma60 && m.ma60 > m.ma120);
});
test("flat, oscillating and falling histories cannot be stable uptrend matches", () => {
  for (const price of [
    () => 20,
    (i) => 20 + Math.sin(i) * 2,
    (i) => 50 * Math.exp(-0.002 * i),
  ]) {
    const a = analyzeTrend(bars(180, price), date, cfg);
    assert(!a.passed);
    assert(Number.isFinite(a.metrics.score));
    assert(a.metrics.score >= 0 && a.metrics.score <= 100);
  }
});
test("drawdown is measured from running closing peak and a damaged path fails", () => {
  const b = bars(180, (i) =>
    i === 177 ? 200 : i === 178 ? 150 : i === 179 ? 180 : 100 + i * 0.1,
  );
  const a = analyzeTrend(b, date, cfg);
  assert.equal(a.metrics.maxDrawdown, 25);
  assert(!a.passed);
  assert.equal(a.checks.find((c) => c.label.includes("回撤")).pass, false);
});
test("inclusive trend thresholds, 60 bar window with 120 warmup, and future data isolation", () => {
  const a = analyzeTrend(history, date, cfg),
    m = a.metrics;
  assert(
    analyzeTrend(history, date, {
      ...cfg,
      minReturn: m.windowReturn,
      maxDrawdown: m.maxDrawdown,
      minFit: m.fit,
      minEfficiency: m.efficiency,
      minAbove: m.above,
      maxBias: m.bias,
    }).passed,
  );
  assert(
    !analyzeTrend(history, date, { ...cfg, maxBias: m.bias - 0.00001 }).passed,
  );
  const shorter = analyzeTrend(history, date, { ...cfg, lookback: 60 });
  assert.equal(shorter.metrics.windowBars, 60);
  const future = { ...history.at(-1), date: "2027-01-01", close: 99999 };
  assert.deepEqual(analyzeTrend([...history, future], date, cfg), a);
  assert.throws(() => analyzeTrend(history.slice(-119), date, cfg), /120/);
  assert.throws(() => analyzeTrend(history.slice(0, -1), date, cfg), /目标/);
  assert.throws(
    () => analyzeTrend([...history, history.at(-1)], date, cfg),
    /异常/,
  );
});
test("trend settings reject bad input and cannot overwrite fixed simulation fields", () => {
  assert.deepEqual(validateTrend({ maxScan: 2000 }), {
    ...trendDefaults,
    maxScan: 2000,
  });
  assert.deepEqual(
    validateTrend({ hold: 1, ruleHash: "changed" }),
    trendDefaults,
  );
  for (const input of [
    null,
    [],
    { maxScan: 2001 },
    { maxScan: 1.5 },
    { minFit: 1.1 },
    { lookback: 119 },
    { maxDrawdown: -1 },
    { minReturn: "" },
  ])
    assert.throws(() => validateTrend(input));
});

function harness() {
  const data = new Map(),
    calls = [];
  const store = {
    market: { date, fetchedAt: date + "T08:00:00Z", stocks: [stock] },
    running: () => false,
    refresh: { running: false },
    research: { active: false },
    daily: { active: false },
    checkResources: async () => {},
    history: async (symbol) => {
      calls.push(symbol);
      return {
        symbol,
        bars: history,
        adjustment: "前复权",
        source: "测试源",
        fetchedAt: date + "T08:00:00Z",
        fromCache: false,
      };
    },
  };
  const deps = {
    read: async (key) => structuredClone(data.get(key) || null),
    write: async (key, value) => {
      data.set(key, structuredClone(value));
    },
  };
  return { store, deps, data, calls };
}
test("trend job freezes pool/config, isolates data failures and can retry without duplicating successes", async () => {
  const h = harness(),
    second = { ...stock, symbol: "sh600036", code: "600036" };
  h.store.market.stocks.push(second);
  const original = h.store.history;
  let broken = true;
  h.store.history = async (s) => {
    if (s === second.symbol && broken) throw Error("历史不足");
    return original(s);
  };
  const t = new Trend(h.store, h.deps);
  await t.init();
  await t.start({ maxScan: 2000 });
  await t.task;
  assert.equal(t.job.done, 2);
  assert.equal(t.job.failed, 1);
  assert.equal(t.job.results.length, 1);
  h.store.market.stocks = [];
  broken = false;
  await t.continue("retry");
  await t.task;
  assert.equal(t.job.results.length, 2);
  assert.equal(t.job.target, 2);
  assert.equal(t.job.config.maxScan, 2000);
  assert.equal(t.job.config.lookback, 120);
  assert.equal(h.calls.filter((s) => s === stock.symbol).length, 1);
  assert.equal(t.state().job.unmatchedResults.length, 0);
});
test("trend stop/restart/resume retains work and honors cross-task locks", async () => {
  const h = harness(),
    t = new Trend(h.store, h.deps);
  await t.init();
  let release;
  h.store.history = () =>
    new Promise((resolve) => {
      release = resolve;
    });
  await t.start({});
  for (let i = 0; i < 20 && !release; i++)
    await new Promise((r) => setImmediate(r));
  assert.equal(t.job.pending, 1);
  await assert.rejects(t.start({}), /等待/);
  t.stop();
  release({ bars: history, source: "测试" });
  await t.task;
  assert.equal(t.job.pending, 1);
  assert.equal(t.job.results.length, 0);
  const restored = new Trend(h.store, h.deps);
  await restored.init();
  h.store.research.active = true;
  await assert.rejects(restored.continue("resume"), /等待/);
  h.store.research.active = false;
  h.store.history = async () => ({
    bars: history,
    source: "测试",
    fetchedAt: date + "T08:00:00Z",
  });
  await restored.continue("resume");
  await restored.task;
  assert.equal(restored.job.done, 1);
  assert.equal(restored.job.results.length, 1);
});
test("trend reuses only target-day completed adjusted cache, and save failure prevents reads", async () => {
  const h = harness(),
    t = new Trend(h.store, h.deps);
  await t.init();
  h.data.set(`history/${stock.symbol}-${date}`, {
    symbol: stock.symbol,
    bars: history,
    source: "测试缓存",
    adjustment: "前复权",
    fetchedAt: date + "T08:00:00Z",
  });
  await t.start({});
  await t.task;
  assert.equal(h.calls.length, 0);
  assert.equal(t.job.cacheHits, 1);
  const detail = await t.detail(stock.symbol, date);
  assert.equal(detail.source, "测试缓存");
  assert.equal(detail.bars.at(-1).ma120, t.job.results[0].metrics.ma120);
  await assert.rejects(t.detail("sh601398", date), /当前/);
  const bad = new Trend(h.store, {
    ...h.deps,
    write: async () => {
      throw Error("磁盘失败");
    },
  });
  await bad.init();
  await assert.rejects(bad.start({}), /磁盘/);
  assert(!bad.active);
  assert.equal(h.calls.length, 0);
});
test("trend export preserves the frozen settings, every matched row, leading-zero codes and formula safety", () => {
  const a = analyzeTrend(history, date, cfg);
  const results = Array.from({ length: 25 }, (_, i) => ({
    ...stock,
    symbol: "sz000001",
    code: "000001",
    name: i === 0 ? "=CMD()" : "普通股票",
    metrics: a.metrics,
    historySource: "测试源",
    historyFetchedAt: date + "T08:00:00Z",
  }));
  const csv = trendCSV({ date, config: cfg, status: "completed", results });
  assert(csv.startsWith("\ufeff"));
  assert.equal(csv.split("\r\n").length, 29);
  assert(csv.includes('"000001.SZ"'));
  assert(csv.includes('"\'=CMD()"'));
  assert(csv.includes('"最大收盘回撤%"'));
  assert(csv.includes('"120"'));
  assert(csv.includes("completed"));
});

test("trend rejects pre-close, unadjusted, wrong-stock and future-ended historical caches", async () => {
  for (const patch of [
    { adjustment: "不复权" },
    { symbol: "sh600036" },
    { fetchedAt: date + "T06:00:00Z" },
    { bars: [...history, { ...history.at(-1), date: "2027-01-01" }] },
  ]) {
    const h = harness(),
      t = new Trend(h.store, h.deps);
    h.data.set(`history/${stock.symbol}-${date}`, {
      symbol: stock.symbol,
      bars: history,
      source: "bad-cache",
      adjustment: "前复权",
      fetchedAt: date + "T08:00:00Z",
      ...patch,
    });
    await t.init();
    await t.start({});
    await t.task;
    assert.equal(h.calls.length, 1);
    assert.equal(t.job.cacheHits, 0);
    assert.equal(t.job.results[0].historySource, "测试源");
  }
});
