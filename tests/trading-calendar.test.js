import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  parseCalendarEvidence,
  buildCalendarReview,
  closure,
} from "../server/trading-calendar.js";
import { CalendarStore } from "../server/calendar-store.js";
import {
  CALENDAR_URL,
  createSinaHistoryProvider,
  parseSinaJSONP,
} from "../server/sina-history.js";
import { createHistoryClient } from "../server/history-client.js";
import { Daily } from "../server/daily.js";

const dates = [
  "2026-10-30",
  "2026-11-02",
  "2026-11-03",
  "2026-11-04",
  "2026-11-05",
  "2026-11-06",
];
const stamp = (date, hour = "16:30") => new Date(`${date}T${hour}:00+08:00`);
const now = stamp("2026-11-07");
const bar = (day) => ({
  day,
  open: "10",
  close: "11",
  high: "12",
  low: "9",
  volume: "100",
});
const response = (
  ds = dates,
  fetchedAt = stamp("2026-11-06").toISOString(),
) => ({ rows: ds.map(bar), fetchedAt, source: CALENDAR_URL });
const evidence = () => parseCalendarEvidence(response(), now).evidence;
const day = (date, state = "matched") => ({
  date,
  coverage: 5000,
  createdAt: stamp(date).toISOString(),
  snapshotFetchedAt: stamp(date).toISOString(),
  plans: [
    {
      planId: "short",
      items: [
        {
          state,
          stock: {
            quoteDate: date,
            quoteAt: stamp(date).toISOString(),
            volume: 100,
            source: "fixture",
          },
        },
      ],
    },
  ],
});
const ledger = () => ({
  schema: 1,
  activatedAt: stamp(dates[0]).toISOString(),
  plans: [{ id: "short", hold: 3 }],
  days: [day(dates[0]), day(dates[5], "failed")],
  tickets: [{ id: "unchanged" }],
});
const plan = () => ({
  baselineSignalDate: dates[0],
  checkpoints: [
    { day: 3, report: "day-3.md", asOf: "2026-11-05" },
    { day: 5, report: "day-5.md" },
    { day: 10, report: null },
  ],
});
const review = (overrides = {}) =>
  buildCalendarReview({
    ledger: ledger(),
    evidence: evidence(),
    plan: plan(),
    now,
    ...overrides,
  });

