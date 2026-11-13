import { randomUUID } from "node:crypto";
import { trendCSV } from "../src/trend-export.js";
import { openStates, paperStats } from "./paper-ledger.js";

const same = (a, b) => a?.length === b.length && b.every((x, i) => x === a[i]);
const omit = (data, ...keys) =>
  Object.fromEntries(
    Object.entries(data || {}).filter(([k]) => !keys.includes(k)),
  );
const names = {
  pending: "待入场",
  holding: "模拟持有",
  "exit-wait": "等待可退出日线",
  closed: "已模拟退出",
  skipped: "跳过入场",
};
const csvCell = (v) =>
  '"' +
  (typeof v === "number"
    ? String(v)
    : String(v ?? "").replace(/^[\s]*[=+@-]/, "'$&")
  ).replaceAll('"', '""') +
  '"';

export function dailyCSV(data, method) {
  const plans = new Map(data.plans.map((p) => [p.id, p.name]));
  const rows = [
    ["口径", method],
    ["启用时间", data.activatedAt],
    [
      "代码",
      "名称",
      "策略",
      "版本指纹",
      "信号日",
      "登记时间",
      "状态",
      "入场日",
      "退出日",
      "持有日",
      "净收益%",
      "按最新收盘假设退出净变化%",
      "日线来源",
      "截至",
      "问题",
    ],
    ...data.tickets.map((t) => [
      t.symbol,
      t.name,
      plans.get(t.planId),
      t.ruleHash,
      t.signalDate,
      t.registeredAt,
      names[t.state],
      t.entryDate,
      t.exitDate,
      t.hold,
      t.net,
      t.markNet,
      t.source,
      t.asOf,
      t.error || t.reason,
    ]),
  ];
  return "\ufeff" + rows.map((r) => r.map(csvCell).join(",")).join("\r\n");
}

function choice(query, key, allowed, fallback) {
  const value = query.get(key) ?? fallback;
  if (!allowed.includes(value)) throw Error("无效的列表筛选或排序");
  return value;
}
export function paginate(rows, query) {
  const page = Number(query.get("page") ?? 1),
    size = Number(query.get("size") ?? 20);
  if (
    !Number.isSafeInteger(page) ||
    page < 1 ||
    !Number.isSafeInteger(size) ||
    size < 1 ||
    size > 100
  )
    throw Error("页码须为正整数，每页最多100条");
  const pages = Math.max(1, Math.ceil(rows.length / size));
  const current = Math.min(page, pages),
    start = (current - 1) * size;
  return {
    page: current,
    pages,
    size,
    total: rows.length,
    rows: rows.slice(start, start + size),
  };
}
function searchRows(rows, query) {
  const q = (query.get("q") || "").trim().toLowerCase();
  if (q.length > 80) throw Error("搜索最多80个字符");
  return q
    ? rows.filter((row) =>
        [row.name, row.code, row.symbol].some((x) =>
          x?.toLowerCase().includes(q),
        ),
      )
    : rows;
}
function requireVersion(snapshot, query) {
  if (query.get("v") !== snapshot.version)
    throw Object.assign(Error("数据已更新，请按新版本重新读取"), {
      status: 409,
    });
}
function summarizeDays(data) {
  return [...data.days].reverse().flatMap((d) =>
    d.plans.map((p) => ({
      date: d.date,
      coverage: d.coverage,
      planId: p.planId,
      baseCount: p.baseCount,
      notScanned: p.notScanned,
      scanned: p.items.length,
      matched: p.items.filter((i) => i.state === "matched").length,
      added: p.items.filter((i) => i.ticketId).length,
      unmatched: p.items.filter((i) => i.state === "unmatched").length,
      failed: p.items.filter((i) => i.state === "failed").length,
      pending: p.items.filter(
        (i) => !["matched", "unmatched", "failed"].includes(i.state),
      ).length,
    })),
  );
}
function reportSummary(analysis) {
  if (!analysis) return null;
  const groups = (list) => list.map((g) => omit(g, "rows"));
  const cohorts = (list) =>
    list.map((c) => ({ ...c, groups: groups(c.groups) }));
  return {
    ...omit(analysis, "dailyIssues"),
    cohorts: cohorts(analysis.cohorts),
    weeks: cohorts(analysis.weeks),
    totals: groups(analysis.totals),
    issueCount: analysis.dailyIssues.length,
  };
}

