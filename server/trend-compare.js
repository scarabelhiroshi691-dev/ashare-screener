import { closure } from "./trading-calendar.js";
import { validateTrend } from "../shared/trend-rules.js";

export function ruleKey(record) {
  return JSON.stringify([record.ruleVersion, validateTrend(record.job.config)]);
}
export function comparable(job) {
  return (
    ["completed", "partial"].includes(job.status) &&
    job.items.every((i) => ["matched", "unmatched", "failed"].includes(i.state))
  );
}
const mapItems = (job) => new Map(job.items.map((i) => [i.stock.symbol, i]));
const qualifies = (item) => item?.state === "matched";
const evaluated = (item) => ["matched", "unmatched"].includes(item?.state);
const outcome = (item) =>
  item
    ? {
        state: item.state,
        error: item.error?.message || null,
        source: item.evidence?.historySource || item.source || null,
        checks: evaluated(item) ? item.evidence?.checks || [] : [],
      }
    : {
        state: "outside",
        error: "该期股票不在实际扫描池",
        source: null,
        checks: [],
      };

// Unobserved weekdays interrupt a streak unless the existing exchange calendar
// confirms closure. Never infer an open session from the weekday alone.
export function gapBetween(earlier, later) {
  const days = (Date.parse(later) - Date.parse(earlier)) / 86400000;
  if (days > 366) return { count: null, dates: [], interrupted: true };
  const dates = [];
  for (let i = 1; i < days; i++) {
    const date = new Date(Date.parse(earlier) + i * 86400000)
      .toISOString()
      .slice(0, 10);
    if (!closure(date)) dates.push(date);
  }
  return { count: dates.length, dates, interrupted: dates.length > 0 };
}
export function compareTrend(older, newer, intermediate = []) {
  const a = older.job,
    b = newer.job;
  if (a.date >= b.date) throw Error("请选择两个不同日期，较早日期在前");
  if (ruleKey(older) !== ruleKey(newer))
    throw Error("筛选规则或范围参数不同，不能比较新增和跌出");
  if (!comparable(a) || !comparable(b))
    throw Error("两期均须处理完扫描队列，未完成档案可单独查看");

  const before = mapItems(a),
    after = mapItems(b);
  const common = [...before.keys()].filter((s) => after.has(s)).length;
  const rows = [];
  for (const symbol of new Set([...before.keys(), ...after.keys()])) {
    const old = before.get(symbol),
      next = after.get(symbol);
    if (!qualifies(old) && !qualifies(next)) continue;
    let category = "unknown";
    if (evaluated(old) && evaluated(next)) {
      if (qualifies(old) && qualifies(next)) category = "retained";
      else category = qualifies(next) ? "added" : "removed";
    }
    const { name, code } = (next || old).stock;
    rows.push({
      symbol,
      name,
      code,
      category,
      before: outcome(old),
      after: outcome(next),
      streak: qualifies(next) ? 1 : 0,
    });
  }

  // Use one complete, compatible revision per date. Explicitly selected endpoints
  // take priority over other revisions on their dates.
  const byDate = new Map();
  for (const r of intermediate) {
    const j = r.job;
    if (
      j.date >= b.date ||
      j.date === a.date ||
      !comparable(j) ||
      ruleKey(r) !== ruleKey(newer)
    )
      continue;
    const previous = byDate.get(j.date);
    if (!previous || previous.job.finishedAt < j.finishedAt)
      byDate.set(j.date, r);
  }
  byDate.set(a.date, older);
  const history = [...byDate.values()].sort((x, y) =>
    y.job.date.localeCompare(x.job.date),
  );
  let nextDate = b.date;
  const candidates = new Set(rows.filter((r) => r.streak).map((r) => r.symbol));
  const currentRows = new Map(rows.map((r) => [r.symbol, r]));
  for (const { job } of history) {
    if (!candidates.size || gapBetween(job.date, nextDate).interrupted) break;
    const items = mapItems(job);
    for (const symbol of candidates) {
      if (qualifies(items.get(symbol))) currentRows.get(symbol).streak++;
      else candidates.delete(symbol);
    }
    nextDate = job.date;
  }
  const observed = [a.date, ...byDate.keys()].filter(
    (d) => d >= a.date && d < b.date,
  );
  const dates = [...new Set([...observed, b.date])].sort();
  const gaps = dates
    .slice(1)
    .map((d, i) => gapBetween(dates[i], d))
    .filter((g) => g.interrupted);
  return {
    olderDate: a.date,
    newerDate: b.date,
    common,
    olderOnly: before.size - common,
    newerOnly: after.size - common,
    poolChanged: before.size !== common || after.size !== common,
    gaps,
    counts: Object.fromEntries(
      ["added", "retained", "removed", "unknown"].map((c) => [
        c,
        rows.filter((r) => r.category === c).length,
      ]),
    ),
    rows: rows.sort((x, y) => x.symbol.localeCompare(y.symbol)),
  };
}