test("calendar: five completed sessions, four real gaps, holidays and checkpoint reports are preserved", () => {
  const input = { ledger: ledger(), evidence: evidence(), plan: plan(), now },
    before = structuredClone(input);
  const r = buildCalendarReview(input);
  assert.equal(r.count, 5);
  assert.equal(r.exact, true);
  assert.equal(r.baselineCovered, true);
  assert.deepEqual(r.missed, dates.slice(1, 5));
  assert.deepEqual(r.issues, ["2026-11-06"]);
  assert.deepEqual(r.closed, ["2026-10-31", "2026-11-01", "2026-11-07"]);
  assert.deepEqual(
    r.checkpoints.map((c) => [c.day, c.status, c.report, c.dueDate]),
    [
      [3, "reported", "day-3.md", "2026-11-04"],
      [5, "reported", "day-5.md", "2026-11-06"],
      [10, "pending", null, null],
    ],
  );
  assert.deepEqual(input, before);
});
test("calendar: weekdays without evidence are unknown, not closed or missed; gaps do not shorten the count", () => {
  const r = review({
    evidence: evidence().filter((e) => e.date !== "2026-11-03"),
  });
  assert.equal(r.count, 4);
  assert.equal(r.exact, false);
  assert.deepEqual(r.unverified, ["2026-11-03"]);
  assert(!r.missed.includes("2026-11-03"));
  assert.equal(r.checkpoints[2].status, "unverified");
  assert.equal(r.checkpoints[0].report, "day-3.md");
});
test("calendar: baseline required; prior stage reports survive unavailable evidence", () => {
  const l = ledger();
  l.days = [];
  const r = review({ ledger: l, evidence: evidence().slice(1) });
  assert.equal(r.baselineCovered, false);
  assert.equal(r.exact, false);
  assert.equal(r.checkpoints[0].status, "reported");
  assert.equal(r.checkpoints[2].dueDate, null);
});
test("calendar: complete snapshot can prove opening, but stale, pre-close or volume-less snapshots cannot", () => {
  assert.equal(review({ evidence: [] }).count, 1);
  for (const change of [
    (d) => (d.snapshotFetchedAt = stamp(d.date, "14:30").toISOString()),
    (d) => (d.createdAt = stamp("2026-11-07").toISOString()),
    (d) => (d.coverage = 0),
    (d) => (d.plans[0].items[0].stock.volume = 0),
    (d) => (d.plans[0].items[0].stock.quoteDate = "2026-11-05"),
    (d) =>
      (d.plans[0].items[0].stock.quoteAt = stamp(
        d.date,
        "14:30",
      ).toISOString()),
  ]) {
    const l = ledger();
    change(l.days[1]);
    assert.equal(review({ ledger: l, evidence: [] }).count, 0);
  }
});
test("calendar: same-day pre-run/running/due are distinct from a past missed day", () => {
  const l = ledger();
  l.days = [l.days[0]];
  for (const [hour, active, expected] of [
    ["16:00", false, "awaiting"],
    ["16:30", true, "running"],
    ["16:30", false, "due"],
  ]) {
    const at = stamp("2026-11-06", hour);
    const e = parseCalendarEvidence(
      response(dates, stamp("2026-11-06", "15:30").toISOString()),
      at,
    ).evidence;
    const r = review({ ledger: l, now: at, evidence: e, active });
    assert.equal(r.dates.at(-1).review, expected);
    assert(!r.missed.includes("2026-11-06"));
  }
  assert(review({ ledger: l }).missed.includes("2026-11-06"));
});
test("calendar: pending work and a missing strategy are incomplete, terminal failure remains visible", () => {
  const l = ledger();
  l.days[1].plans[0].items[0].state = "pending";
  assert.deepEqual(review({ ledger: l }).incomplete, ["2026-11-06"]);
  l.days[1].plans[0].items[0].state = "matched";
  l.plans.push({ id: "swing" });
  assert(review({ ledger: l }).incomplete.includes("2026-11-06"));
});
test("calendar: statutory holidays and make-up weekends remain closed; unknown years aren't assumed open", () => {
  for (const date of [
    "2026-10-01",
    "2026-10-07",
    "2026-02-23",
    "2026-05-05",
    "2026-06-19",
    "2026-09-25",
    "2026-10-10",
    "2026-05-09",
  ])
    assert(closure(date));
  assert.equal(closure("2027-02-08"), null);
  const r = review({
    plan: { baselineSignalDate: "2026-09-30", checkpoints: [] },
    evidence: [],
    ledger: { days: [] },
    now: stamp("2026-10-08"),
  });
  assert.equal(r.closed.length, 7);
  assert.deepEqual(r.missed, []);
  assert.deepEqual(r.unverified, ["2026-09-30", "2026-10-08"]);
});
test("calendar: contradictory completed holiday bar is a visible conflict, not a new session", () => {
  const e = parseCalendarEvidence(response(["2026-10-31"]), now).evidence;
  const r = review({ evidence: [...evidence(), ...e] });
  assert.equal(r.count, 5);
  assert.equal(r.exact, false);
  assert.match(r.dates.find((d) => d.date === "2026-10-31").reason, /冲突/);
});
test("calendar: missing/invalid/duplicate dates or volume and prices fail; zero volume never counts", () => {
  for (const patch of [
    { day: "2026-02-30" },
    { day: null },
    { volume: null },
    { volume: "" },
    { volume: -1 },
    { volume: true },
    { high: 1 },
    { close: 0 },
  ]) {
    assert.throws(() =>
      parseCalendarEvidence(
        { ...response(), rows: [{ ...bar("2026-10-30"), ...patch }] },
        now,
      ),
    );
  }
  assert.throws(
    () =>
      parseCalendarEvidence(
        { ...response(), rows: [bar(dates[0]), bar(dates[0])] },
        now,
      ),
    /重复/,
  );
  const r = response();
  r.rows[1].volume = "0";
  const parsed = parseCalendarEvidence(r, now);
  assert.equal(parsed.evidence.length, 5);
  assert.equal(parsed.excluded.zeroVolume, 1);
});
test("calendar: intraday and future bars never become evidence, even after cache reload next day", () => {
  const r = response(
    [...dates, "2026-11-09"],
    stamp("2026-11-06", "14:30").toISOString(),
  );
  const parsed = parseCalendarEvidence(r, now);
  assert.equal(parsed.evidence.length, 5);
  assert.equal(parsed.excluded.incomplete, 2);
  assert.equal(parsed.evidence.at(-1).date, "2026-11-05");
  assert.throws(
    () =>
      parseCalendarEvidence(
        response(dates, stamp("2026-11-09").toISOString()),
        now,
      ),
    /时间/,
  );
  assert.throws(
    () =>
      parseCalendarEvidence(
        { ...response(), source: "https://evil.invalid" },
        now,
      ),
    /来源/,
  );
});

