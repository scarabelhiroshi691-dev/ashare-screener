import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  buildReviewAnalysis,
  renderStageReport,
  summarizeRows,
  compareGroups,
  ticketView,
} from "../server/review-analysis.js";
import { buildCalendarReview } from "../server/trading-calendar.js";
const read = async (f) =>
  JSON.parse(await readFile(new URL("../" + f, import.meta.url), "utf8"));
const { ledger, plan, comparison, evidence } = await read(
  "tests/fixtures/review-2026-11-06.json",
);
const calendar = buildCalendarReview({
  ledger,
  plan,
  evidence,
  now: new Date("2026-11-07T01:00:00Z"),
});

test("合成首批52/10按原ID统计，后续32未成熟不混入；原对象不变", () => {
  const before = JSON.stringify({ ledger, plan, comparison });
  const a = buildReviewAnalysis(ledger, plan, calendar, comparison);
  const [s, w] = a.cohorts[0].groups;
  assert.equal(s.completed, 52);
  assert.equal(w.completed, 10);
  assert.equal(s.average, (51 * 3 - 6) / 52);
  assert.equal(w.average, (9 - 4) / 10);
  assert.equal(
    a.cohorts[1].groups.reduce((n, g) => n + g.unfinished, 0),
    32,
  );
  for (const g of a.cohorts[1].groups) {
    assert.equal(g.average, null);
    assert.equal(g.winRate, null);
  }
  assert.match(a.cohorts[0].conclusion, /指标有分歧/);
  assert.match(a.cohorts[0].conclusion, /最差单笔日常波段/);
  assert.equal(JSON.stringify({ ledger, plan, comparison }), before);
  assert.equal(a.dailyIssues.filter((i) => i.date === "2026-11-06").length, 1);
  assert.match(a.dailyIssues.at(-1).retry, /不反复重试/);
  assert.equal(a.weeks[0].date, "2026-11-02");
});
test("缺失首批ID仍显示缺数，不能变成完整比较", () => {
  const l = structuredClone(ledger);
  l.tickets.shift();
  const a = buildReviewAnalysis(l, plan, calendar, comparison);
  assert.equal(a.cohorts[0].groups[0].total, 52);
  assert.equal(a.cohorts[0].groups[0].missing, 1);
  assert.match(a.cohorts[0].conclusion, /暂不成立/);
});
test("策略漂移及冻结结果变化阻止报告", () => {
  const l = structuredClone(ledger);
  l.plans[0].hold = 4;
  assert.throws(
    () => buildReviewAnalysis(l, plan, calendar, comparison),
    /策略/,
  );
  const m = structuredClone(ledger);
  m.tickets[0].net += 1;
  assert.throws(
    () => buildReviewAnalysis(m, plan, calendar, comparison),
    /冻结/,
  );
});
test("浮动收益、错误、晚于核验截止日、不完整退出不计入已完成", () => {
  const rows = [
    { state: "holding", markNet: 50 },
    { state: "exit-wait", markNet: 80 },
    { state: "closed", net: null, exitDate: "2026-11-06" },
    { state: "closed", net: 90, exitDate: "2026-11-09" },
    { state: "pending", error: "缺少日线" },
    { state: "closed", net: -2, exitDate: "2026-11-06", delayed: 1 },
    { state: "closed", net: 4, exitDate: "2026-11-06" },
    { state: "skipped", reason: "一字" },
  ].map((t) => ticketView(t, "2026-11-06"));
  const s = summarizeRows(rows);
  assert.equal(s.completed, 2);
  assert.equal(s.average, 1);
  assert.equal(s.median, 1);
  assert.equal(s.winRate, 50);
  assert.equal(s.missing, 3);
  assert.equal(s.delayed, 2);
  assert.equal(s.states.skipped, 1);
});
test("指标分歧不强给赢家，零盈利不算盈利", () => {
  const g = [
    {
      total: 2,
      completed: 2,
      name: "甲",
      average: 2,
      median: 1,
      winRate: 50,
      worst: -5,
    },
    {
      total: 2,
      completed: 2,
      name: "乙",
      average: 1,
      median: 2,
      winRate: 60,
      worst: -2,
    },
  ];
  assert.match(compareGroups(g), /分歧/);
  assert.match(compareGroups(g), /平均甲较好/);
  assert.equal(summarizeRows([{ complete: true, net: 0 }]).winRate, 0);
});
test("第10报告包含批次、入场周、失败、遗漏及实际补报日期", () => {
  const analysis = buildReviewAnalysis(ledger, plan, calendar, comparison);
  const md = renderStageReport({
    day: 10,
    dueDate: "2026-11-05",
    preparedAt: "2026-11-07T01:00:00Z",
    analysis,
    calendar,
  });
  for (const s of [
    "后续批次 2026-11-06",
    "入场周",
    "合成历史不足样本",
    "2026-11-02",
    "恢复后补报",
    "32",
    "不自动延长",
  ])
    assert.ok(md.includes(s), s);
});
