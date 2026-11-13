import test from "node:test";
import assert from "node:assert/strict";
import { ReviewReports } from "../server/review-reports.js";
import { hash, ReviewFiles } from "../server/review-files.js";
import { mkdtemp, readFile, writeFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Daily } from "../server/daily.js";

const p = {
  id: "short",
  name: "短线",
  hold: 3,
  ruleHash: "abc",
  costBps: 10,
  slippageBps: 5,
};
const plan = {
  baselineSignalDate: "2026-10-30",
  frozenPlans: [p],
  initialTicketIds: ["short:sz000001:2026-10-30"],
  checkpoints: [3, 5, 10].map((day) => ({ day, report: null })),
};
const ticket = {
  ...p,
  id: plan.initialTicketIds[0],
  planId: p.id,
  symbol: "sz000001",
  code: "000001",
  name: "甲",
  signalDate: "2026-10-30",
  state: "holding",
  asOf: "2026-11-13",
};
function setup() {
  let time = new Date("2026-11-13T09:00:00Z");
  const dates = [
    "2026-11-02",
    "2026-11-03",
    "2026-11-04",
    "2026-11-05",
    "2026-11-06",
    "2026-11-09",
    "2026-11-10",
    "2026-11-11",
    "2026-11-12",
    "2026-11-13",
  ];
  const calendar = {
    exact: true,
    asOf: dates.at(-1),
    count: 10,
    confirmedDates: dates,
    missed: dates.slice(0, 4),
    incomplete: [],
    unverified: [],
    dates: dates.map((date) => ({
      date,
      market: "open",
      review: "missed",
      evidence: [],
    })),
  };
  const daily = {
    data: { plans: [p], tickets: [ticket], days: [] },
    active: false,
    calendarReview: () => calendar,
  };
  const db = {
    state: null,
    bundles: new Map(),
    docs: new Map(),
    writes: 0,
    bundleWrites: 0,
    fail: false,
  };
  const files = {
    readPlan: async () => structuredClone(plan),
    readComparison: async () => null,
    readState: async () => structuredClone(db.state),
    writeState: async (s) => {
      if (db.fail) throw Error("disk failure");
      db.writes++;
      db.state = structuredClone(s);
    },
    readBundle: async (d) => structuredClone(db.bundles.get(d) || null),
    bundle: async (d, b) => {
      if (!db.bundles.has(d)) {
        db.bundleWrites++;
        db.bundles.set(d, structuredClone(b));
      }
      return structuredClone(db.bundles.get(d));
    },
    markdown: async (d, md) => {
      db.docs.set(d, md);
      return `day-${d}.md`;
    },
    legacy: async (d) => {
      const text = db.docs.get(d);
      if (!text) throw Error("old missing");
      return { text, file: `day-${d}.md`, sha256: hash(text) };
    },
  };
  const create = () => new ReviewReports(daily, { files, now: () => time });
  return {
    daily,
    calendar,
    db,
    files,
    create,
    setTime: (v) => (time = new Date(v)),
  };
}
test("便携新实例等待首批实际信号再建立独立计划，重启不重复建立", async () => {
  const f = setup();
  let createdPlan = null;
  let created = 0;
  f.files.readPlan = async () => structuredClone(createdPlan);
  f.files.initializePlan = async (value) => {
    assert.equal(createdPlan, null);
    created++;
    createdPlan = structuredClone(value);
  };
  f.daily.data.tickets = [];
  f.calendar.count = 0;
  const r = new ReviewReports(f.daily, { files: f.files, allowNewPlan: true });
  await r.init();
  assert.equal(r.state().error, null);
  assert.match(r.state().notice, /首个有入选信号/);
  await r.refresh();
  assert.equal(created, 0);
  f.daily.data.tickets = [structuredClone(ticket)];
  f.daily.data.days = [
    { date: ticket.signalDate, plans: [{ items: [{ state: "pending" }] }] },
  ];
  await r.refresh();
  assert.equal(created, 0);
  f.daily.data.days[0].plans[0].items[0].state = "matched";
  await r.refresh();
  assert.equal(r.error, null);
  assert.equal(created, 1);
  assert.equal(createdPlan.baselineSignalDate, ticket.signalDate);
  assert.deepEqual(createdPlan.initialTicketIds, [ticket.id]);
  assert.deepEqual(createdPlan.frozenPlans, f.daily.data.plans);
  const restarted = new ReviewReports(f.daily, {
    files: f.files,
    allowNewPlan: true,
  });
  await restarted.init();
  await restarted.refresh();
  assert.equal(created, 1);
  assert.equal(restarted.error, null);
  createdPlan = null;
  const missing = new ReviewReports(f.daily, {
    files: f.files,
    allowNewPlan: true,
  });
  await missing.init();
  assert.match(missing.error, /计划缺失/);
});

