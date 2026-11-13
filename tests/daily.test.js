import test from "node:test";
import assert from "node:assert/strict";
import { dailyPlans } from "../shared/daily-plans.js";
import {
  registerSignal,
  advanceTicket,
  paperStats,
} from "../server/paper-ledger.js";
import { Daily, canRegisterDay } from "../server/daily.js";

const stamp = (d) => new Date(d + "T16:30:00+08:00");
const stock = {
  symbol: "sh600900",
  code: "600900",
  name: "测试股票",
  board: "main",
  quoteDate: "2026-10-30",
  price: 20,
  amount: 3e8,
  volume: 1e6,
  changePct: 3,
  turnover: 5,
};
const plan = { ...structuredClone(dailyPlans[0]), ruleHash: "frozen" };
const bars = [
  "2026-10-30",
  "2026-11-02",
  "2026-11-03",
  "2026-11-04",
  "2026-11-05",
].map((date, i) => ({
  date,
  open: 10 + i,
  close: 10.5 + i,
  high: 11 + i,
  low: 9 + i,
  volume: 100,
}));
const signal = () =>
  registerSignal(
    [],
    plan,
    stock,
    "2026-10-30",
    stamp("2026-10-30").toISOString(),
    [],
    "A",
  );
test("paper ledger: genuine registration precedes entry, 3 effective bars, costs and no future data", () => {
  const t = signal(),
    history = { source: "A", bars };
  assert.equal(advanceTicket(t, history, "2026-10-30").state, "pending");
  const holding = advanceTicket(t, history, "2026-11-02");
  assert.equal(holding.entryDate, "2026-11-02");
  assert.equal(holding.holdBars, 1);
  assert.equal(holding.state, "holding");
  assert.equal(holding.net, null);
  const closed = advanceTicket(holding, history, "2026-11-04");
  assert.equal(closed.state, "closed");
  assert.equal(closed.holdBars, 3);
  assert.equal(closed.exitDate, "2026-11-04");
  const expected =
    ((((13.5 * 0.9995) / (11 * 1.0005)) * 0.999) / 1.001 - 1) * 100;
  assert(Math.abs(expected - closed.net) < 1e-10);
  assert(closed.net < closed.gross);
  assert.deepEqual(
    advanceTicket(closed, { source: "B", bars: [] }, "2026-11-05"),
    closed,
  );
  assert.throws(
    () =>
      registerSignal(
        [],
        plan,
        stock,
        "2026-10-29",
        stamp("2026-10-30").toISOString(),
        [],
        "A",
      ),
    /当天/,
  );
  assert.equal(
    registerSignal(
      [t],
      plan,
      stock,
      "2026-10-30",
      stamp("2026-10-30").toISOString(),
      [],
      "A",
    ),
    null,
  );
  assert.equal(
    registerSignal(
      [holding],
      plan,
      stock,
      "2026-11-02",
      stamp("2026-11-02").toISOString(),
      [],
      "A",
    ),
    null,
  );
  assert(
    registerSignal(
      [closed],
      plan,
      stock,
      "2026-11-04",
      stamp("2026-11-04").toISOString(),
      [],
      "A",
    ),
  );
  assert.throws(
    () => advanceTicket(holding, { source: "B", bars }, "2026-11-03"),
    /来源改变/,
  );
});
test("one-price entry skips, one-price exit waits; suspension gaps do not fabricate bars", () => {
  const flat = structuredClone(bars);
  Object.assign(flat[1], { high: 11, low: 11 });
  assert.equal(
    advanceTicket(signal(), { source: "A", bars: flat }, "2026-11-02").state,
    "skipped",
  );
  const delayed = structuredClone(bars);
  Object.assign(delayed[3], { high: 13, low: 13 });
  const wait = advanceTicket(
    signal(),
    { source: "A", bars: delayed },
    "2026-11-04",
  );
  assert.equal(wait.state, "exit-wait");
  assert.equal(wait.net, null);
  const exit = advanceTicket(
    wait,
    { source: "A", bars: delayed },
    "2026-11-05",
  );
  assert.equal(exit.delayed, 1);
  assert.equal(exit.holdBars, 4);
  const gap = bars.filter((b) => b.date !== "2026-11-03");
  const held = advanceTicket(
    signal(),
    { source: "A", bars: gap },
    "2026-11-04",
  );
  assert.equal(held.state, "holding");
  assert.equal(held.holdBars, 2);
});
test("only closed genuine forward events enter statistics; unknown profitability stays null", () => {
  const s = paperStats([signal()], [plan])[0];
  assert.equal(s.average, null);
  assert.equal(s.count, 0);
  assert.equal(s.pending, 1);
  const closed = advanceTicket(signal(), { source: "A", bars }, "2026-11-04");
  const stats = paperStats([closed], [plan])[0];
  assert.equal(stats.count, 1);
  assert.equal(stats.uniqueStocks, 1);
  assert.match(stats.assessment, /样本仍少/);
});
function harness({
  date = "2026-10-30",
  clock = "2026-10-30",
  minutes = 16,
  broken = false,
} = {}) {
  let disk = null,
    now = new Date(`${clock}T${minutes}:30:00+08:00`),
    calls = 0;
  const history = [];
  for (let i = 0; i < 100; i++) {
    const day = new Date(Date.UTC(2026, 5, 1 + i));
    if ([0, 6].includes(day.getUTCDay())) continue;
    const v = 10 + history.length * 0.05;
    history.push({
      date: day.toISOString().slice(0, 10),
      open: v,
      close: v,
      high: v + 0.1,
      low: v - 0.1,
      volume: 100,
    });
  }
  // A flat ending period makes short-volume and swing-MA rules pass with bias below 3%.
  const last = history.at(-1).close;
  history.push(
    ...[
      "2026-10-01",
      "2026-10-02",
      "2026-10-05",
      "2026-10-06",
      "2026-10-07",
      "2026-10-08",
      "2026-10-09",
      "2026-10-12",
      "2026-10-13",
      "2026-10-14",
      "2026-10-15",
      "2026-10-16",
      "2026-10-19",
      "2026-10-20",
      "2026-10-21",
      "2026-10-22",
      "2026-10-23",
      "2026-10-26",
      "2026-10-27",
      "2026-10-28",
      "2026-10-29",
      "2026-10-30",
    ].map((date, i) => ({
      date,
      open: last + 0.01 * i,
      close: last + 0.01 * i,
      high: last + 0.1 + 0.01 * i,
      low: last - 0.1 + 0.01 * i,
      volume: i === 21 ? 150 : 100,
    })),
  );
  const store = {
    running: () => false,
    refresh: { running: false },
    research: { active: false },
    market: {
      date,
      stocks: [{ ...stock, quoteDate: date }],
      fetchedAt: now.toISOString(),
    },
    checkResources: async () => {},
    startRefresh: async () => {},
    history: async () => {
      calls++;
      if (broken) throw Object.assign(Error("临时断线"), { kind: "transient" });
      return { source: "A", bars: history };
    },
    stopRefresh: () => {},
  };
  const deps = {
    read: async () => structuredClone(disk),
    write: async (k, v) => {
      disk = structuredClone(v);
    },
    now: () => now,
  };
  return {
    store,
    deps,
    get calls() {
      return calls;
    },
    setNow: (d) => (now = stamp(d)),
    setBroken: (b) => (broken = b),
    get disk() {
      return disk;
    },
  };
}
test("activation is immutable/idempotent and daily same-day rerun cannot duplicate signals or rewrite pool", async () => {
  const h = harness(),
    d = new Daily(h.store, h.deps);
  await d.init();
  await d.activate();
  const original = structuredClone(d.data.plans);
  await d.activate();
  assert.deepEqual(d.data.plans, original);
  await d.start();
  await d.task;
  assert.equal(d.data.days.length, 1);
  assert.equal(d.data.job.status, "completed");
  assert.equal(d.data.tickets.length, 2);
  assert(d.data.days[0].plans.every((p) => p.items[0].state === "matched"));
  h.store.market.stocks.push({ ...stock, symbol: "sh600036", code: "600036" });
  await d.start();
  await d.task;
  assert.equal(d.data.days[0].plans[0].items.length, 1);
  assert.equal(d.data.tickets.length, 2);
  const restarted = new Daily(h.store, h.deps);
  await restarted.init();
  assert.deepEqual(restarted.data.plans, original);
  assert.equal(restarted.data.tickets.length, 2);
});
test("stale/pre-close dates do not enroll historical selections, failed stocks can retry today", async () => {
  const h = harness({ date: "2026-10-29" }),
    d = new Daily(h.store, h.deps);
  await d.init();
  await d.activate();
  await d.start();
  await d.task;
  assert.equal(d.data.job.status, "waiting");
  assert.equal(d.data.days.length, 0);
  assert.equal(d.data.tickets.length, 0);
  assert(
    !canRegisterDay(
      "2026-10-30",
      "2026-10-30",
      new Date("2026-10-30T14:00:00+08:00"),
    ),
  );
  assert(!canRegisterDay("2026-10-30", "2026-10-31", stamp("2026-10-30")));
  assert(!canRegisterDay("2026-10-31", "2026-10-30", stamp("2026-10-31")));
  const f = harness({ broken: true }),
    retry = new Daily(f.store, f.deps);
  await retry.init();
  await retry.activate();
  await retry.start();
  await retry.task;
  assert.equal(retry.data.tickets.length, 0);
  assert.equal(retry.data.days[0].plans[0].items[0].state, "failed");
  f.setBroken(false);
  await retry.start();
  await retry.task;
  assert.equal(retry.data.tickets.length, 2);
  assert.equal(retry.data.days[0].plans[0].items[0].attempts, 2);
});
test("automatic run attempts once per day, weekends skip, write failure rolls back", async () => {
  const h = harness(),
    d = new Daily(h.store, h.deps);
  await d.init();
  await d.activate();
  await d.tick();
  await d.task;
  const calls = h.calls;
  await d.tick();
  assert.equal(h.calls, calls);
  h.setNow("2026-10-31");
  await d.tick();
  assert.equal(h.calls, calls);
  const bad = new Daily(h.store, {
    ...h.deps,
    write: async () => {
      throw Error("磁盘失败");
    },
  });
  await bad.init();
  const before = structuredClone(bad.data);
  bad.data.tickets.push(signal());
  await assert.rejects(bad.persist(), /磁盘失败/);
  assert.deepEqual(bad.data, before);
});

