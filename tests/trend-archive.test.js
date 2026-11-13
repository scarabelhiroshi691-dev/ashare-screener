import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readdir } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { TrendArchive } from "../server/trend-archive.js";
import { compareTrend, gapBetween } from "../server/trend-compare.js";
import { trendDefaults } from "../shared/trend-rules.js";
import { Trend } from "../server/trend.js";

const item = (n, state) => ({
  stock: {
    symbol: "sz" + String(n).padStart(6, "0"),
    code: String(n).padStart(6, "0"),
    name: "测试" + n,
  },
  state,
  source: "隔离样本",
  error: state === "failed" ? { message: "历史不足" } : null,
  evidence: ["matched", "unmatched"].includes(state)
    ? {
        metrics: { score: 77 },
        checks: [
          {
            pass: state === "matched",
            label: "回撤上限",
            detail: "实测12%",
            value: 12,
            threshold: 10,
          },
        ],
      }
    : null,
});
const job = (date, items, options = {}) => ({
  id: "test-" + date,
  date,
  status: "partial",
  finishedAt: date + "T09:00:00Z",
  config: { ...trendDefaults },
  target: items.length,
  items,
  ...options,
});
const record = (j) => ({ schema: 1, ruleVersion: 1, job: j });
const query = (a, opts) => new URLSearchParams({ v: a.version, ...opts });
const setup = async (opts) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "r6-archive-"));
  const a = new TrendArchive({ dir, ...opts });
  await a.init();
  return a;
};
const two = () => [
  record(
    job("2026-10-30", [
      item(1, "matched"),
      item(2, "unmatched"),
      item(3, "matched"),
      item(4, "matched"),
      item(5, "matched"),
      item(7, "failed"),
    ]),
  ),
  record(
    job("2026-11-02", [
      item(1, "matched"),
      item(2, "matched"),
      item(3, "unmatched"),
      item(4, "failed"),
      item(6, "matched"),
      item(7, "matched"),
    ]),
  ),
];
test("同条件分出新增、保留、跌出，数据失败和不在池中单列", () => {
  const c = compareTrend(...two());
  assert.deepEqual(c.counts, { added: 1, retained: 1, removed: 1, unknown: 4 });
  assert.equal(c.common, 5);
  assert.equal(c.poolChanged, true);
  const retained = c.rows.find((r) => r.code === "000001");
  assert.equal(retained.streak, 2);
  assert.equal(c.rows.find((r) => r.code === "000004").after.error, "历史不足");
  assert.equal(c.rows.find((r) => r.code === "000005").after.state, "outside");
  assert.equal(
    c.rows.find((r) => r.code === "000003").after.checks[0].threshold,
    10,
  );
});
test("条件和算法变动、未完成档案、同日与逆序拒绝比较", () => {
  const [a, b] = two();
  assert.throws(() => compareTrend(a, { ...b, ruleVersion: 2 }), /规则/);
  assert.throws(
    () =>
      compareTrend(a, {
        ...b,
        job: { ...b.job, config: { ...b.job.config, maxScan: 500 } },
      }),
    /范围/,
  );
  assert.throws(
    () => compareTrend(a, { ...b, job: { ...b.job, status: "paused" } }),
    /处理完/,
  );
  assert.throws(() => compareTrend(a, a), /不同日期/);
  assert.throws(() => compareTrend(b, a), /较早/);
});
test("已知周末不算缺档，漏过的工作日使连续符合中断", () => {
  assert.equal(gapBetween("2026-10-30", "2026-11-02").count, 0);
  const [a, b] = two();
  b.job.date = "2026-11-03";
  const c = compareTrend(a, b);
  assert.deepEqual(c.gaps[0].dates, ["2026-11-02"]);
  assert.equal(c.rows.find((r) => r.code === "000001").streak, 1);
  const mid = record(job("2026-11-02", [item(1, "matched")]));
  assert.equal(
    compareTrend(a, b, [mid, mid]).rows.find((r) => r.code === "000001").streak,
    3,
  );
  mid.job.items = [item(1, "failed")];
  assert.equal(
    compareTrend(a, b, [mid]).rows.find((r) => r.code === "000001").streak,
    1,
  );
});
test("同日重试只按最新完成档案计一次，所选端点优先", () => {
  const [a, b] = two();
  b.job.date = "2026-11-03";
  const mid = record(job("2026-11-02", [item(1, "matched")]));
  const retry = record(
    job("2026-11-02", [item(1, "failed")], {
      finishedAt: "2026-11-02T10:00:00Z",
    }),
  );
  const secondOlder = { ...a, job: { ...a.job, items: [item(1, "failed")] } };
  assert.equal(
    compareTrend(a, b, [retry, mid]).rows.find((r) => r.code === "000001")
      .streak,
    1,
  );
  assert.equal(
    compareTrend(a, b, [secondOlder, mid]).rows.find((r) => r.code === "000001")
      .streak,
    3,
  );
});
test("真实F盘隔离写入，重复归档只留一份，重启可读完整原任务", async () => {
  const a = await setup(),
    [r] = two(),
    before = JSON.stringify(r.job);
  const first = await a.capture(r.job),
    v = a.version;
  const other = await a.capture(r.job);
  assert.equal(first.id, other.id);
  assert.equal(a.version, v);
  assert.equal((await readdir(a.dir)).length, 1);
  const b = new TrendArchive({ dir: a.dir });
  await b.init();
  assert.equal(b.entries.length, 1);
  assert.equal(b.state().error, null);
  const exported = await b.export(query(b, { id: first.id }));
  assert.equal(JSON.stringify(JSON.parse(exported.body).job), before);
  assert.equal(JSON.stringify(r.job), before);
});
test("档案分页和比较元数据与版本绑定，完整导出独立于筛选", async () => {
  const a = await setup(),
    [x, y] = two();
  const prev = await a.capture(x.job),
    v = a.version;
  const curr = await a.capture(y.job);
  await assert.rejects(
    a.rows(new URLSearchParams({ v, id: prev.id })),
    (e) => e.status === 409,
  );
  const rows = await a.rows(
    query(a, {
      older: prev.id,
      newer: curr.id,
      type: "unknown",
      size: 3,
      page: 2,
    }),
  );
  assert.equal(rows.total, 4);
  assert.equal(rows.rows.length, 1);
  assert.equal(rows.summary.counts.removed, 1);
  const res = await a.rows(
    query(a, { id: curr.id, type: "failed", q: "000004" }),
  );
  assert.equal(res.rows[0].error, "历史不足");
  assert.equal(
    (await a.export(query(a, { id: curr.id, type: "failed", q: "无此股" })))
      .count,
    6,
  );
});
test("容量上限保留原档且允许重复核验；损坏锁定写入", async () => {
  const a = await setup({ maxFiles: 1 }),
    [x, y] = two(),
    old = await a.capture(x.job);
  await assert.rejects(a.capture(y.job), /容量上限/);
  assert.equal(a.entries.length, 1);
  assert.equal((await a.capture(x.job)).id, old.id);
  await writeFile(a.file(old.id), "corrupt");
  await assert.rejects(a.export(query(a, { id: old.id })), /校验失败/);
  const b = new TrendArchive({ dir: a.dir });
  await b.init();
  assert.match(b.state().error, /校验失败/);
  await assert.rejects(b.capture(y.job), /校验失败/);
  const tiny = await setup({ maxBytes: 10 });
  await assert.rejects(tiny.capture(x.job), /容量上限/);
});
test("进程中任务不归档，重复股票或缺证据不能保存", async () => {
  const a = await setup(),
    [x] = two();
  assert.equal(await a.capture({ ...x.job, status: "running" }), null);
  await assert.rejects(
    a.capture({
      ...x.job,
      target: 2,
      items: [item(1, "matched"), item(1, "unmatched")],
    }),
    /身份/,
  );
  const missing = item(8, "matched");
  missing.evidence = null;
  await assert.rejects(
    a.capture({ ...x.job, target: 1, items: [missing] }),
    /依据/,
  );
  assert.equal(a.entries.length, 0);
});
test("已有停稳任务无法归档时拒绝另开扫描，保留原任务", async () => {
  const a = await setup({ maxBytes: 10 }),
    [x] = two();
  let writes = 0;
  const t = new Trend(
    {
      market: { date: x.job.date },
      daily: {},
      running: () => false,
      refresh: { running: false },
      research: { active: false },
      checkResources: async () => {},
    },
    {
      read: async () => x.job,
      write: async () => {
        writes++;
      },
    },
  );
  t.job = x.job;
  t.archive = a;
  await assert.rejects(t.start(trendDefaults), /容量上限/);
  assert.equal(t.job, x.job);
  assert.equal(writes, 0);
  assert.equal(t.active, false);
});
