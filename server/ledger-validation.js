import { createHash } from "node:crypto";
import { isDeepStrictEqual as equal } from "node:util";
import { dailyPlans } from "../shared/daily-plans.js";
import { chinaClock } from "../shared/time.js";

export const MAX_LEDGER_BYTES = 10 * 1024 * 1024;
export const digest = (text) => createHash("sha256").update(text).digest("hex");
const object = (v) => v && typeof v === "object" && !Array.isArray(v);
const date = (v) =>
  typeof v === "string" &&
  /^\d{4}-\d{2}-\d{2}$/.test(v) &&
  Number.isFinite(Date.parse(v)) &&
  new Date(v).toISOString().slice(0, 10) === v;
const stamp = (v) => typeof v === "string" && Number.isFinite(Date.parse(v));
const requireThat = (ok, message) => {
  if (!ok) throw Error(`账本校验失败：${message}`);
};
const unique = (rows, key) =>
  new Set(rows.map((x) => x[key])).size === rows.length;
const terminal = (t) => ["closed", "skipped"].includes(t.state);

export function validateLedger(data, reference = {}) {
  requireThat(
    object(data) &&
      data.schema === 1 &&
      Array.isArray(data.plans) &&
      Array.isArray(data.days) &&
      Array.isArray(data.tickets),
    "结构或版本无效",
  );
  requireThat(
    data.days.length <= 90 && data.tickets.length <= 6000,
    "记录超过容量上限",
  );
  requireThat(
    data.job == null ||
      (object(data.job) &&
        ["running", "stopped", "partial", "completed", "waiting"].includes(
          data.job.status,
        )),
    "任务结构无效",
  );
  requireThat(
    Buffer.byteLength(JSON.stringify(data)) <= MAX_LEDGER_BYTES,
    "文件超过10MiB",
  );
  if (!data.plans.length) {
    requireThat(
      !data.activatedAt &&
        !data.days.length &&
        !data.tickets.length &&
        !reference.initialTicketIds?.length,
      "已登记的账本不能清空为首次使用",
    );
    return data;
  }
  requireThat(
    stamp(data.activatedAt) &&
      data.plans.length === dailyPlans.length &&
      unique(data.plans, "id"),
    "启用信息或策略集合无效",
  );
  for (const p of data.plans) {
    const expected = dailyPlans.find((x) => x.id === p.id);
    requireThat(
      expected &&
        Object.keys(expected).every((k) => equal(p[k], expected[k])) &&
        p.ruleHash === digest(JSON.stringify(expected)) &&
        p.activatedAt === data.activatedAt,
      "固定策略条件、持有期、费用或指纹改变",
    );
  }
  if (reference.frozenPlans)
    requireThat(equal(data.plans, reference.frozenPlans), "与原冻结计划不一致");
  requireThat(
    unique(data.tickets, "id") && unique(data.days, "date"),
    "重复信号或日期",
  );
  for (const t of data.tickets) {
    const p = data.plans.find((x) => x.id === t.planId);
    requireThat(
      p &&
        /^s[hz]\d{6}$/.test(t.symbol) &&
        t.code === t.symbol.slice(2) &&
        typeof t.name === "string" &&
        date(t.signalDate) &&
        stamp(t.registeredAt) &&
        chinaClock(t.registeredAt).date === t.signalDate &&
        chinaClock(t.registeredAt).minutes >= 910 &&
        Date.parse(t.registeredAt) >= Date.parse(data.activatedAt) &&
        t.id === `${t.planId}:${t.symbol}:${t.signalDate}` &&
        Array.isArray(t.checks) &&
        ["pending", "holding", "exit-wait", "closed", "skipped"].includes(
          t.state,
        ),
      "信号身份或状态无效",
    );
    requireThat(
      ["hold", "costBps", "slippageBps", "ruleHash"].every(
        (k) => t[k] === p[k],
      ),
      "信号规则与固定计划不一致",
    );
    if (t.asOf)
      requireThat(date(t.asOf) && t.asOf >= t.signalDate, "跟踪日期无效");
    if (["holding", "exit-wait", "closed"].includes(t.state)) {
      requireThat(
        date(t.entryDate) &&
          t.entryDate > t.signalDate &&
          Number.isFinite(t.entryPrice) &&
          t.entryPrice > 0 &&
          Number.isInteger(t.holdBars) &&
          t.holdBars > 0 &&
          typeof t.source === "string",
        "入场依据无效",
      );
    }
    if (t.state === "closed") {
      const net =
        (((t.exitPrice / t.entryPrice) * (1 - t.costBps / 10000)) /
          (1 + t.costBps / 10000) -
          1) *
        100;
      requireThat(
        date(t.exitDate) &&
          t.exitDate >= t.entryDate &&
          t.exitDate <= t.asOf &&
          Number.isFinite(t.exitPrice) &&
          t.exitPrice > 0 &&
          Number.isFinite(t.net) &&
          Math.abs(t.net - net) < 1e-7 &&
          t.holdBars >= t.hold &&
          Number.isInteger(t.delayed) &&
          t.delayed >= 0,
        "已退出结果或费用计算无效",
      );
    }
  }
  for (const day of data.days) {
    requireThat(
      date(day.date) &&
        stamp(day.createdAt) &&
        stamp(day.snapshotFetchedAt) &&
        Number.isInteger(day.coverage) &&
        Array.isArray(day.plans) &&
        day.plans.length === data.plans.length &&
        unique(day.plans, "planId"),
      "每日快照结构无效",
    );
    for (const q of day.plans) {
      const p = data.plans.find((x) => x.id === q.planId);
      requireThat(
        p &&
          q.ruleHash === p.ruleHash &&
          Array.isArray(q.items) &&
          q.items.length <= p.config.maxScan &&
          Number.isInteger(q.baseCount) &&
          q.baseCount >= q.items.length &&
          Number.isInteger(q.notScanned) &&
          q.notScanned >= 0,
        "每日股票池无效",
      );
      requireThat(
        new Set(q.items.map((i) => i.stock?.symbol)).size === q.items.length,
        "每日股票池重复",
      );
      for (const i of q.items) {
        requireThat(
          object(i.stock) &&
            /^s[hz]\d{6}$/.test(i.stock.symbol) &&
            ["pending", "matched", "unmatched", "failed"].includes(i.state) &&
            Number.isInteger(i.attempts) &&
            i.attempts >= 0,
          "逐股状态无效",
        );
        if (i.ticketId)
          requireThat(
            data.tickets.some(
              (t) =>
                t.id === i.ticketId &&
                t.symbol === i.stock.symbol &&
                t.planId === p.id &&
                t.signalDate === day.date,
            ),
            "每日信号引用丢失",
          );
      }
    }
  }
  const ids = new Set(data.tickets.map((t) => t.id));
  requireThat(
    (reference.initialTicketIds || []).every((id) => ids.has(id)),
    "原首批信号缺失",
  );
  for (const frozen of reference.shortFrozenResults || []) {
    const t = data.tickets.find((x) => x.id === frozen.id);
    requireThat(
      t &&
        t.state === "closed" &&
        ["net", "entryDate", "exitDate"].every((k) => t[k] === frozen[k]),
      "原短线已完成结果改变",
    );
  }
  return data;
}