// Keep just one immutable view per source. Existing summary arrays are replaced by
// summarizeJob, and Daily replaces committed after a successful save or restore.
export class StatusViews {
  cache = new Map();
  constructor(store) {
    this.store = store;
  }
  snapshot(kind) {
    const { trend, daily } = this.store;
    if (kind === "trend") {
      const j = trend.job;
      return this.cached(
        kind,
        [
          j,
          j?.results,
          j?.errors,
          j?.status,
          j?.finishedAt,
          j?.priorityYield,
          j?.priorityYield?.autoResume,
          j?.fatal,
        ],
        () => {
          const job = trend.state().job;
          return { job, items: structuredClone(j?.items || []) };
        },
      );
    }
    if (kind === "daily") {
      const data = daily.committed || daily.data;
      return this.cached(kind, [data], () => ({
        data,
        days: summarizeDays(data),
        stats: paperStats(data.tickets, data.plans),
      }));
    }
    if (kind === "reports") {
      const r = daily.reports,
        c = daily.calendarReview();
      return this.cached(
        kind,
        [
          daily.committed || daily.data,
          r.data,
          JSON.stringify([
            c.asOf,
            c.count,
            c.exact,
            c.missed,
            c.incomplete,
            c.unverified,
          ]),
        ],
        () => {
          const full = r.state();
          return { full, summary: reportSummary(full.analysis) };
        },
      );
    }
    throw Error("未知的列表");
  }
  cached(kind, key, build) {
    const old = this.cache.get(kind);
    if (same(old?.key, key)) return old;
    const result = { key, version: randomUUID(), ...build() };
    this.cache.set(kind, result);
    return result;
  }
  status(kind) {
    const snapshot = this.snapshot(kind),
      { version } = snapshot;
    const { trend, daily } = this.store;
    if (kind === "trend")
      return { version, ...trend.state({ summaryOnly: true }) };
    if (kind === "daily") {
      const state = daily.state(snapshot.data, snapshot.stats);
      return {
        version,
        ...omit(state, "days", "tickets", "providerStatus"),
        dayCount: snapshot.data.days.length,
        ticketCount: snapshot.data.tickets.length,
        job: state.job
          ? {
              ...omit(state.job, "errors"),
              issueCount: state.job.errors?.length || 0,
            }
          : null,
      };
    }
    return {
      version,
      ...omit(snapshot.full, "analysis"),
      active: daily.active || daily.reports.busy,
      busy: daily.reports.busy,
      error: daily.reports.error || snapshot.full.error,
      analysis: snapshot.summary,
    };
  }
  rows(kind, query) {
    const snapshot = this.snapshot(kind);
    requireVersion(snapshot, query);
    let rows;
    if (kind === "trend") {
      const type = choice(
        query,
        "type",
        ["matched", "unmatched", "failed", "pending"],
        "matched",
      );
      const job = snapshot.job;
      const failed = new Set(job?.errors.map((e) => e.symbol));
      const data = {
        matched: job?.results,
        unmatched: job?.unmatchedResults,
        failed: job?.errors,
      };
      if (type === "pending")
        data.pending = snapshot.items
          .filter(
            (i) =>
              ["pending", "running"].includes(i.state) &&
              !failed.has(i.stock.symbol),
          )
          .map((i) => ({ ...i.stock, state: i.state }));
      rows = searchRows(data[type] || [], query);
      const sort = choice(
        query,
        "sort",
        ["score", "windowReturn", "maxDrawdown"],
        "score",
      );
      if (type === "matched" || type === "unmatched")
        rows = [...rows].sort(
          (a, b) =>
            (sort === "maxDrawdown"
              ? a.metrics[sort] - b.metrics[sort]
              : b.metrics[sort] - a.metrics[sort]) ||
            a.symbol.localeCompare(b.symbol),
        );
    } else if (kind === "daily") {
      rows = this.dailyRows(snapshot, query);
    } else {
      const analysis = snapshot.full.analysis;
      if (query.get("type") === "issues") rows = analysis?.dailyIssues || [];
      else {
        const cohort = analysis?.cohorts.find(
          (c) => c.key === query.get("cohort"),
        );
        const filter = choice(
          query,
          "filter",
          ["all", "open", "issues"],
          "all",
        );
        rows = (cohort?.groups || [])
          .flatMap((g) => g.rows.map((t) => ({ ...t, planName: g.name })))
          .filter(
            (t) =>
              filter === "all" ||
              (filter === "open"
                ? openStates.includes(t.state)
                : t.missing || t.delayed || t.state === "skipped"),
          );
      }
      rows = searchRows(rows, query);
    }
    return { version: snapshot.version, ...paginate(rows, query) };
  }
  dailyRows(snapshot, query) {
    const { data, days } = snapshot;
    const type = choice(
      query,
      "type",
      ["tickets", "days", "day-items", "job-issues"],
      "tickets",
    );
    if (type === "days") return days;
    if (type === "job-issues") return data.job?.errors || [];
    const plan = choice(
      query,
      "plan",
      ["all", ...data.plans.map((p) => p.id)],
      "all",
    );
    if (type === "day-items") {
      const d = data.days.find((x) => x.date === query.get("date"));
      const filter = choice(
        query,
        "filter",
        ["all", "matched", "unmatched", "failed", "pending"],
        "all",
      );
      return searchRows(
        (d?.plans || [])
          .filter((p) => plan === "all" || p.planId === plan)
          .flatMap((p) =>
            p.items.map((i) => ({
              planId: p.planId,
              name: i.stock.name,
              code: i.stock.code,
              symbol: i.stock.symbol,
              state: i.state,
              ticketId: i.ticketId,
              error: i.error,
              checks: i.checks,
              attempts: i.attempts,
            })),
          )
          .filter((i) => filter === "all" || filter === i.state),
        query,
      );
    }
    const filter = choice(query, "filter", ["all", "open", "closed"], "open");
    const sort = choice(query, "sort", ["recent", "net", "code"], "recent");
    const list = searchRows(
      data.tickets.filter(
        (t) =>
          (plan === "all" || t.planId === plan) &&
          (filter === "all" ||
            (filter === "open"
              ? openStates.includes(t.state)
              : t.state === "closed")),
      ),
      query,
    )
      .slice()
      .reverse();
    if (sort === "code")
      list.sort(
        (a, b) => a.code.localeCompare(b.code) || a.id.localeCompare(b.id),
      );
    if (sort === "net")
      list.sort(
        (a, b) =>
          (b.net ?? -Infinity) - (a.net ?? -Infinity) ||
          a.id.localeCompare(b.id),
      );
    return list;
  }
  export(kind, query) {
    const snapshot = this.snapshot(kind);
    requireVersion(snapshot, query);
    const format = choice(query, "format", ["json", "csv"], "json");
    if (kind === "trend") {
      if (this.store.trend.active || !snapshot.job)
        throw Error("请等待趋势任务停稳后导出");
      const { job, items } = snapshot;
      return {
        name: `trend-${job.date}.${format}`,
        format,
        count: format === "csv" ? job.results.length : items.length,
        body:
          format === "csv"
            ? trendCSV(job)
            : JSON.stringify(
                { job: omit(job, "unmatchedResults"), items },
                null,
                2,
              ),
      };
    }
    if (kind === "daily") {
      if (this.store.daily.active || this.store.daily.storage?.status().blocked)
        throw Error("请等待复盘结束或恢复账本后导出");
      const state = this.store.daily.state(snapshot.data, snapshot.stats);
      return {
        name: `paper-ledger.${format}`,
        format,
        count: snapshot.data.tickets.length,
        body:
          format === "csv"
            ? dailyCSV(snapshot.data, state.method)
            : JSON.stringify(state, null, 2),
      };
    }
    throw Error("阶段报告请使用原报告文件入口");
  }
}
