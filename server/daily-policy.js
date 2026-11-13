import { chinaClock } from "../shared/time.js";
import { closure } from "./trading-calendar.js";
import { openStates } from "./paper-ledger.js";

export function retryAssessment(job, now = new Date()) {
  if (!job) return { retryable: false, retryAt: null };
  const errors = job.errors || [];
  const userStopped = job.stopReason === "user";
  const deniedWithoutDate = errors.some(
    (e) => ["blocked", "cooldown"].includes(e.kind) && !e.retryAt,
  );
  const retryable =
    !userStopped &&
    !deniedWithoutDate &&
    (job.status === "waiting" ||
      job.status === "interrupted" ||
      job.stopReason === "shutdown" ||
      errors.some((e) =>
        ["transient", "blocked", "cooldown"].includes(e.kind),
      ) ||
      (job.status === "stopped" &&
        /超时|连接|网络|中断|socket|fetch/i.test(job.note || "")));
  const ended = Date.parse(job.finishedAt || job.detectedAt || job.recoveredAt);
  const retryAt = retryable
    ? Math.max(
        (Number.isFinite(ended) ? ended : now.getTime()) + 600000,
        ...errors.map((e) => (Number.isFinite(e.retryAt) ? e.retryAt : 0)),
      )
    : null;
  return { retryable, retryAt, userStopped };
}
export function nextDailyCheck(now) {
  const c = chinaClock(now),
    d = new Date(c.date + "T00:00:00Z");
  if (c.minutes >= 980) d.setUTCDate(d.getUTCDate() + 1);
  for (let i = 0; i < 40; i++, d.setUTCDate(d.getUTCDate() + 1)) {
    const date = d.toISOString().slice(0, 10);
    if (!closure(date)) return date + "T16:20:00+08:00";
  }
  return null;
}
export function decideExecution({
  ledger,
  calendar,
  attempts = [],
  now = new Date(),
  blockedUntil = 0,
}) {
  const clock = chinaClock(now),
    job = ledger.job;
  const common = {
    lastDueDate:
      calendar.dates
        ?.filter(
          (d) =>
            d.market === "open" &&
            (d.date < clock.date || clock.minutes >= 980),
        )
        .at(-1)?.date || null,
    nextCheckAt: nextDailyCheck(now),
    nextRetryAt: null,
    task: null,
  };
  if (!ledger.plans.length)
    return { ...common, status: "disabled", reason: "固定策略尚未启用" };
  const window = !closure(clock.date) && clock.minutes >= 980;
  const open = ledger.tickets.filter((t) => openStates.includes(t.state));
  const recoveryDate = calendar.asOf;
  const needsRecovery =
    recoveryDate &&
    open.some(
      (t) => t.signalDate < recoveryDate && (!t.asOf || t.asOf < recoveryDate),
    );
  let kind = window ? "daily" : needsRecovery ? "recovery" : null;
  const target = window ? clock.date : recoveryDate;
  if (!kind)
    return {
      ...common,
      status: closure(clock.date) ? "closed" : "waiting-window",
      reason: closure(clock.date)
        ? "休市；已登记信号没有需要补推进的已核验日期"
        : "等待16:20盘后窗口；不登记盘前或过去的信号",
    };
  const key = `${kind}:${target}`,
    records = attempts.filter((a) => a.key === key),
    last = records.at(-1);
  const sameJob =
    job &&
    (kind === "recovery"
      ? job.trackingAsOf === target
      : !job.trackingAsOf && chinaClock(job.startedAt).date === target);
  const legacyCount =
    kind === "daily" && ledger.autoAttempt === target
      ? 1 + (ledger.autoRetryCount || 0)
      : kind === "recovery" && sameJob && job.executionId
        ? job.executionAttempt || 1
        : 0;
  const count = Math.max(records.length, legacyCount);
  // A later manual run or manual stop is authoritative over an older automatic attempt.
  const latest =
    sameJob &&
    (!last || Date.parse(job.startedAt) >= Date.parse(last.startedAt))
      ? job
      : last;
  const assessment =
    latest &&
    (latest.retryable !== undefined ? latest : retryAssessment(latest, now));
  if (latest?.stopReason === "user" || assessment?.userStopped)
    return {
      ...common,
      key,
      status: "user-paused",
      reason: "用户已手动停止此日任务，不自动重新启动；可手动运行",
    };
  if (
    latest &&
    ["completed", "partial"].includes(latest.status) &&
    !assessment.retryable
  )
    return {
      ...common,
      key,
      status: latest.status === "partial" ? "issues" : "complete",
      reason:
        latest.status === "partial"
          ? "已处理到终态，仍有数据问题；历史不足不自动重复请求"
          : "该日期任务已完成，不重复登记",
    };
  if (count >= 2)
    return {
      ...common,
      key,
      status: "attempt-limit",
      reason: "该日期已执行初次及一次补跑，停止自动重试",
    };
  if (count && !assessment?.retryable)
    return {
      ...common,
      key,
      status: "needs-attention",
      reason: "上次任务未完成且不属于可自动重试故障，请查看执行记录",
    };
  const retryAt = Math.max(blockedUntil, count ? assessment?.retryAt || 0 : 0);
  if (retryAt > now.getTime())
    return {
      ...common,
      key,
      status: "cooldown",
      nextRetryAt: new Date(retryAt).toISOString(),
      reason: "等待重试间隔或数据源冷却，不重复请求",
    };
  return {
    ...common,
    key,
    status: "ready",
    reason:
      kind === "daily"
        ? "盘后复盘已预约，等待任务资源"
        : "仅推进已登记信号至已核验完成日，不补记过去新信号",
    task: { kind, target, key, attempt: count + 1 },
  };
}
