import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { Daily } from "../server/daily.js";
import { DailyScheduler } from "../server/daily-scheduler.js";
import { decideExecution, retryAssessment } from "../server/daily-policy.js";
import { Trend } from "../server/trend.js";
import { Store } from "../server/store.js";
import { Research } from "../server/research.js";
import { dailyPlans } from "../shared/daily-plans.js";
import { registerSignal } from "../server/paper-ledger.js";

const at = (date = "2026-11-06", hour = "16:21") =>
  new Date(`${date}T${hour}:00+08:00`);
const dateList = [
  "2026-10-30",
  "2026-11-02",
  "2026-11-03",
  "2026-11-04",
  "2026-11-05",
  "2026-11-06",
];
const plans = dailyPlans.map((p) => ({
  ...structuredClone(p),
  ruleHash: "fixture",
  activatedAt: at("2026-10-30").toISOString(),
}));
const stock = {
  symbol: "sh600000",
  code: "600000",
  name: "测试甲",
  board: "main",
  quoteDate: "2026-11-06",
  price: 20,
  volume: 1000000,
  amount: 4e8,
  changePct: 3,
  turnover: 5,
};
const freshLedger = () => ({
  schema: 1,
  activatedAt: at("2026-10-30").toISOString(),
  plans: structuredClone(plans),
  days: [],
  tickets: [],
  job: null,
  autoAttempt: null,
});
const calendarView = (asOf = "2026-11-06") => ({
  asOf,
  dates: dateList
    .filter((d) => d <= asOf)
    .map((date) => ({ date, market: "open" })),
  missed: dateList.slice(1, 5),
});
function history() {
  const d = new Date("2026-11-06T00:00:00Z"),
    rows = [];
  for (let i = 0; i < 250; i++) {
    if (![0, 6].includes(d.getUTCDay()))
      rows.push({ date: d.toISOString().slice(0, 10) });
    d.setUTCDate(d.getUTCDate() - 1);
  }
  return rows.reverse().map((b, i) => ({
    ...b,
    open: 10 + i * 0.03,
    close: 10.01 + i * 0.03,
    high: 10.1 + i * 0.03,
    low: 9.9 + i * 0.03,
    volume: 100,
  }));
}
const envelope = (data) => ({
  data,
  sha256: createHash("sha256").update(JSON.stringify(data)).digest("hex"),
});
async function harness({
  now = at(),
  ledger = freshLedger(),
  schedule = null,
  asOf = "2026-11-06",
} = {}) {
  let clock = now,
    disk = structuredClone(ledger),
    scheduleDisk = structuredClone(schedule),
    writes = 0,
    reads = 0,
    blockedUntil = 0,
    scheduleFailure = false,
    ledgerFailure = false,
    scanBusy = false,
    calendarAsOf = asOf;
  const data = new Map(),
    calls = [];
  const store = {
    trend: null,
    daily: null,
    research: { active: false },
    refresh: { running: false },
    running: () => !!store.trend?.active || scanBusy,
    market: { date: "2026-11-06", fetchedAt: at().toISOString(), stocks: [] },
    checkResources: async () => {},
    stopRefresh: () => {},
    startRefresh: async () => {
      reads++;
      store.refreshTask = Promise.resolve();
    },
    history: async (symbol) => {
      calls.push({ owner: store.daily.active ? "daily" : "trend", symbol });
      return {
        symbol,
        bars: history(),
        source: "fixture",
        adjustment: "前复权",
        fetchedAt: at().toISOString(),
      };
    },
  };
  const calendar = {
    init: async () => {},
    review: () => calendarView(calendarAsOf),
    canRefresh: () => false,
    shouldRefresh: () => false,
  };
  const make = async () => {
    const d = new Daily(store, {
      now: () => clock,
      calendar,
      read: async () => structuredClone(disk),
      write: async (_key, value) => {
        if (ledgerFailure) throw Error("账本写失败");
        writes++;
        disk = structuredClone(value);
      },
    });
    const s = new DailyScheduler(d, {
      now: () => clock,
      sources: () => ({ sina: { blockedUntil } }),
      read: async () => structuredClone(scheduleDisk),
      write: async (value) => {
        if (scheduleFailure) throw Error("调度写失败");
        scheduleDisk = structuredClone(value);
      },
    });
    d.scheduler = s;
    store.daily = d;
    await d.init();
    return d;
  };
  const daily = await make();
  const trend = new Trend(store, {
    read: async (key) => structuredClone(data.get(key) || null),
    write: async (key, v) => data.set(key, structuredClone(v)),
  });
  store.trend = trend;
  await trend.init();
  return {
    daily,
    scheduler: daily.scheduler,
    store,
    trend,
    data,
    calls,
    make,
    calendar,
    get disk() {
      return disk;
    },
    get scheduleDisk() {
      return scheduleDisk;
    },
    get writes() {
      return writes;
    },
    get reads() {
      return reads;
    },
    setNow: (x) => (clock = x),
    setAsOf: (x) => (calendarAsOf = x),
    block: (x) => (blockedUntil = x),
    busy: (x) => (scanBusy = x),
    failSchedule: () => (scheduleFailure = true),
    failLedger: () => (ledgerFailure = true),
    editDisk: (f) => f(disk),
    editSchedule: (f) => {
      const d = structuredClone(scheduleDisk.data);
      f(d);
      scheduleDisk = envelope(d);
    },
  };
}
async function until(fn) {
  for (let i = 0; i < 100 && !fn(); i++)
    await new Promise((r) => setImmediate(r));
  assert(fn());
}