test("cancellation retains pending work, cross-day retries never enroll expired signals", async () => {
  const h = harness(),
    d = new Daily(h.store, h.deps);
  await d.init();
  await d.activate();
  let release;
  h.store.history = () => new Promise((resolve) => (release = resolve));
  await d.start();
  for (let i = 0; i < 30 && !release; i++)
    await new Promise((r) => setImmediate(r));
  assert(release);
  d.stop();
  release({ source: "A", bars: [] });
  await d.task;
  assert.equal(d.data.job.status, "stopped");
  assert.equal(d.data.tickets.length, 0);
  assert.equal(d.data.days[0].plans[0].items[0].state, "failed");
  h.setNow("2026-11-02");
  await d.start();
  await d.task;
  assert.equal(d.data.days.length, 1);
  assert.equal(d.data.tickets.length, 0);
  assert.equal(d.data.job.status, "waiting");
  const pre = harness({ minutes: 14 }),
    beforeClose = new Daily(pre.store, pre.deps);
  await beforeClose.init();
  await beforeClose.activate();
  await beforeClose.start();
  await beforeClose.task;
  assert.equal(pre.calls, 0);
  assert.equal(beforeClose.data.days.length, 0);
});

test("third consecutive outage is counted even when it pauses the daily task", async () => {
  const h = harness({ broken: true });
  h.store.market.stocks = [
    stock,
    { ...stock, symbol: "sh600036", code: "600036" },
    { ...stock, symbol: "sh601398", code: "601398" },
  ];
  const d = new Daily(h.store, h.deps);
  await d.init();
  await d.activate();
  await d.start();
  await d.task;
  assert.equal(d.data.job.status, "stopped");
  assert.equal(d.data.job.errors.length, 3);
  assert.equal(d.data.job.done, 3);
  assert.equal(
    d.data.days[0].plans[0].items.filter((i) => i.state === "failed").length,
    3,
  );
});

