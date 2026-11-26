import test from "node:test";
import assert from "node:assert/strict";
import { dpoDefaults, validateDpo } from "../shared/dpo-rules.js";
import {
  dpoSeries,
  dpoSignals,
  replayDpo,
  analyzeDpo,
  summarizeDpo,
} from "../server/dpo-analysis.js";
import { Dpo } from "../server/dpo.js";
import { Store } from "../server/store.js";

const cfg = validateDpo({ window: 30 });
const bars = (n = 120) =>
  Array.from({ length: n }, (_, i) => {
    const close = 30 + Math.sin(i / 4) * 2 + i * 0.02;
    return {
      date: new Date(Date.UTC(2026, 6, 1 + i)).toISOString().slice(0, 10),
      open: close,
      close,
      high: close + 1,
      low: close - 1,
      volume: 10000,
    };
  });
const stock = {
  symbol: "sh600000",
  code: "600000",
  name: "合成样本",
  price: 30,
  amount: 4e8,
  volume: 1e6,
  board: "main",
};
test("DPO(20,10,6) matches independently summed lagged mean and six-point mean", () => {
  const b = bars(),
    p = dpoSeries(b, cfg),
    i = 45;
  const blue = (j) =>
    b[j].close - b.slice(j - 29, j - 9).reduce((s, x) => s + x.close, 0) / 20;
  assert.equal(p[28].dpo, null);
  assert.equal(p[29].dpo, blue(29));
  assert.equal(p[33].average, null);
  assert.ok(Math.abs(p[i].dpo - blue(i)) < 1e-12);
  assert.ok(
    Math.abs(
      p[i].average -
        Array.from({ length: 6 }, (_, j) => blue(i - j)).reduce(
          (s, v) => s + v,
          0,
        ) /
          6,
    ) < 1e-12,
  );
});
test("every indicator and signal prefix is stable when future bars are appended", () => {
  const b = bars(),
    p = dpoSeries(b, cfg),
    s = dpoSignals(b, p, cfg);
  for (let n = 40; n <= b.length; n++) {
    const prefix = b.slice(0, n),
      pp = dpoSeries(prefix, cfg);
    assert.deepEqual(pp, p.slice(0, n));
    assert.deepEqual(dpoSignals(prefix, pp, cfg), s.slice(0, n));
  }
  const a = analyzeDpo(stock, b, b.at(-1).date, cfg);
  assert.deepEqual(
    analyzeDpo(
      stock,
      [...b, { ...b.at(-1), date: "2027-01-01", close: 999 }],
      b.at(-1).date,
      cfg,
    ),
    a,
  );
});
test("gold cross only observes; later retest and upward confirmation enter exactly once", () => {
  const gaps = [-1, -1, 1, 0.2, 0.05, 0.1, 0.3, 0.2, 0.1, 0.2];
  const b = bars(gaps.length).map((x) => ({ ...x, close: 100 }));
  const p = gaps.map((gap, i) => ({
    date: b[i].date,
    dpo: gap,
    average: 0,
    gap,
  }));
  const c = validateDpo({ belowBars: 2, tolerancePct: 0.3 }),
    s = dpoSignals(b, p, c);
  assert.equal(s[2].stage, "cross");
  assert.equal(s[2].signal, false);
  assert.equal(s[4].stage, "retest");
  assert.equal(s[5].signal, true);
  assert.equal(s.filter((x) => x.signal).length, 1);
  const broken = p.map((x) => ({ ...x }));
  broken[4].gap = -0.01;
  assert.equal(dpoSignals(b, broken, c)[5].signal, false);
  const expired = dpoSignals(b, p, { ...c, watchBars: 2 });
  assert.equal(expired[5].signal, false);
});
function replayFixture() {
  const b = bars(8).map((x, i) => ({
    ...x,
    open: 100 + i * 2,
    close: 101 + i * 2,
    high: 104 + i * 2,
    low: 98 + i * 2,
  }));
  const p = b.map((x, i) => ({
    date: x.date,
    dpo: i === 2 ? 0 : i,
    average: -1,
    gap: 1,
  }));
  const signals = b.map((x, i) => ({
    signal: i === 0,
    crossDate: x.date,
    touchDate: x.date,
  }));
  return { b, p, signals };
}
test("entry and signal exit use next opens, T+1, independent cost math, no forced terminal liquidation", () => {
  const { b, p, signals } = replayFixture(),
    r = replayDpo(stock, b, p, signals, cfg, 0),
    t = r.trades[0];
  assert.equal(t.entryDate, b[1].date);
  assert.equal(t.exitSignalDate, b[2].date);
  assert.equal(t.exitDate, b[3].date);
  assert.equal(t.holdBars, 2);
  const expected =
    ((b[3].open * 0.9995 * 0.999) / (b[1].open * 1.0005 * 1.001) - 1) * 100;
  assert.ok(Math.abs(t.net - expected) < 1e-10);
  const pending = replayDpo(
    stock,
    b.slice(0, 3),
    p.slice(0, 3),
    signals.slice(0, 3),
    cfg,
    0,
  );
  assert.equal(pending.trades.length, 0);
  assert.equal(pending.pending[0].state, "待退出");
});
test("entry-day closing exit trigger still exits on following day, limit bars skip/delay, pending distinct", () => {
  const { b, p, signals } = replayFixture();
  p[1].dpo = -1;
  assert.equal(
    replayDpo(stock, b, p, signals, cfg, 0).trades[0].exitDate,
    b[2].date,
  );
  b[1].high = b[1].low = b[1].open;
  assert.equal(replayDpo(stock, b, p, signals, cfg, 0).skipped, 1);
  const f = replayFixture();
  f.b[3].high = f.b[3].low = f.b[3].open;
  assert.equal(
    replayDpo(stock, f.b, f.p, f.signals, cfg, 0).trades[0].delayed,
    1,
  );
  const pending = replayDpo(
    stock,
    f.b.slice(0, 1),
    f.p.slice(0, 1),
    f.signals.slice(0, 1),
    cfg,
    0,
  );
  assert.equal(pending.pending[0].state, "待入场");
});
test("closing stop and time limit trigger next open, closed trades never overlap", () => {
  const f = replayFixture();
  f.p = f.p.map((p, i) => ({ ...p, dpo: i }));
  f.b[2].close = 80;
  f.b[2].low = 79;
  const stop = replayDpo(stock, f.b, f.p, f.signals, cfg, 0).trades[0];
  assert.equal(stop.reason, "收盘止损");
  assert.equal(stop.exitDate, f.b[3].date);
  f.b[2].close = 105;
  const timed = replayDpo(stock, f.b, f.p, f.signals, { ...cfg, maxHold: 2 }, 0)
    .trades[0];
  assert.equal(timed.reason, "持有上限");
  f.signals = f.signals.map((x) => ({ ...x, signal: true }));
  const r = replayDpo(stock, f.b, f.p, f.signals, { ...cfg, maxHold: 2 }, 0);
  for (let i = 1; i < r.trades.length; i++)
    assert(r.trades[i].signalDate > r.trades[i - 1].exitDate);
});
test("strict history/window and numeric config reject malformed or insufficient inputs", () => {
  const b = bars();
  assert.throws(
    () => analyzeDpo(stock, b.slice(-60), b.at(-1).date, cfg),
    /不足/,
  );
  assert.throws(
    () => analyzeDpo(stock, [...b, b.at(-1)], b.at(-1).date, cfg),
    /异常/,
  );
  assert.throws(
    () => analyzeDpo(stock, b.slice(0, -1), b.at(-1).date, cfg),
    /截止日/,
  );
  for (const value of [-1, 0, 201, 1.5, "x"])
    assert.throws(() => validateDpo({ maxStocks: value }));
  assert.deepEqual(validateDpo(), dpoDefaults);
  assert.equal(summarizeDpo([]).average, null);
  assert.equal(summarizeDpo([]).worstTradeDrawdown, null);
});
function serviceFixture() {
  const b = bars(),
    date = b.at(-1).date,
    writes = [];
  const s = {
    market: {
      date,
      stocks: [
        { ...stock, quoteDate: date },
        {
          ...stock,
          symbol: "sz000001",
          code: "000001",
          quoteDate: date,
          amount: 3e8,
        },
      ],
    },
    daily: { active: false, assertBackgroundAllowed() {} },
    running: () => false,
    refresh: { running: false },
    research: { active: false },
    checkResources: async () => {},
    history: async () => ({
      symbol: stock.symbol,
      bars: b,
      source: "合成测试",
      adjustment: "前复权",
      fetchedAt: "2026-11-13T08:30:00Z",
      fromCache: true,
    }),
  };
  const d = new Dpo(s, {
    read: async () => null,
    write: async (k, v) => writes.push([k, structuredClone(v)]),
  });
  return { d, s, writes };
}
test("separate DPO cache, summaries, paged rows and export preserve all other task state", async () => {
  const { d, s, writes } = serviceFixture(),
    before = structuredClone(s.market);
  await d.start({ window: 30, maxStocks: 2 });
  await d.task;
  assert.equal(d.job.status, "completed");
  assert.equal(d.job.done, 2);
  assert.equal(d.job.cacheHits, 2);
  assert(writes.every(([k]) => k === "last-dpo"));
  assert.deepEqual(s.market, before);
  assert.equal(d.state().job.items, undefined);
  assert.equal(d.state().job.summary.stocks, 2);
  assert.equal(d.rows(new URLSearchParams("view=stocks")).total, 2);
  assert.equal(d.export().evidence.length, 2);
  assert.equal(d.detail(stock.symbol).inputHash.length, 64);
  assert.throws(() => d.rows(new URLSearchParams("page=1.1")));
});
test("concurrent starts are rejected; stopping preserves pending then resume; failed retries do not duplicate", async () => {
  const { d, s } = serviceFixture();
  let release;
  const original = s.history;
  s.history = async (...args) => {
    await new Promise((r) => {
      release = r;
    });
    return original(...args);
  };
  await d.start({ window: 30, maxStocks: 2 });
  await assert.rejects(d.start(), /等待/);
  d.stop();
  release();
  await d.task;
  assert.equal(d.job.pending, 2);
  assert.equal(d.job.status, "stopped");
  s.history = original;
  await d.continue("resume");
  await d.task;
  assert.equal(d.job.done, 2);
  const second = serviceFixture();
  second.s.history = async () => {
    throw Error("测试数据缺失");
  };
  await second.d.start({ window: 30, maxStocks: 2 });
  await second.d.task;
  assert.equal(second.d.job.failed, 2);
  second.s.history = original;
  await second.d.continue("retry");
  await second.d.task;
  assert.equal(second.d.job.failed, 0);
  assert.equal(second.d.job.summary.stocks, 2);
});
test("insufficient histories remain failures, unrelated busy work prevents start, restart recovers unfinished state", async () => {
  const { d, s, writes } = serviceFixture();
  s.research.active = true;
  await assert.rejects(d.start(), /等待/);
  s.research.active = false;
  s.history = async () => ({ bars: bars(30), adjustment: "前复权" });
  await d.start({ maxStocks: 1 });
  await d.task;
  assert.equal(d.job.failed, 1);
  assert.equal(d.job.summary.stocks, 0);
  const saved = structuredClone(writes.at(-1)[1]);
  saved.status = "running";
  saved.items[0].state = "running";
  const recovered = new Dpo(s, {
    read: async () => saved,
    write: async () => {},
  });
  await recovered.init();
  assert.equal(recovered.job.status, "paused");
  assert.equal(recovered.job.pending, 1);
});
test("equal lines are not consecutive bars below the signal line", () => {
  const b = bars(8).map((x) => ({ ...x, close: 100 })),
    gaps = [0, 0, 0, 0, 0, 1, 0.05, 0.2];
  const p = gaps.map((gap, i) => ({
    date: b[i].date,
    dpo: gap,
    average: 0,
    gap,
  }));
  assert.equal(
    dpoSignals(b, p, validateDpo()).filter((x) => x.signal).length,
    0,
  );
  assert.equal(dpoSignals(b, p, validateDpo())[5].stage, "none");
});

test("market refresh reserves startup before async resource check; concurrent DPO is blocked", async () => {
  const fixture = serviceFixture(),
    s = new Store();
  s.eod = fixture.s.market;
  s.daily = { active: false, assertBackgroundAllowed() {} };
  let release;
  s.checkResources = () =>
    new Promise((resolve) => {
      release = resolve;
    });
  s.performRefresh = async () => {
    s.refresh.running = false;
  };
  const refreshing = s.startRefresh();
  assert.equal(s.refresh.running, true);
  await assert.rejects(s.dpo.start({ window: 30 }), /等待/);
  release();
  await refreshing;
  await s.refreshTask;
  assert.equal(s.dpo.active, false);
  s.checkResources = async () => {
    throw Error("资源不足");
  };
  s.lastRefreshAttempt = 0;
  await assert.rejects(s.startRefresh(), /资源不足/);
  assert.equal(s.refresh.running, false);
});