test("scheduler: due window reserves before new scans, research, trends and manual market refresh", async () => {
  const h = await harness();
  assert.equal(h.scheduler.state().status, "ready");
  assert.equal(h.scheduler.state().lastDueDate, "2026-11-06");
  assert.throws(() => h.daily.assertBackgroundAllowed(), /预约/);
  await assert.rejects(Store.prototype.startScan.call(h.store, {}), /预约/);
  await assert.rejects(
    Store.prototype.continueScan.call(h.store, "resume"),
    /预约/,
  );
  await assert.rejects(Store.prototype.startRefresh.call(h.store), /预约/);
  await assert.rejects(
    Research.prototype.start.call({ store: h.store }, {}),
    /预约/,
  );
  await assert.rejects(h.trend.start({}), /预约/);
  assert.equal(h.reads, 0);
  assert.equal(h.writes, 0);
});
test("scheduler: successful day is idempotent and restart does not run it again", async () => {
  const h = await harness();
  await h.daily.tick();
  const writes = h.writes;
  assert.equal(h.reads, 1);
  assert.equal(h.daily.data.days.length, 1);
  assert.equal(h.scheduler.state().status, "complete");
  assert.equal(h.scheduleDisk.data.attempts.length, 1);
  await h.daily.tick();
  assert.equal(h.writes, writes);
  const restarted = await h.make();
  await restarted.tick();
  assert.equal(h.reads, 1);
});
test("scheduler: busy jobs are observable, no attempt is consumed, and a later idle check launches once", async () => {
  const h = await harness();
  h.busy(true);
  await h.daily.tick();
  assert.equal(h.reads, 0);
  assert.equal(h.scheduleDisk.data.attempts.length, 0);
  assert.equal(h.scheduler.state().status, "waiting-job");
  assert.match(h.scheduler.state().reason, /筛选/);
  h.busy(false);
  h.store.research.active = true;
  await h.daily.tick();
  assert.match(h.scheduler.state().reason, /研究/);
  h.store.research.active = false;
  h.store.refresh.running = true;
  await h.daily.tick();
  assert.match(h.scheduler.state().reason, /刷新/);
  h.store.refresh.running = false;
  await h.daily.tick();
  assert.equal(h.reads, 1);
});
test("scheduler: concurrent ticks and the reservation-save gap cannot launch duplicate or competing tasks", async () => {
  const h = await harness();
  const save = h.scheduler.write;
  let release;
  h.scheduler.write = (v) =>
    new Promise(
      (r) =>
        (release = async () => {
          await save(v);
          r();
        }),
    );
  const pending = h.daily.tick();
  await until(() => release);
  assert.throws(() => h.daily.assertBackgroundAllowed(), /预约/);
  await assert.rejects(h.daily.start(), /预约/);
  await h.daily.tick();
  assert.equal(h.reads, 0);
  h.scheduler.write = save;
  await release();
  await pending;
  assert.equal(h.reads, 1);
});
test("scheduler: transient or stale data waits 10 minutes and retries at most once", async () => {
  const h = await harness();
  h.store.market.date = "2026-11-05";
  await h.daily.tick();
  assert.equal(h.daily.data.job.status, "waiting");
  assert.equal(h.daily.data.days.length, 0);
  assert.equal(h.scheduler.state().status, "cooldown");
  assert.equal(
    h.scheduler.state().nextRetryAt,
    at("2026-11-06", "16:31").toISOString(),
  );
  h.setNow(at("2026-11-06", "16:30"));
  await h.daily.tick();
  assert.equal(h.reads, 1);
  h.setNow(at("2026-11-06", "16:32"));
  await h.daily.tick();
  assert.equal(h.reads, 2);
  h.setNow(at("2026-11-06", "17:00"));
  await h.daily.tick();
  assert.equal(h.reads, 2);
  assert.equal(h.scheduler.state().status, "attempt-limit");
});
test("scheduler: denial cooldown and historical insufficiency do not loop", async () => {
  const h = await harness();
  h.block(at("2026-11-06", "17:00").getTime());
  await h.daily.tick();
  assert.equal(h.reads, 0);
  assert.equal(h.scheduler.state().status, "cooldown");
  h.block(0);
  h.store.market.stocks = [stock];
  h.store.history = async () => ({ bars: [], source: "fixture" });
  await h.daily.tick();
  assert.equal(h.daily.data.job.status, "partial");
  assert.equal(h.scheduler.state().status, "issues");
  h.setNow(at("2026-11-06", "18:00"));
  await h.daily.tick();
  assert.equal(h.reads, 1);
});
test("scheduler: manual stop suppresses same-day automatic restart, but not a new trading date", async () => {
  const h = await harness();
  let release;
  h.store.startRefresh = async () => {
    h.store.refreshTask = new Promise((r) => (release = r));
  };
  const run = h.daily.tick();
  await until(() => release);
  h.daily.stop();
  release();
  await run;
  assert.equal(h.scheduler.state().status, "user-paused");
  h.setNow(at("2026-11-06", "18:00"));
  await h.daily.tick();
  assert.equal(h.scheduleDisk.data.attempts.length, 1);
  h.setNow(at("2026-11-09"));
  assert.equal(h.scheduler.decision().task.target, "2026-11-09");
});
test("scheduler: reservation write failure prevents network and ledger activity; corrupt cache protects startup", async () => {
  const h = await harness();
  h.failSchedule();
  await h.daily.tick();
  assert.match(h.scheduler.error, /保存失败/);
  assert.equal(h.reads, 0);
  assert.equal(h.writes, 0);
  assert.equal(h.scheduler.pendingExecution, null);
  const broken = await harness({
    schedule: { data: { schema: 1, attempts: [], events: [] }, sha256: "bad" },
  });
  await broken.daily.tick();
  assert.equal(broken.reads, 0);
  assert.equal(broken.scheduler.state().status, "protected");
});
test("scheduler: crash after ledger commit but before schedule commit reconciles by execution ID", async () => {
  const h = await harness();
  await h.daily.tick();
  h.editSchedule((d) => {
    const a = d.attempts.at(-1);
    a.status = "running";
    a.finishedAt = null;
  });
  const restarted = await h.make();
  assert.equal(restarted.scheduler.data.attempts.at(-1).status, "completed");
  await restarted.tick();
  assert.equal(h.reads, 1);
  assert.equal(restarted.data.days.length, 1);
});
test("scheduler: interrupted execution reports unknown end time and allows only one delayed retry", async () => {
  const h = await harness();
  await h.daily.tick();
  h.editDisk((d) => {
    d.job.status = "running";
    d.job.finishedAt = null;
  });
  h.editSchedule((d) => {
    d.attempts.at(-1).status = "running";
    d.attempts.at(-1).finishedAt = null;
  });
  h.setNow(at("2026-11-06", "16:30"));
  const restored = await h.make();
  assert.equal(restored.scheduler.state().actualJob.finishedAt, null);
  assert(restored.scheduler.state().actualJob.recoveredAt);
  await restored.tick();
  assert.equal(h.reads, 1);
  h.setNow(at("2026-11-06", "16:41"));
  await restored.tick();
  assert.equal(h.reads, 2);
  await restored.tick();
  assert.equal(h.reads, 2);
});
test("scheduler: pre-close recovery advances only registered tickets using verified dates, leaving days and plans intact", async () => {
  const ledger = freshLedger();
  ledger.tickets = [
    registerSignal(
      [],
      plans[0],
      stock,
      "2026-10-30",
      at("2026-10-30").toISOString(),
      [],
      "fixture",
    ),
  ];
  const h = await harness({
    ledger,
    now: at("2026-11-06", "10:00"),
    asOf: "2026-11-05",
  });
  const frozenPlans = structuredClone(h.daily.data.plans);
  await h.daily.tick();
  assert.equal(h.reads, 0);
  assert.equal(h.daily.data.tickets.length, 1);
  assert.equal(h.daily.data.days.length, 0);
  assert.equal(h.daily.data.tickets[0].hold, 3);
  assert.equal(h.daily.data.tickets[0].exitDate, "2026-11-04");
  assert.equal(h.daily.data.job.trackingAsOf, "2026-11-05");
  assert.deepEqual(h.daily.data.plans, frozenPlans);
  await h.daily.tick();
  assert.equal(h.scheduleDisk.data.attempts.length, 1);
});
test("scheduler: missing date proof never advances a ticket; calendar failure doesn't invent an asOf", async () => {
  const ledger = freshLedger();
  ledger.tickets = [
    registerSignal(
      [],
      plans[0],
      stock,
      "2026-10-30",
      at("2026-10-30").toISOString(),
      [],
      "fixture",
    ),
  ];
  const h = await harness({
    ledger,
    now: at("2026-11-06", "10:00"),
    asOf: "2026-10-30",
  });
  await h.daily.tick();
  assert.equal(h.calls.length, 0);
  assert.equal(h.writes, 0);
});
test("scheduler: a sleep/check gap records only observed downtime and never enrolls yesterday", async () => {
  const h = await harness({
    now: at("2026-11-05", "14:00"),
    asOf: "2026-11-04",
  });
  await h.daily.tick();
  h.setNow(at("2026-11-06", "10:00"));
  await h.daily.tick();
  assert(h.scheduler.state().events.some((e) => e.type === "check-gap"));
  assert.equal(h.daily.data.days.length, 0);
  assert.equal(h.writes, 0);
});
test("scheduler: market refresh crossing midnight cannot register old-day new signals", async () => {
  const h = await harness({ now: at("2026-11-06", "23:59") });
  h.store.startRefresh = async () => {
    h.setNow(at("2026-11-07", "00:01"));
    h.store.refreshTask = Promise.resolve();
  };
  await h.daily.tick();
  assert.equal(h.daily.data.days.length, 0);
  assert.equal(h.daily.data.tickets.length, 0);
  assert.equal(h.daily.data.job.status, "waiting");
});
test("scheduler: legacy automatic attempt count is preserved and closed weekends do not start a daily scan", () => {
  const ledger = freshLedger();
  ledger.autoAttempt = "2026-11-06";
  ledger.autoRetryCount = 1;
  ledger.job = {
    startedAt: at().toISOString(),
    status: "waiting",
    automatic: true,
    finishedAt: at().toISOString(),
  };
  const r = decideExecution({
    ledger,
    calendar: calendarView(),
    now: at("2026-11-06", "18:00"),
  });
  assert.equal(r.status, "attempt-limit");
  assert.equal(
    decideExecution({ ledger, calendar: calendarView(), now: at("2026-11-07") })
      .status,
    "closed",
  );
  assert.equal(
    retryAssessment({
      ...ledger.job,
      errors: [{ kind: "blocked", retryAt: null }],
    }).retryable,
    false,
  );
});