test("独立阶段计划使用排他写入，已有文件保持原样", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "new-review-plan-"));
  const files = new ReviewFiles({ dir });
  await files.initializePlan(plan);
  const original = await readFile(path.join(dir, "plan.json"), "utf8");
  await assert.rejects(
    files.initializePlan({ ...plan, baselineSignalDate: "2026-11-01" }),
    { code: "EEXIST" },
  );
  assert.equal(await readFile(path.join(dir, "plan.json"), "utf8"), original);
});
test("3/5/10到期一次补齐，真实截至与应到节点分开，重复检查/重启不再生成", async () => {
  const f = setup(),
    r = f.create();
  await r.init();
  await r.refresh();
  assert.deepEqual(
    r.state().stages.map((s) => s.status),
    ["prepared", "prepared", "prepared"],
  );
  assert.equal(r.state().stages[0].dueDate, "2026-11-04");
  assert.equal(r.state().stages[0].asOf, "2026-11-13");
  assert.match(await r.document(3), /恢复后补报/);
  assert.equal(r.state().stages[0].delivery.status, "pending");
  const n = f.db.writes;
  await r.refresh();
  const r2 = f.create();
  await r2.init();
  await r2.refresh();
  assert.equal(f.db.writes, n);
  assert.equal(f.db.bundleWrites, 3);
  assert.equal(
    JSON.parse(await r.document(10, "json")).ledger.tickets.length,
    1,
  );
});
test("未经核验/节点未到/运行中/账本保护不生成", async () => {
  const f = setup(),
    r = f.create();
  await r.init();
  f.calendar.exact = false;
  await r.refresh();
  assert.equal(f.db.bundleWrites, 0);
  f.calendar.exact = true;
  f.calendar.count = 2;
  await r.refresh();
  assert.equal(f.db.bundleWrites, 0);
  f.calendar.count = 10;
  f.daily.active = true;
  await r.refresh();
  assert.equal(f.db.bundleWrites, 0);
  f.daily.active = false;
  f.daily.storage = { status: () => ({ blocked: true }) };
  await r.refresh();
  assert.equal(f.db.bundleWrites, 0);
});
test("旧3/5保留原文和报告状态，不伪造通知时间，不覆盖或领取", async () => {
  const f = setup();
  const old = structuredClone(plan);
  for (const c of old.checkpoints.filter((c) => c.day < 10)) {
    c.report = `day-${c.day}.md`;
    f.db.docs.set(c.day, `原第${c.day}报告`);
  }
  f.files.readPlan = async () => old;
  f.calendar.count = 5;
  const r = f.create();
  await r.init();
  await r.refresh();
  assert.equal(await r.document(3), "原第3报告");
  assert.equal(r.state().stages[0].delivery.status, "legacy-recorded");
  assert.equal(r.state().stages[0].delivery.deliveredAt, undefined);
  await assert.rejects(r.notification("claim", { day: 3 }), /旧报告/);
  assert.equal(f.db.bundleWrites, 0);
});
test("通知先领取后实际确认：并发只领取一次，重启不重发，确认幂等", async () => {
  const f = setup(),
    r = f.create();
  await r.init();
  await r.refresh();
  const claims = await Promise.allSettled([
    r.notification("claim", { day: 3 }),
    r.notification("claim", { day: 3 }),
  ]);
  assert.equal(claims.filter((x) => x.status === "fulfilled").length, 1);
  const { token } = claims.find((x) => x.status === "fulfilled").value;
  const r2 = f.create();
  await r2.init();
  assert.equal(r2.state().stages[0].delivery.status, "claimed");
  assert.equal(r2.state().stages[0].delivery.token, token);
  await assert.rejects(r2.notification("claim", { day: 3 }), /已领取/);
  await assert.rejects(
    r2.notification("ack", { day: 3, token, receipt: "准备好了" }),
    /实际交付/,
  );
  await r2.notification("ack", {
    day: 3,
    token,
    receipt: "聊天已可见：消息123，附第3报告链接",
  });
  const n = f.db.writes;
  await r2.notification("ack", {
    day: 3,
    token,
    receipt: "重试确认：聊天消息123已交付",
  });
  assert.equal(f.db.writes, n);
  assert.equal(r2.state().stages[0].delivery.status, "delivered");
});
test("领取后明确核对未送达才能释放，旧凭据失效", async () => {
  const f = setup(),
    r = f.create();
  await r.init();
  await r.refresh();
  const first = await r.notification("claim", { day: 5 });
  await assert.rejects(
    r.notification("release", {
      day: 5,
      token: "wrong",
      receipt: "已核对聊天未送达",
    }),
    /凭据/,
  );
  await r.notification("release", {
    day: 5,
    token: first.token,
    receipt: "已核对本聊天记录，确实未交付报告",
  });
  const next = await r.notification("claim", { day: 5 });
  assert.notEqual(next.token, first.token);
});
test("报告保存后登记失败不会标准备成功，原快照保留，重启后复用", async () => {
  const f = setup(),
    r = f.create();
  await r.init();
  f.db.fail = true;
  await r.refresh();
  assert.match(r.error, /保存失败/);
  assert.equal(r.state().stages[0].status, "pending");
  assert.equal(f.db.bundles.size, 1);
  f.db.fail = false;
  const r2 = f.create();
  await r2.init();
  await r2.refresh();
  assert.equal(r2.state().stages[0].status, "prepared");
  assert.equal(f.db.bundleWrites, 3);
});
test("通知确认保存失败保留领取状态而非送达，重启需核对聊天", async () => {
  const f = setup(),
    r = f.create();
  await r.init();
  await r.refresh();
  const c = await r.notification("claim", { day: 10 });
  f.db.fail = true;
  await assert.rejects(
    r.notification("ack", {
      day: 10,
      token: c.token,
      receipt: "真实聊天消息已可见，链接已交付",
    }),
    /disk/,
  );
  assert.equal(r.state().stages[2].delivery.status, "claimed");
  f.db.fail = false;
  const r2 = f.create();
  await r2.init();
  await assert.rejects(r2.notification("claim", { day: 10 }), /已领取/);
});
test("登记损坏/丢失而快照仍在/原计划变化停止生成，不重置去重", async () => {
  const f = setup(),
    r = f.create();
  await r.init();
  await r.refresh();
  f.db.state = null;
  const r2 = f.create();
  await r2.init();
  assert.match(r2.error, /登记丢失/);
  const g = setup(),
    r3 = g.create();
  await r3.init();
  g.db.state.stages[0].delivery.status = "delivered";
  const r4 = g.create();
  await r4.init();
  assert.match(r4.error, /登记格式/);
  g.files.readPlan = async () => ({ ...plan, initialTicketIds: ["other"] });
  await r3.refresh();
  assert.match(r3.error, /身份变化/);
});
test("快照损坏拒绝下载/领取；无效day和format不能读任意文件", async () => {
  const f = setup(),
    r = f.create();
  await r.init();
  await r.refresh();
  f.db.bundles.get(3).markdown = "被改写";
  await assert.rejects(r.document(3), /校验/);
  await assert.rejects(r.notification("claim", { day: 3 }), /校验/);
  await assert.rejects(r.document("../plan"), /无效/);
  await assert.rejects(r.document(5, "html"), /无效/);
});
test("真实F盘文件原子写入与备份校验，缺失及损坏失败闭锁", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "r4-test-"));
  const files = new ReviewFiles({
    dir,
    stateFile: path.join(dir, "state.json"),
    backupFile: path.join(dir, "backup.json"),
  });
  assert.equal(await files.readState(), null);
  await files.writeState({ schema: 1, test: "中文" });
  assert.deepEqual(await files.readState(), { schema: 1, test: "中文" });
  await writeFile(path.join(dir, "state.json"), "broken");
  await assert.rejects(files.readState(), /不一致/);
  const b = { stage: 10, markdown: "中文报告" };
  await files.bundle(10, b);
  assert.deepEqual(await files.readBundle(10), b);
  await files.markdown(10, "正文");
  await assert.rejects(files.markdown(10, "不同正文"), /停止覆盖/);
  const wrapped = JSON.parse(
    await readFile(path.join(dir, "day-10.bundle.json"), "utf8"),
  );
  wrapped.data.markdown = "bad";
  await writeFile(
    path.join(dir, "day-10.bundle.json"),
    JSON.stringify(wrapped),
  );
  await assert.rejects(files.readBundle(10), /校验/);
});
test("实际Daily初始化及定时链路调用阶段准备，不写原账本", async () => {
  const f = setup();
  let ledgerWrites = 0,
    ticks = 0;
  const d = new Daily(
    {},
    {
      read: async () => ({ schema: 1, ...structuredClone(f.daily.data) }),
      write: async () => {
        ledgerWrites++;
      },
      calendar: { init: async () => {}, review: () => f.calendar },
      scheduler: {
        init: async () => {},
        decision: () => ({ task: null }),
        tick: async () => {
          ticks++;
        },
      },
    },
  );
  d.reports = new ReviewReports(d, {
    files: f.files,
    now: () => new Date("2026-11-13T09:00:00Z"),
  });
  await d.init();
  await d.tick();
  assert.equal(ticks, 1);
  assert.equal(ledgerWrites, 0);
  assert.equal(d.reports.state().stages[2].status, "prepared");
});
test("等待调度优先任务结束才生成；旧持仓未推进显示缺数而不伪称已到期", async () => {
  const f = setup(),
    r = f.create();
  f.daily.scheduler = { decision: () => ({ task: { kind: "recovery" } }) };
  await r.init();
  await r.refresh();
  assert.equal(f.db.bundleWrites, 0);
  f.daily.scheduler.decision = () => ({ task: null });
  f.daily.data.tickets = structuredClone(f.daily.data.tickets);
  f.daily.data.tickets[0].asOf = "2026-11-04";
  await r.refresh();
  const b = JSON.parse(await r.document(10, "json"));
  assert.equal(b.analysis.cohorts[0].groups[0].missing, 1);
  assert.equal(b.analysis.cohorts[0].groups[0].average, null);
});
test("报告快照文件失败不登记，阶段计数缺证据即使数目够也等待", async () => {
  const f = setup(),
    r = f.create();
  await r.init();
  f.calendar.planError = "缺计划";
  await r.refresh();
  assert.equal(f.db.bundleWrites, 0);
  delete f.calendar.planError;
  f.files.bundle = async () => {
    throw Error("snapshot disk fail");
  };
  await r.refresh();
  assert.match(r.error, /snapshot/);
  assert.equal(r.data.stages[0].delivery.status, "none");
});
