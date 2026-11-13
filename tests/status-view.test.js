import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { StatusViews, paginate } from "../server/status-view.js";
import { Trend } from "../server/trend.js";
import { summarizeJob } from "../server/scan-runner.js";
import { trendCSV } from "../src/trend-export.js";
import { buildReviewAnalysis } from "../server/review-analysis.js";
import { buildCalendarReview } from "../server/trading-calendar.js";
const fixture = JSON.parse(
  readFileSync(
    new URL("./fixtures/review-2026-11-06.json", import.meta.url),
    "utf8",
  ),
);

function setup(count = 1786) {
  const trend = new Trend({});
  const items = Array.from({ length: count }, (_, i) => {
    const code = String(i + 1).padStart(6, "0");
    const stock = { name: `样本 ${i + 1}`, code, symbol: "sz" + code };
    const evidence = {
      ...stock,
      metrics: { score: i % 17, windowReturn: i % 23, maxDrawdown: i % 11 },
      checks: [{ pass: false, label: "最大回撤", detail: "原始失败理由" }],
    };
    return i < 8
      ? { stock, state: "matched", result: evidence }
      : i >= count - 21
        ? {
            stock,
            state: "failed",
            error: { message: "历史日线不足", kind: "data" },
          }
        : { stock, state: "unmatched", evidence };
  });
  trend.job = summarizeJob({
    id: "job",
    date: "2026-10-30",
    target: count,
    status: "partial",
    config: { lookback: 120 },
    items,
  });
  const { ledger, plan, evidence, comparison } = structuredClone(fixture);
  const calendar = buildCalendarReview({
    ledger,
    plan,
    evidence,
    now: new Date("2026-11-07T01:00:00Z"),
  });
  const daily = {
    data: ledger,
    committed: ledger,
    active: false,
    calendarReview: () => calendar,
    state: (data, stats) => ({ ...data, stats, method: "固定模拟" }),
    reports: {
      data: {},
      state: () => ({
        analysis: buildReviewAnalysis(ledger, plan, calendar, comparison),
        stages: [],
        calendar,
      }),
    },
  };
  return { views: new StatusViews({ trend, daily }), trend, daily, calendar };
}
const params = (v, extra = {}) => new URLSearchParams({ v, ...extra });
function gather(views, kind, version, extra = {}) {
  let page = 1,
    rows = [],
    result;
  do {
    result = views.rows(kind, params(version, { ...extra, page }));
    assert.equal(result.version, version);
    rows.push(...result.rows);
    page++;
  } while (page <= result.pages);
  assert.equal(rows.length, result.total);
  return rows;
}
test("1786趋势项分页逐项等于原名单，末页与完整导出一致", () => {
  const { views, trend } = setup();
  const state = views.status("trend"),
    { version } = state,
    old = trend.state().job;
  assert.equal(state.job.results, undefined);
  assert.equal(state.job.errors, undefined);
  assert.equal(state.job.unmatchedResults, undefined);
  const matched = gather(views, "trend", version);
  const unmatched = gather(views, "trend", version, { type: "unmatched" });
  const failed = gather(views, "trend", version, { type: "failed" });
  assert.deepEqual(matched, old.results);
  assert.deepEqual(unmatched, old.unmatchedResults);
  assert.deepEqual(failed, old.errors);
  assert.equal(
    new Set([...matched, ...unmatched, ...failed].map((x) => x.symbol)).size,
    1786,
  );
  assert.deepEqual(
    JSON.parse(views.export("trend", params(version)).body).items,
    JSON.parse(JSON.stringify(trend.job.items)),
  );
  assert.equal(
    views.export("trend", params(version, { format: "csv" })).body,
    trendCSV(old),
  );
  const last = views.rows(
    "trend",
    params(version, { type: "unmatched", page: 999 }),
  );
  assert.equal(last.page, 88);
  assert.equal(last.rows.length, 17);
  assert.equal(views.status("trend").version, version);
});
test("搜索全名单的尾部与前导零，排序按全范围，筛选不改变导出", () => {
  const { views } = setup();
  const { version } = views.status("trend");
  const all = gather(views, "trend", version, {
    type: "unmatched",
    sort: "maxDrawdown",
  });
  assert.ok(
    all.every(
      (x, i) =>
        i === 0 || all[i - 1].metrics.maxDrawdown <= x.metrics.maxDrawdown,
    ),
  );
  const code = "001765";
  assert.equal(
    gather(views, "trend", version, { type: "unmatched", q: code })[0].code,
    code,
  );
  assert.equal(
    views.export(
      "trend",
      params(version, { q: code, type: "unmatched", page: 88 }),
    ).count,
    1786,
  );
});
test("同任务等数量的结果变化也拒绝旧版页和导出，重新取状态可恢复", () => {
  const { views, trend } = setup();
  const { version } = views.status("trend");
  trend.job.items[0].result = { ...trend.job.items[0].result, name: "更新" };
  summarizeJob(trend.job);
  for (const call of ["rows", "export"])
    assert.throws(
      () => views[call]("trend", params(version)),
      (e) => e.status === 409,
    );
  const now = views.status("trend");
  assert.notEqual(now.version, version);
  assert.equal(gather(views, "trend", now.version, { q: "更新" }).length, 1);
  trend.job = { ...trend.job, id: "next", date: "2026-11-06" };
  assert.notEqual(views.status("trend").version, now.version);
});
test("失败重试进行中仍归原失败分类，待处理页不重复", () => {
  const { views, trend } = setup();
  trend.job.items.at(-1).state = "running";
  trend.active = true;
  const { version } = views.status("trend");
  assert.equal(gather(views, "trend", version, { type: "failed" }).length, 21);
  assert.equal(gather(views, "trend", version, { type: "pending" }).length, 0);
  assert.throws(() => views.export("trend", params(version)), /停稳/);
});
test("模拟账本94条完整分页和原JSON，按代码／状态筛选不影响CSV", () => {
  const { views, daily } = setup();
  const s = views.status("daily");
  assert.equal(s.tickets, undefined);
  assert.equal(s.days, undefined);
  assert.equal(s.ticketCount, 94);
  assert.equal(gather(views, "daily", s.version).length, 32);
  assert.equal(
    gather(views, "daily", s.version, { filter: "closed" }).length,
    62,
  );
  assert.deepEqual(
    gather(views, "daily", s.version, { filter: "all" }),
    daily.data.tickets.slice().reverse(),
  );
  const exported = views.export(
    "daily",
    params(s.version, { format: "json", filter: "closed", page: 9 }),
  );
  assert.deepEqual(JSON.parse(exported.body).tickets, daily.data.tickets);
  const csv = views.export(
    "daily",
    params(s.version, { format: "csv", q: "无此股票" }),
  );
  assert.equal(csv.count, 94);
  assert.equal(csv.body.split("\r\n").length, 97);
});
test("模拟超过旧200条上限仍全部可访问，末页与过滤排序正确", () => {
  const { views, daily } = setup();
  const t = daily.data.tickets[0];
  daily.committed = {
    ...daily.data,
    tickets: Array.from({ length: 241 }, (_, i) => ({
      ...t,
      id: "fixture-" + i,
      code: String(i).padStart(6, "0"),
      net: i,
    })),
  };
  const { version } = views.status("daily");
  const rows = gather(views, "daily", version, { filter: "all", sort: "net" });
  assert.equal(rows.length, 241);
  assert.equal(rows[0].net, 240);
  assert.equal(rows.at(-1).net, 0);
  assert.equal(
    views.rows("daily", params(version, { filter: "all", page: 13 })).rows
      .length,
    1,
  );
  assert.equal(views.export("daily", params(version)).count, 241);
  daily.committed = { ...daily.committed, tickets: [] };
  assert.throws(
    () => views.rows("daily", params(version)),
    (e) => e.status === 409,
  );
});
test("复盘留档摘要与逐日股票保持同版本，筛选失败可追溯", () => {
  const { views, daily } = setup();
  const { version } = views.status("daily");
  const rows = gather(views, "daily", version, { type: "days" });
  assert.equal(rows.length, 4);
  const target = rows.find(
    (x) => x.date === "2026-11-06" && x.planId === "daily-swing-v1",
  );
  const items = gather(views, "daily", version, {
    type: "day-items",
    date: target.date,
    plan: target.planId,
    filter: "failed",
  });
  assert.equal(items.length, target.failed);
  assert.equal(items[0].code, "688999");
  assert.match(items[0].error, /不足/);
  assert.deepEqual(
    JSON.parse(views.export("daily", params(version)).body).days,
    daily.data.days,
  );
});
test("报告摘要没有逐股数组，首批62和后续32分页，状态变动保留通知隔离", () => {
  const { views, daily } = setup();
  const s = views.status("reports");
  assert.equal(s.analysis.cohorts[0].groups[0].rows, undefined);
  assert.equal(s.analysis.totals[0].rows, undefined);
  assert.equal(s.analysis.dailyIssues, undefined);
  assert.equal(
    gather(views, "reports", s.version, { cohort: "first" }).length,
    62,
  );
  assert.equal(
    gather(views, "reports", s.version, {
      cohort: "2026-11-06",
      filter: "open",
    }).length,
    32,
  );
  assert.equal(
    gather(views, "reports", s.version, { type: "issues" }).length,
    s.analysis.issueCount,
  );
  assert.equal(views.status("reports").version, s.version);
  daily.reports.data = { stages: [] };
  assert.throws(
    () => views.rows("reports", params(s.version, { cohort: "first" })),
    (e) => e.status === 409,
  );
});
test("无结果、无效页和页长的边界", () => {
  assert.deepEqual(paginate([], new URLSearchParams("page=5")), {
    page: 1,
    pages: 1,
    size: 20,
    total: 0,
    rows: [],
  });
  for (const p of ["page=0", "page=1.5", "size=0", "size=101", "page=Infinity"])
    assert.throws(() => paginate([], new URLSearchParams(p)), /页码/);
});