test("priority: finish and save current stock, run daily once, then resume original trend order without rescanning successes", async () => {
  const h = await harness({ now: at("2026-11-06", "16:10") });
  h.store.market.stocks = [
    stock,
    { ...stock, symbol: "sh600001", code: "600001", name: "测试乙" },
    { ...stock, symbol: "sh600002", code: "600002", name: "测试丙" },
  ];
  const original = h.store.history;
  let release;
  h.store.history = (s, ...args) =>
    !release
      ? new Promise(
          (r) => (release = async () => r(await original(s, ...args))),
        )
      : original(s, ...args);
  await h.trend.start({ maxScan: 500 });
  await until(() => release);
  const config = structuredClone(h.trend.job.config),
    id = h.trend.job.id;
  h.setNow(at());
  await h.daily.tick();
  assert(h.trend.yieldRequest);
  assert(!h.trend.controller.signal.aborted);
  assert.equal(h.scheduler.state().status, "waiting-job");
  await release();
  await h.trend.task;
  assert.equal(h.trend.job.done, 1);
  assert.deepEqual(h.trend.job.priorityYield.indices, [1, 2]);
  assert.equal(h.data.get("last-trend").done, 1);
  assert.equal(h.data.get("last-trend").status, "paused");
  await h.daily.tick();
  await h.trend.task;
  assert.equal(h.trend.job.done, 3);
  assert.equal(h.trend.job.id, id);
  assert.deepEqual(h.trend.job.config, config);
  assert.deepEqual(
    h.calls.filter((x) => x.owner === "trend").map((x) => x.symbol),
    ["sh600000", "sh600001", "sh600002"],
  );
  assert.equal(h.scheduleDisk.data.attempts.length, 1);
});
test("priority: stopping trend while a daily yield is requested suppresses automatic continuation", async () => {
  const h = await harness({ now: at("2026-11-06", "16:10") });
  h.store.market.stocks = [stock];
  let release;
  h.store.history = () => new Promise((r) => (release = r));
  await h.trend.start({});
  await until(() => release);
  h.setNow(at());
  await h.daily.tick();
  h.trend.stop();
  release({ bars: history(), source: "fixture" });
  await h.trend.task;
  assert.equal(h.trend.job.status, "stopped");
  assert.equal(h.trend.job.priorityYield, undefined);
  assert.equal(h.trend.job.pending, 1);
  assert.equal(h.trend.yieldRequest, null);
});
test("priority: a persisted yield retains retry subset and order; restart requires manual continuation", async () => {
  const h = await harness({ now: at("2026-11-06", "16:10") });
  h.store.market.stocks = [
    stock,
    { ...stock, symbol: "sh600001" },
    { ...stock, symbol: "sh600002" },
  ];
  h.store.history = async () => {
    throw Error("历史不足");
  };
  await h.trend.start({});
  await h.trend.task;
  const calls = [];
  let release;
  h.store.history = (s) => {
    calls.push(s);
    return !release
      ? new Promise((r) => (release = r))
      : Promise.resolve({ bars: history(), source: "fixture" });
  };
  await h.trend.continue("retry", ["sh600000", "sh600002"]);
  await until(() => release);
  h.trend.requestDailyYield({ key: "daily:2026-11-06" });
  release({ bars: history(), source: "fixture" });
  await h.trend.task;
  assert.deepEqual(h.trend.job.priorityYield.indices, [2]);
  const restored = new Trend(h.store, h.trend);
  await restored.init();
  assert.equal(restored.recoveredPriority, true);
  await h.trend.resumeAfterDaily("daily:2026-11-06");
  await h.trend.task;
  assert.deepEqual(calls, ["sh600000", "sh600002"]);
  assert.equal(h.trend.job.items[1].state, "failed");
});
test("priority: last-stock yield needs no pause and corrupted continuation identity is rejected", async () => {
  const h = await harness({ now: at("2026-11-06", "16:10") });
  h.store.market.stocks = [stock];
  const load = h.store.history;
  let release;
  h.store.history = (s) =>
    new Promise((r) => (release = async () => r(await load(s))));
  await h.trend.start({});
  await until(() => release);
  h.trend.requestDailyYield({ key: "daily:2026-11-06" });
  await release();
  await h.trend.task;
  assert.equal(h.trend.job.status, "completed");
  assert.equal(h.trend.job.priorityYield, undefined);
  h.trend.job.priorityYield = {
    autoResume: true,
    key: "daily:2026-11-06",
    jobId: h.trend.job.id,
    identityHash: "wrong",
    indices: [0],
  };
  await assert.rejects(h.trend.resumeAfterDaily("daily:2026-11-06"), /身份/);
});
test("scheduler: explicit denial retryAt outlasts the normal retry interval", async () => {
  const h = await harness();
  h.store.market.stocks = [stock];
  h.store.history = async () => {
    throw Object.assign(Error("拒绝访问"), {
      kind: "blocked",
      retryAt: at("2026-11-06", "17:00").getTime(),
    });
  };
  await h.daily.tick();
  assert.equal(
    h.scheduler.state().nextRetryAt,
    at("2026-11-06", "17:00").toISOString(),
  );
  h.setNow(at("2026-11-06", "16:55"));
  await h.daily.tick();
  assert.equal(h.reads, 1);
  h.setNow(at("2026-11-06", "17:01"));
  await h.daily.tick();
  assert.equal(h.reads, 2);
});
test("scheduler: calendar verification can unlock tracking-only recovery, while failed verification cannot", async () => {
  for (const success of [false, true]) {
    const ledger = freshLedger();
    ledger.tickets = [
      registerSignal(
        [],
        plans[0],
        stock,
        "2026-10-30",
        at("2026-10-30").toISOString(),
        [],
        "fixture",
      ),
    ];
    const h = await harness({
      ledger,
      now: at("2026-11-06", "10:00"),
      asOf: "2026-10-30",
    });
    h.calendar.canRefresh = () => true;
    h.calendar.refreshReason = () => null;
    h.calendar.refresh = async () => {
      if (success) h.setAsOf("2026-11-05");
    };
    await h.daily.tick();
    assert.equal(h.daily.data.days.length, 0);
    assert.equal(h.reads, 0);
    assert.equal(h.daily.data.tickets[0].state, success ? "closed" : "pending");
  }
});
test("priority: cancel deferred auto-resume is persisted; a failed pause save protects automatic daily start", async () => {
  const h = await harness({ now: at("2026-11-06", "16:10") });
  h.store.market.stocks = [stock];
  await h.trend.start({});
  await h.trend.task;
  h.trend.job.priorityYield = {
    key: "daily:2026-11-06",
    autoResume: true,
    reason: "fixture pause",
  };
  await h.trend.stop();
  assert.equal(h.data.get("last-trend").priorityYield.autoResume, false);
  h.trend.job.fatal = "无法保存进度：磁盘失败";
  h.setNow(at());
  await h.daily.tick();
  assert.equal(h.reads, 0);
  assert.equal(h.scheduler.state().status, "protected");
});
test("scheduler: no cached asOf still requests date evidence before tracking recovery", async () => {
  const ledger = freshLedger();
  ledger.tickets = [
    registerSignal(
      [],
      plans[0],
      stock,
      "2026-10-30",
      at("2026-10-30").toISOString(),
      [],
      "fixture",
    ),
  ];
  const h = await harness({
    ledger,
    now: at("2026-11-06", "10:00"),
    asOf: null,
  });
  let checks = 0;
  h.calendar.canRefresh = () => true;
  h.calendar.refreshReason = () => null;
  h.calendar.refresh = async () => {
    checks++;
    h.setAsOf("2026-11-05");
  };
  await h.daily.tick();
  assert.equal(checks, 1);
  assert.equal(h.daily.data.tickets[0].state, "closed");
  assert.equal(h.reads, 0);
});
test("scheduler: large per-stock error lists become bounded summaries, with actual start distinct from reservation", async () => {
  const h = await harness(),
    entry = { startedAt: at().toISOString() };
  const job = {
    startedAt: at("2026-11-06", "16:22").toISOString(),
    finishedAt: at("2026-11-06", "16:29").toISOString(),
    status: "partial",
    errors: Array.from({ length: 6000 }, () => ({
      kind: "data",
      message: "历史不足".repeat(100),
    })),
  };
  h.scheduler.finish(entry, job);
  assert.equal(entry.errorCount, 6000);
  assert.equal(entry.errors.length, 1);
  assert.equal(entry.actualStartedAt, job.startedAt);
  assert.notEqual(entry.startedAt, entry.actualStartedAt);
  assert(Buffer.byteLength(JSON.stringify(entry)) < 1500);
});
test("scheduler: known long-running work is not misreported as a sleep or service gap", async () => {
  const h = await harness();
  h.store.startRefresh = async () => {
    h.setNow(at("2026-11-06", "16:40"));
    h.store.refreshTask = Promise.resolve();
  };
  await h.daily.tick();
  h.setNow(at("2026-11-06", "16:41"));
  await h.daily.tick();
  assert(!h.scheduler.data.events.some((e) => e.type === "check-gap"));
  h.setNow(at("2026-11-06", "16:50"));
  await h.daily.tick();
  assert(h.scheduler.data.events.some((e) => e.type === "check-gap"));
});
test("scheduler: losing the separate schedule file cannot reset recovery cooldown or the two-attempt cap", async () => {
  const ledger = freshLedger();
  ledger.tickets = [
    registerSignal(
      [],
      plans[0],
      stock,
      "2026-10-30",
      at("2026-10-30").toISOString(),
      [],
      "fixture",
    ),
  ];
  const h = await harness({
    ledger,
    now: at("2026-11-06", "10:00"),
    asOf: "2026-11-05",
  });
  h.store.history = async () => {
    throw Object.assign(Error("临时断线"), { kind: "transient" });
  };
  await h.daily.tick();
  assert.equal(h.disk.job.executionAttempt, 1);
  const options = {
    now: h.daily.now,
    sources: () => ({}),
    read: async () => null,
    write: async () => {},
  };
  h.daily.scheduler = new DailyScheduler(h.daily, options);
  await h.daily.scheduler.init();
  assert.equal(h.daily.scheduler.state().status, "cooldown");
  h.setNow(at("2026-11-06", "10:11"));
  await h.daily.tick();
  assert.equal(h.disk.job.executionAttempt, 2);
  h.daily.scheduler = new DailyScheduler(h.daily, options);
  await h.daily.scheduler.init();
  h.setNow(at("2026-11-06", "10:30"));
  await h.daily.tick();
  assert.equal(h.daily.scheduler.state().status, "attempt-limit");
  assert.equal(h.disk.job.executionAttempt, 2);
  assert.equal(h.disk.days.length, 0);
});
test("scheduler: first upgrade cannot infer downtime from an old daily job end time", async () => {
  const ledger = freshLedger();
  ledger.job = {
    startedAt: at("2026-11-05").toISOString(),
    finishedAt: at("2026-11-05", "16:40").toISOString(),
    status: "completed",
  };
  const h = await harness({
    ledger,
    now: at("2026-11-06", "10:00"),
    asOf: "2026-11-05",
  });
  h.setNow(at("2026-11-06", "10:01"));
  await h.daily.tick();
  assert(!h.scheduler.data.events.some((e) => e.type === "check-gap"));
});
