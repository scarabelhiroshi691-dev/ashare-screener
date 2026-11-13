import { chinaClock, isCompletedDate } from "../shared/time.js";
import { CALENDAR_URL } from "./sina-history.js";

export const holidaySources = [
  {
    name: "上交所2026年休市通知",
    published: "2025-12-22",
    url: "https://www.sse.com.cn/disclosure/announcement/general/c/c_20251222_10802507.shtml",
  },
  {
    name: "深交所2026年休市通知",
    published: "2025-12-22",
    url: "https://investor.szse.cn/disclosure/notice/general/t20251222_618087.html",
  },
];
const holidays = [
  ["2026-01-01", "2026-01-03", "元旦"],
  ["2026-02-15", "2026-02-23", "春节"],
  ["2026-04-04", "2026-04-06", "清明节"],
  ["2026-05-01", "2026-05-05", "劳动节"],
  ["2026-06-19", "2026-06-21", "端午节"],
  ["2026-09-25", "2026-09-27", "中秋节"],
  ["2026-10-01", "2026-10-07", "国庆节"],
];
export function validDate(date) {
  return (
    typeof date === "string" &&
    /^\d{4}-\d{2}-\d{2}$/.test(date) &&
    Number.isFinite(Date.parse(date)) &&
    new Date(date).toISOString().slice(0, 10) === date
  );
}
export function closure(date) {
  if (!validDate(date)) return null;
  const holiday = holidays.find(([a, b]) => a <= date && date <= b);
  if (holiday)
    return { reason: holiday[2], source: "沪深交易所2026年休市通知" };
  if ([0, 6].includes(new Date(date + "T00:00:00Z").getUTCDay()))
    return { reason: "周末休市", source: "周末不交易；调休工作日不视为开市" };
  return null; // A weekday is not positive evidence of an open market.
}
export function verificationTarget(now = new Date()) {
  const cursor = new Date(chinaClock(now).date + "T00:00:00Z");
  for (let i = 0; i < 40; i++, cursor.setUTCDate(cursor.getUTCDate() - 1)) {
    const date = cursor.toISOString().slice(0, 10);
    if (isCompletedDate(date, now) && !closure(date)) return date;
  }
  return null;
}
function validStamp(value) {
  return (
    typeof value === "string" &&
    /T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value) &&
    Number.isFinite(Date.parse(value))
  );
}
function numeric(value) {
  if (
    (typeof value !== "number" && typeof value !== "string") ||
    String(value).trim() === ""
  )
    return NaN;
  return Number(value);
}
export function parseCalendarEvidence(
  { rows, fetchedAt, source },
  now = new Date(),
) {
  if (
    source !== CALENDAR_URL ||
    !validStamp(fetchedAt) ||
    Date.parse(fetchedAt) > now.getTime() ||
    !Array.isArray(rows) ||
    !rows.length ||
    rows.length > 1023
  )
    throw Error("交易日来源、采集时间或日线列表无效");
  const seen = new Set(),
    evidence = [],
    excluded = { zeroVolume: 0, incomplete: 0 };
  for (const row of rows) {
    const date = row?.day;
    if (!validDate(date) || seen.has(date))
      throw Error("交易日日线日期非法或重复");
    seen.add(date);
    const bar = Object.fromEntries(
      ["open", "close", "high", "low", "volume"].map((k) => [
        k,
        numeric(row[k]),
      ]),
    );
    if (
      Object.values(bar).some((v) => !Number.isFinite(v)) ||
      bar.volume < 0 ||
      [bar.open, bar.close, bar.high, bar.low].some((v) => v <= 0) ||
      bar.high < Math.max(bar.open, bar.close, bar.low) ||
      bar.low > Math.min(bar.open, bar.close, bar.high)
    )
      throw Error("交易日日线价格或成交量缺失/非法");
    if (bar.volume === 0) {
      excluded.zeroVolume++;
      continue;
    }
    // The capture time is decisive. A cached intraday bar never matures by waiting.
    if (
      !isCompletedDate(date, new Date(fetchedAt)) ||
      !isCompletedDate(date, now)
    ) {
      excluded.incomplete++;
      continue;
    }
    evidence.push({ date, ...bar, fetchedAt, source });
  }
  if (!evidence.length) throw Error("没有合法、正成交且已完成的交易日日线");
  return {
    evidence: evidence.sort((a, b) => a.date.localeCompare(b.date)),
    excluded,
  };
}
export function validateEvidenceCache(evidence, now) {
  if (!Array.isArray(evidence) || evidence.length > 4000)
    throw Error("交易日缓存超限或格式异常");
  const seen = new Set();
  for (const e of evidence) {
    if (seen.has(e?.date)) throw Error("交易日缓存日期重复");
    seen.add(e?.date);
    const parsed = parseCalendarEvidence(
      {
        rows: [{ ...e, day: e?.date }],
        source: e?.source,
        fetchedAt: e?.fetchedAt,
      },
      now,
    );
    if (parsed.evidence.length !== 1) throw Error("交易日缓存包含未完成日线");
  }
  return evidence;
}
function snapshotEvidence(day, now) {
  if (
    !validDate(day?.date) ||
    !validStamp(day.snapshotFetchedAt) ||
    !validStamp(day.createdAt) ||
    Date.parse(day.snapshotFetchedAt) > now.getTime() ||
    Date.parse(day.createdAt) > now.getTime() ||
    chinaClock(day.snapshotFetchedAt).date !== day.date ||
    chinaClock(day.createdAt).date !== day.date ||
    !isCompletedDate(day.date, new Date(day.snapshotFetchedAt)) ||
    !isCompletedDate(day.date, new Date(day.createdAt)) ||
    !(day.coverage > 0)
  )
    return null;
  const stock = day.plans
    ?.flatMap((p) => p.items || [])
    .map((i) => i.stock)
    .find(
      (s) =>
        s?.quoteDate === day.date &&
        Number.isFinite(s.volume) &&
        s.volume > 0 &&
        s.source &&
        validStamp(s.quoteAt) &&
        chinaClock(s.quoteAt).date === day.date &&
        isCompletedDate(day.date, new Date(s.quoteAt)) &&
        Date.parse(s.quoteAt) <= Date.parse(day.snapshotFetchedAt),
    );
  return stock
    ? {
        kind: "snapshot",
        source: stock.source,
        fetchedAt: day.snapshotFetchedAt,
      }
    : null;
}

