import test from "node:test";
import assert from "node:assert/strict";
import { defaults, validateConfig } from "../shared/rules.js";
import { analyzeBars, rsi14 } from "../server/indicators.js";
import {
  simulateStock,
  validateBacktest,
  summarizeTrades,
  forwardPerformance,
} from "../server/backtest.js";
import { archiveScan, compareRecords } from "../server/research.js";
import { summarizeJob } from "../server/scan-runner.js";
const bars = (length = 100) =>
  Array.from({ length }, (_, i) => ({
    date: new Date(Date.UTC(2026, 0, 1 + i)).toISOString().slice(0, 10),
    open: 100 + i,
    close: 101 + i,
    high: 102 + i,
    low: 99 + i,
    volume: 1000,
  }));
const stock = { symbol: "sh600000", code: "600000", name: "测试", amount: 5e8 };
const config = {
  ...defaults,
  strategy: "swing",
  priceAboveMa20: false,
  ma5AboveMa20: false,
};
test("old strategy configurations migrate without enabling new gates", () => {
  const cfg = validateConfig({ maxScan: 50 });
  assert.equal(cfg.useRsi, false);
  assert.equal(cfg.maxScan, 50);
  assert.throws(() => validateConfig({ minRsi: 80, maxRsi: 50 }));
  assert.throws(() => validateConfig({ ma20AboveMa60: "true" }));
});
test("advanced indicators use past highs and enough warmup; Wilder RSI boundaries", () => {
  const b = bars(80);
  const c = {
    ...config,
    ma20AboveMa60: true,
    breakout20: true,
    useBias: true,
    maxBias: 1,
  };
  const a = analyzeBars(b, b.at(-1).date, c);
  assert.equal(a.checks[0].pass, true);
  assert.equal(a.checks[1].pass, false);
  assert.equal(a.checks[2].pass, false);
  b.at(-1).close += 3;
  b.at(-1).high += 3;
  assert.equal(analyzeBars(b, b.at(-1).date, c).checks[1].pass, true);
  assert.equal(rsi14(b), 100);
  assert.equal(rsi14(b.map((x) => ({ ...x, close: 10 }))), 50);
  assert.throws(() => analyzeBars(b.slice(0, 30), b[29].date, c), /60/);
  const cutoff = b[70].date;
  assert.deepEqual(
    analyzeBars(b, cutoff, c),
    analyzeBars([...b.slice(0, 71), { ...b[71], close: 999999 }], cutoff, c),
  );
});
test("near-miss list excludes data failures and multiple failed technical conditions", () => {
  const evidence = { ...stock, checks: [{ pass: true }, { pass: false }] };
  const j = {
    target: 4,
    items: [
      { state: "unmatched", evidence },
      { state: "failed", stock, error: { message: "missing" }, evidence },
      {
        state: "unmatched",
        evidence: { ...evidence, checks: [{ pass: false }, { pass: false }] },
      },
      { state: "matched", result: stock },
    ],
  };
  summarizeJob(j);
  assert.equal(j.nearMiss.length, 1);
  assert.equal(j.failed, 1);
  assert.equal(j.results.length, 1);
});
test("backtest enters next bar, enforces holding period, costs and non-overlapping trades", () => {
  const b = bars(45),
    s = validateBacktest({ window: 30, hold: 5, costBps: 10, slippageBps: 5 });
  const r = simulateStock(stock, b, config, s, b.at(-1).date),
    t = r.trades[0];
  assert.equal(t.signalDate, b[19].date);
  assert.equal(t.entryDate, b[20].date);
  assert.equal(t.exitDate, b[24].date);
  const expected =
    ((((b[24].close * 0.9995) / (b[20].open * 1.0005)) * 0.999) / 1.001 - 1) *
    100;
  assert.ok(Math.abs(t.net - expected) < 1e-10);
  assert.ok(t.net < t.gross);
  for (let i = 1; i < r.trades.length; i++)
    assert.ok(r.trades[i].signalDate > r.trades[i - 1].exitDate);
  assert.throws(() => validateBacktest({ hold: 1 }));
  assert.throws(() => validateBacktest({ maxStocks: 101 }));
});
test("one-price entry is skipped, one-price exit delayed and incomplete trades not counted", () => {
  const b = bars(35),
    s = validateBacktest({ hold: 2, window: 30, costBps: 0, slippageBps: 0 });
  b[20] = { ...b[20], high: b[20].close, low: b[20].close };
  b[22] = { ...b[22], high: b[22].close, low: b[22].close };
  const r = simulateStock(stock, b, config, s, b.at(-1).date);
  assert.equal(r.skipped, 1);
  assert.equal(r.trades[0].entryDate, b[21].date);
  assert.equal(r.trades[0].exitDate, b[23].date);
  assert.equal(r.trades[0].delayed, 1);
  assert.ok(r.pending >= 1);
  const cutoff = b[30].date,
    r1 = simulateStock(stock, b, config, s, cutoff);
  b[34].close = 99999;
  assert.deepEqual(simulateStock(stock, b, config, s, cutoff), r1);
});
test("summary is per-event net return; empty sample has no manufactured percentage", () => {
  const result = summarizeTrades(
    [-2, 0, 1, 5].map((net) => ({ net, entryDate: "2026-01-01" })),
  );
  assert.equal(result.average, 1);
  assert.equal(result.median, 0.5);
  assert.equal(result.winRate, 50);
  assert.equal(result.worst, -2);
  assert.equal(result.months[0].count, 4);
  assert.equal(summarizeTrades([]).average, null);
});
test("forward performance uses same adjusted series and does not invent future returns", () => {
  const b = bars(30),
    r = forwardPerformance(stock, b, b[25].date, b[28].date);
  assert.equal(r.returns[5], null);
  assert.equal(r.returns[1].date, b[26].date);
  assert.equal(r.returns[1].pct, (b[26].close / b[25].close - 1) * 100);
  assert.throws(() =>
    forwardPerformance(stock, b, "2025-01-01", b.at(-1).date),
  );
});
test("scan archive is idempotent, bounded, and compares saved symbol sets", () => {
  const job = {
    id: "a",
    date: "2026-01-01",
    status: "completed",
    config,
    target: 300,
    done: 300,
    failed: 0,
    results: Array.from({ length: 250 }, (_, i) => ({
      ...stock,
      symbol: "s" + i,
    })),
    items: Array.from({ length: 300 }, (_, i) => ({
      stock: { ...stock, symbol: "s" + i },
    })),
  };
  let records = archiveScan([], job);
  assert.equal(records[0].results.length, 200);
  assert.equal(records[0].sampleCount, 300);
  assert.equal(records[0].samples.length, 200);
  records = archiveScan(records, { ...job, results: [stock] });
  assert.equal(records.length, 1);
  assert.equal(records[0].resultCount, 1);
  for (let i = 0; i < 40; i++)
    records = archiveScan(records, { ...job, id: "n" + i, results: [stock] });
  assert.equal(records.length, 30);
  const diff = compareRecords(
    { config, results: [stock] },
    { config, results: [{ ...stock, symbol: "sh600001" }] },
  );
  assert.equal(diff.added.length, 1);
  assert.equal(diff.removed.length, 1);
  assert.equal(diff.sameConfig, true);
});