function harness() {
  let at = now,
    disk = null,
    calls = 0,
    mode = "ok",
    failWrite = false,
    providerState = {};
  const provider = {
    status: () => providerState,
    restore: (s) => {
      providerState = { ...providerState, ...s };
    },
    fetchCalendar: async () => {
      calls++;
      if (mode === "offline")
        throw Object.assign(Error("断网"), { kind: "transient" });
      if (mode === "denied") {
        providerState.blockedUntil = at.getTime() + 1800000;
        throw Object.assign(Error("403"), {
          kind: "blocked",
          retryAt: providerState.blockedUntil,
        });
      }
      return response();
    },
  };
  const options = {
    provider,
    now: () => at,
    read: async () => structuredClone(disk),
    write: async (v) => {
      if (failWrite) throw Error("磁盘写入失败");
      disk = structuredClone(v);
    },
    readPlan: async () => plan(),
  };
  return {
    options,
    get disk() {
      return disk;
    },
    get calls() {
      return calls;
    },
    mode: (v) => (mode = v),
    at: (v) => (at = v),
    failWrite: () => (failWrite = true),
    edit: (f) => f(disk),
    async create() {
      const c = new CalendarStore(options);
      await c.init();
      return c;
    },
  };
}
test("calendar cache: restart/offline retains confirmed dates, bounds same-day retry and never mutates plan or ledger", async () => {
  const h = harness(),
    c = await h.create();
  await c.refresh();
  assert.equal(h.calls, 1);
  assert.equal(c.review(ledger()).count, 5);
  await assert.rejects(c.refresh(), /无需重复/);
  h.at(stamp("2026-11-09"));
  h.mode("offline");
  const restarted = await h.create();
  await restarted.refresh();
  assert.equal(restarted.review(ledger()).count, 5);
  assert(restarted.review(ledger()).unverified.includes("2026-11-09"));
  assert.equal(h.calls, 2);
  await assert.rejects(restarted.refresh(), /10分钟/);
  h.at(stamp("2026-11-09", "16:41"));
  await restarted.refresh();
  assert.equal(h.calls, 3);
  assert.equal(restarted.review(ledger()).count, 5);
  await assert.rejects((await h.create()).refresh(), /2次/);
});
test("calendar cache: denial cooldown survives restart and abort doesn't request new data", async () => {
  const h = harness();
  h.mode("denied");
  const c = await h.create();
  await c.refresh();
  h.at(stamp("2026-11-07", "16:41"));
  await assert.rejects((await h.create()).refresh(), /冷却/);
  assert.equal(h.calls, 1);
  h.at(stamp("2026-11-07", "17:01"));
  h.mode("ok");
  await c.refresh();
  assert.equal(h.calls, 2);
  const a = harness(),
    cc = await a.create(),
    controller = new AbortController();
  controller.abort();
  await cc.refresh(controller.signal);
  assert.equal(a.calls, 0);
  assert.equal(cc.data.lastError.kind, "transient");
});
test("calendar cache: stale response preserves evidence and permits only one bounded retry", async () => {
  const h = harness();
  h.at(stamp("2026-11-09"));
  const c = await h.create();
  await c.refresh();
  assert.equal(c.review(ledger()).count, 5);
  assert.equal(c.data.lastError.kind, "transient");
  assert.match(c.data.lastError.message, /2026-11-09尚待核验/);
  h.at(stamp("2026-11-09", "16:41"));
  await c.refresh();
  assert.equal(h.calls, 2);
  await assert.rejects(c.refresh(), /2次/);
});
test("calendar cache: a pre-close success cannot prevent the post-close verification", async () => {
  const h = harness();
  h.at(stamp("2026-11-06", "14:30"));
  h.options.provider.fetchCalendar = async () =>
    response(dates.slice(0, 5), stamp("2026-11-06", "14:30").toISOString());
  const c = await h.create();
  await c.refresh();
  assert.equal(c.data.lastError, null);
  h.at(stamp("2026-11-06", "16:30"));
  assert.equal(c.canRefresh(), true);
  h.options.provider.fetchCalendar = async () => response();
  await c.refresh();
  assert.equal(c.review(ledger()).count, 5);
  assert.equal(c.data.attempt.count, 2);
});
test("calendar cache: failure writing fetched evidence retains old proof and checkpoints refresh read-only", async () => {
  const h = harness(),
    c = await h.create();
  await c.refresh();
  const before = structuredClone(c.data.evidence);
  h.at(stamp("2026-11-09"));
  h.options.provider.fetchCalendar = async () => {
    h.failWrite();
    return response(
      [...dates, "2026-11-09"],
      stamp("2026-11-09").toISOString(),
    );
  };
  await c.refresh();
  assert.deepEqual(c.data.evidence, before);
  assert.match(c.cacheError, /保存失败/);
  assert.equal(c.review(ledger()).count, 5);
  const other = harness(),
    cc = await other.create();
  const changed = plan();
  changed.checkpoints[2].report = "existing-day-10.md";
  cc.readPlan = async () => changed;
  await cc.refresh();
  assert.equal(cc.review(ledger()).checkpoints[2].report, "existing-day-10.md");
  assert.deepEqual(changed.checkpoints[2], {
    day: 10,
    report: "existing-day-10.md",
  });
});
test("calendar cache: corrupt hash/schema and duplicate records fail closed; write failure doesn't expose new evidence", async () => {
  for (const mutate of [
    (d) => (d.sha256 = "wrong"),
    (d) => (d.schema = 99),
    (d) => {
      d.evidence.push(d.evidence[0]);
      d.sha256 = createHash("sha256")
        .update(JSON.stringify(d.evidence))
        .digest("hex");
    },
  ]) {
    const h = harness(),
      c = await h.create();
    await c.refresh();
    h.edit(mutate);
    const bad = await h.create();
    assert.match(bad.cacheError, /缓存/);
    assert.equal(bad.data.evidence.length, 0);
    await assert.rejects(bad.refresh(), /缓存异常/);
    assert.equal(h.calls, 1);
  }
  const h = harness(),
    c = await h.create();
  h.failWrite();
  await c.refresh();
  assert.equal(h.calls, 0);
  assert.equal(c.data.evidence.length, 0);
  assert.match(c.cacheError, /保存失败/);
});
test("calendar: missing stage plan is explicit and cannot erase previously read reports or declare a new node due", async () => {
  const h = harness(),
    c = await h.create();
  await c.refresh();
  c.readPlan = async () => null;
  await c.loadPlan();
  const r = c.review(ledger());
  assert.match(r.planError, /缺失/);
  assert.equal(r.exact, false);
  assert.equal(r.checkpoints[0].report, "day-3.md");
  assert.equal(r.checkpoints[2].status, "unverified");
  const first = new CalendarStore({ ...h.options, readPlan: async () => null });
  await first.init();
  assert.match(first.review(ledger()).planError, /缺失/);
});
test("calendar transport uses fixed index endpoint on shared serialized queue, JSONP and denial protection", async () => {
  let clock = 0,
    calls = 0;
  const waits = [];
  const client = createHistoryClient({
    decode: parseSinaJSONP,
    now: () => clock,
    sleep: async (ms) => {
      waits.push(ms);
      clock += ms;
    },
    fetchImpl: async (url) => {
      assert.equal(String(url), CALENDAR_URL);
      calls++;
      return new Response(`=(${JSON.stringify(response().rows)});`);
    },
  });
  const p = createSinaHistoryProvider(() => {}, { client });
  await p.fetchCalendar();
  await p.fetchCalendar();
  assert.equal(calls, 2);
  assert.deepEqual(waits, [2000]);
  p.restore({ blockedUntil: 999999 });
  await assert.rejects(p.fetchCalendar(), (e) => e.kind === "blocked");
  assert.equal(calls, 2);
});
test("daily calendar refresh shares task lock, rejects unverified advance, leaves all ledger bytes and rules unchanged", async () => {
  const h = harness(),
    calendar = await h.create();
  const l = ledger(),
    before = JSON.stringify(l);
  let writes = 0,
    release;
  h.options.provider.fetchCalendar = () => new Promise((r) => (release = r));
  const store = {
    running: () => false,
    refresh: { running: false },
    research: { active: false },
  };
  const d = new Daily(store, {
    calendar,
    now: () => now,
    read: async () => structuredClone(l),
    write: async () => writes++,
  });
  await d.init();
  await d.refreshCalendar();
  for (let i = 0; i < 10 && !release; i++)
    await new Promise((r) => setImmediate(r));
  await assert.rejects(d.refreshCalendar(), /等待/);
  release(response());
  await d.calendarTask;
  assert.equal(writes, 0);
  assert.equal(JSON.stringify(d.data), before);
  assert.equal(d.state().calendar.count, 5);
  await assert.rejects(d.start(false, "2026-11-01"), /开市证据/);
  assert.equal(writes, 0);
});
test("daily scheduling skips declared weekday holidays without new market requests or ledger writes", async () => {
  let writes = 0,
    refreshes = 0;
  const d = new Daily(
    {
      running: () => false,
      refresh: { running: false },
      research: { active: false },
      startRefresh: async () => refreshes++,
    },
    {
      now: () => stamp("2026-10-01"),
      read: async () => ledger(),
      write: async () => writes++,
    },
  );
  await d.init();
  await d.tick();
  assert.equal(writes, 0);
  assert.equal(refreshes, 0);
});