export function buildCalendarReview({
  ledger,
  evidence = [],
  plan = null,
  now = new Date(),
  active = false,
}) {
  const today = chinaClock(now),
    baseline =
      plan?.baselineSignalDate ||
      (ledger.activatedAt ? chinaClock(ledger.activatedAt).date : null);
  const result = {
    baseline,
    asOf: null,
    baselineCovered: false,
    confirmedDates: [],
    count: 0,
    exact: false,
    missed: [],
    incomplete: [],
    issues: [],
    unverified: [],
    closed: [],
    dates: [],
    checkpoints: [],
    holidaySources,
  };
  if (!validDate(baseline) || baseline > today.date) return result;
  const byDate = new Map();
  for (const e of evidence) {
    if (
      e.date >= baseline &&
      e.date <= today.date &&
      isCompletedDate(e.date, now)
    )
      byDate.set(e.date, [
        { kind: "index", source: e.source, fetchedAt: e.fetchedAt },
      ]);
  }
  const days = ledger.days || [];
  for (const day of days) {
    const proof = snapshotEvidence(day, now);
    if (proof) byDate.set(day.date, [...(byDate.get(day.date) || []), proof]);
  }
  const cursor = new Date(baseline + "T00:00:00Z");
  for (let i = 0; i < 4000; i++, cursor.setUTCDate(cursor.getUTCDate() + 1)) {
    const date = cursor.toISOString().slice(0, 10);
    if (date > today.date) break;
    const shut = closure(date),
      proof = byDate.get(date),
      day = days.find((d) => d.date === date);
    const row = {
      date,
      market: "unverified",
      review: "unverified",
      evidence: proof || [],
    };
    if (shut && proof) row.reason = "完成行情与休市规则冲突，等待核验";
    else if (shut) {
      Object.assign(row, {
        market: "closed",
        review: "closed",
        reason: shut.reason,
      });
      result.closed.push(date);
    } else if (proof) {
      row.market = "open";
      result.asOf = date;
      if (date === baseline) result.baselineCovered = true;
      else result.confirmedDates.push(date);
      if (day) {
        const plans = ledger.plans || [];
        const missingPlan = plans.some(
          (p) => !day.plans?.some((x) => x.planId === p.id),
        );
        const items = day.plans?.flatMap((p) => p.items || []) || [];
        row.pending = items.filter(
          (i) => !["matched", "unmatched", "failed"].includes(i.state),
        ).length;
        row.failed = items.filter((i) => i.state === "failed").length;
        row.review =
          missingPlan || row.pending
            ? "incomplete"
            : row.failed
              ? "issues"
              : "complete";
        if (row.review === "incomplete") result.incomplete.push(date);
        if (row.review === "issues") result.issues.push(date);
      } else if (date < today.date) {
        row.review = "missed";
        result.missed.push(date);
      } else
        row.review = active
          ? "running"
          : today.minutes < 980
            ? "awaiting"
            : "due";
    } else {
      row.reason = "缺少已完成开市行情证据，不能仅按工作日计数";
      if (date === today.date && today.minutes < 910) {
        row.review = "awaiting";
        row.reason = "尚未到完成日线核验时间";
      }
    }
    if (row.market === "unverified") result.unverified.push(date);
    result.dates.push(row);
  }
  result.count = result.confirmedDates.length;
  result.exact =
    result.baselineCovered && !result.unverified.some((d) => d <= result.asOf);
  result.checkpoints = (plan?.checkpoints || []).map((c) => ({
    day: c.day,
    report: c.report || null,
    reportPreparedAt: c.reportPreparedAt || null,
    asOf: c.asOf || null,
    dueDate: result.exact ? result.confirmedDates[c.day - 1] || null : null,
    status: c.report
      ? "reported"
      : result.exact && result.count >= c.day
        ? "due"
        : result.exact
          ? "pending"
          : "unverified",
  }));
  return result;
}