test("tracking-only advances registered signals before close without refresh, new signals or rewriting days", async () => {
  const h = harness(),
    d = new Daily(h.store, h.deps);
  await d.init();
  await d.activate();
  d.data.tickets = [signal()];
  await d.persist();
  const plans = structuredClone(d.data.plans),
    days = structuredClone(d.data.days);
  h.deps.now = () => new Date("2026-11-06T03:00:00+08:00");
  d.now = h.deps.now;
  h.store.startRefresh = async () => {
    throw Error("Must not refresh/enroll");
  };
  h.store.history = async () => ({ source: "A", bars });
  await assert.rejects(d.start(false, "2026-11-06"), /截止日期/);
  await assert.rejects(d.start(false, "2026-02-30"), /截止日期/);
  await d.start(false, "2026-11-05");
  await d.task;
  assert.equal(d.data.tickets.length, 1);
  assert.equal(d.data.tickets[0].exitDate, "2026-11-04");
  assert.equal(d.data.tickets[0].holdBars, 3);
  assert.deepEqual(d.data.days, days);
  assert.deepEqual(d.data.plans, plans);
  assert.equal(d.data.job.status, "completed");
  const closed = structuredClone(d.data.tickets[0]);
  await d.start(false, "2026-11-05");
  await d.task;
  assert.deepEqual(d.data.tickets[0], closed);
  assert.equal(d.data.job.target, 0);
});
test("automatic retry is bounded, deferred, and respects denial and insufficient-history errors", async () => {
  const h = harness(),
    d = new Daily(h.store, h.deps);
  await d.init();
  await d.activate();
  let now = new Date("2026-11-06T17:00:00+08:00");
  d.now = () => now;
  d.data.autoAttempt = "2026-11-06";
  d.data.autoRetryCount = 0;
  d.data.job = {
    automatic: true,
    status: "partial",
    finishedAt: new Date(now - 11 * 60000).toISOString(),
    errors: [{ kind: "transient" }],
  };
  let calls = 0;
  d.start = async () => {
    calls++;
    d.data.autoRetryCount = (d.data.autoRetryCount || 0) + 1;
  };
  await d.tick();
  await d.tick();
  assert.equal(calls, 1);
  d.data.autoRetryCount = 0;
  d.data.job.errors = [{ kind: "blocked", retryAt: now.getTime() + 60000 }];
  await d.tick();
  assert.equal(calls, 1);
  d.data.job.errors = [{ kind: "data", message: "历史不足" }];
  await d.tick();
  assert.equal(calls, 1);
  d.data.job.errors = [{ kind: "transient" }];
  d.data.job.finishedAt = now.toISOString();
  await d.tick();
  assert.equal(calls, 1);
});
test("restart recovers an interrupted automatic task and allows one deferred retry", async () => {
  const h = harness(),
    d = new Daily(h.store, h.deps);
  await d.init();
  await d.activate();
  d.data.autoAttempt = "2026-11-06";
  d.data.job = {
    status: "running",
    automatic: true,
    errors: [],
    done: 1,
    target: 2,
  };
  await d.persist();
  let now = new Date("2026-11-06T17:00:00+08:00");
  const r = new Daily(h.store, { ...h.deps, now: () => now });
  await r.init();
  assert.equal(r.data.job.status, "stopped");
  assert.match(r.data.job.note, /中断/);
  assert(!r.canRetryAutomatically());
  now = new Date(now.getTime() + 11 * 60000);
  assert(r.canRetryAutomatically());
});