// A restore/write may advance existing records, but must never erase committed facts.
export function assertForward(next, previous) {
  if (!previous?.plans.length) return;
  requireThat(
    equal(next.plans, previous.plans) &&
      next.activatedAt === previous.activatedAt,
    "不能改写原计划",
  );
  for (const old of previous.tickets) {
    const t = next.tickets.find((x) => x.id === old.id);
    requireThat(t, `不能丢失信号 ${old.id}`);
    const fixed = [
      "id",
      "planId",
      "symbol",
      "code",
      "name",
      "signalDate",
      "registeredAt",
      "checks",
      "signalSource",
      "ruleHash",
      "hold",
      "costBps",
      "slippageBps",
    ];
    requireThat(
      fixed.every((k) => equal(t[k], old[k])),
      `不能改写登记依据 ${old.id}`,
    );
    if (terminal(old))
      requireThat(equal(t, old), `不能改写已完成结果 ${old.id}`);
    if (old.asOf)
      requireThat(t.asOf && t.asOf >= old.asOf, `不能回退跟踪日期 ${old.id}`);
  }
  for (const old of previous.days) {
    const day = next.days.find((d) => d.date === old.date);
    requireThat(
      day &&
        ["createdAt", "snapshotFetchedAt", "coverage"].every((k) =>
          equal(day[k], old[k]),
        ),
      "不能丢失或改写每日快照",
    );
    for (const q of old.plans) {
      const p = day.plans.find((x) => x.planId === q.planId);
      requireThat(
        p &&
          ["ruleHash", "baseCount", "notScanned"].every((k) =>
            equal(p[k], q[k]),
          ) &&
          equal(
            p.items.map((i) => i.stock),
            q.items.map((i) => i.stock),
          ),
        "不能改写冻结股票池",
      );
      q.items.forEach((i, n) => {
        if (["matched", "unmatched"].includes(i.state))
          requireThat(equal(i, p.items[n]), "不能改写成功计算的依据");
      });
    }
  }
}
