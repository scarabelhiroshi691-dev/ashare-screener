import { readFile, stat, lstat } from "node:fs/promises";
import { randomUUID, createHash } from "node:crypto";
import path from "node:path";
import { dataDir, writeCache } from "./cache.js";
import { providerStatus } from "./providers.js";
import { chinaClock } from "../shared/time.js";
import { verificationTarget, validDate } from "./trading-calendar.js";
import { openStates } from "./paper-ledger.js";
import { decideExecution, retryAssessment } from "./daily-policy.js";

const hash = (d) =>
  createHash("sha256").update(JSON.stringify(d)).digest("hex");
async function readSchedule() {
  const file = path.join(dataDir, "daily-schedule.json");
  try {
    if (
      (await lstat(file)).isSymbolicLink() ||
      (await stat(file)).size > 512 * 1024
    )
      throw Error("调度记录类型或大小异常");
    return JSON.parse(await readFile(file, "utf8"));
  } catch (e) {
    if (e.code === "ENOENT") return null;
    throw e;
  }
}
export class DailyScheduler {
  data = { schema: 1, attempts: [], events: [], lastSeenAt: null };
  checking = false;
  constructor(
    daily,
    {
      now = daily.now,
      read = readSchedule,
      write = (x) => writeCache("daily-schedule", x),
      sources = providerStatus,
    } = {},
  ) {
    Object.assign(this, { daily, now, read, write, sources });
    this.startedAt = now().toISOString();
  }
  async init() {
    try {
      const saved = await this.read();
      if (saved) {
        const d = saved.data;
        if (
          !d ||
          saved.sha256 !== hash(d) ||
          d.schema !== 1 ||
          !Array.isArray(d.attempts) ||
          d.attempts.length > 180 ||
          !Array.isArray(d.events) ||
          d.events.length > 20 ||
          d.attempts.some(
            (a) =>
              !["daily", "recovery"].includes(a.kind) ||
              !validDate(a.target) ||
              a.key !== `${a.kind}:${a.target}` ||
              !a.id ||
              !Number.isFinite(Date.parse(a.startedAt)),
          )
        )
          throw Error("调度记录校验失败");
        this.data = d;
        for (const a of d.attempts.filter((x) => x.status === "running")) {
          const job = this.daily.data.job;
          if (
            job?.executionId === a.id &&
            !job.recoveredAt &&
            job.status !== "running"
          )
            this.finish(a, job);
          else
            Object.assign(a, {
              status: "interrupted",
              detectedAt: this.startedAt,
              retryable: true,
              retryAt: this.now().getTime() + 600000,
              reason: "上次执行中断；终止时间未知，保留已保存进度",
            });
        }
      }
      this.event(
        "service-start",
        "服务启动，已核对上次执行记录；不补记过去新信号",
      );
      await this.save();
    } catch (e) {
      this.error = `自动调度已保护：${e.message}`;
    }
  }
  event(type, reason) {
    this.data.events.push({ type, at: this.now().toISOString(), reason });
    this.data.events = this.data.events.slice(-20);
  }
  async save() {
    try {
      await this.write({ data: this.data, sha256: hash(this.data) });
    } catch (e) {
      this.error = `自动调度保存失败：${e.message}`;
      throw e;
    }
  }
  decision() {
    const d = this.daily;
    const r = decideExecution({
      ledger: d.data,
      calendar: d.calendarReview(),
      attempts: this.data.attempts,
      now: this.now(),
      blockedUntil: this.sources()?.sina?.blockedUntil || 0,
    });
    const trendSaveError = d.store.trend?.job?.fatal?.startsWith("无法保存")
      ? "趋势进度保存失败，暂停自动调度以保留记录"
      : null;
    if (this.error || d.storage?.status().blocked || trendSaveError)
      return {
        ...r,
        task: null,
        status: "protected",
        reason: this.error || trendSaveError || "账本保护中，暂停自动调度",
      };
    return r;
  }
  blocker() {
    const s = this.daily.store;
    if (s.trend?.active) return "趋势任务正在完成当前股票并保存进度";
    if (s.research.active) return "研究任务正在运行，等待结束";
    if (s.refresh.running) return "市场行情刷新正在运行，等待结束";
    if (s.running()) return "筛选任务正在运行，等待结束";
    return null;
  }
  state() {
    const d = this.daily,
      policy = this.decision(),
      blocker = this.blocker();
    return {
      ...policy,
      status:
        d.active || this.pendingExecution
          ? "running"
          : policy.task && blocker
            ? "waiting-job"
            : policy.status,
      reason: d.active
        ? d.calendar?.active
          ? "正在核验完成交易日"
          : "任务执行中，逐股保存；不重复启动"
        : this.pendingExecution
          ? "正在保存执行预约，不允许其他任务插队"
          : policy.task && blocker
            ? blocker
            : policy.reason,
      serviceStartedAt: this.startedAt,
      lastCheckedAt: this.data.lastSeenAt,
      lastAttempt: this.data.attempts.at(-1) || null,
      actualJob: d.data.job
        ? {
            startedAt: d.data.job.startedAt,
            finishedAt: d.data.job.recoveredAt ? null : d.data.job.finishedAt,
            recoveredAt: d.data.job.recoveredAt || null,
            status: d.data.job.status,
            note: d.data.job.note,
          }
        : null,
      events: this.data.events.slice(-8),
      attempts: this.data.attempts.slice(-8),
      trendYield:
        d.store.trend?.job?.priorityYield ||
        d.store.trend?.yieldRequest ||
        null,
      error: this.error || null,
    };
  }
  assertBackgroundAllowed() {
    if (this.pendingExecution || this.decision().task)
      throw Error("每日复盘已预约，请等待复盘完成后开始或继续其他任务");
  }
  finish(entry, job) {
    const assessment = retryAssessment(job, this.now());
    const groups = new Map();
    for (const e of job.errors || []) {
      const kind = e.kind || "data",
        previous = groups.get(kind);
      groups.set(kind, {
        kind,
        count: (previous?.count || 0) + 1,
        retryAt:
          Math.max(
            previous?.retryAt || 0,
            Number.isFinite(e.retryAt) ? e.retryAt : 0,
          ) || null,
      });
    }
    Object.assign(entry, {
      status: job.status,
      actualStartedAt: job.startedAt,
      finishedAt: job.finishedAt || null,
      reason: job.note || "",
      errors: [...groups.values()],
      errorCount: job.errors?.length || 0,
      ...assessment,
      stopReason: job.stopReason || null,
    });
  }
  async runTask(task) {
    const entry = {
      ...task,
      id: randomUUID(),
      startedAt: this.now().toISOString(),
      finishedAt: null,
      status: "running",
    };
    this.pendingExecution = entry.id;
    this.data.attempts.push(entry);
    this.data.attempts = this.data.attempts.slice(-180);
    try {
      await this.save(); // A failed reservation must never launch a task.
      await this.daily.start(
        task.kind === "daily",
        task.kind === "recovery" ? task.target : null,
        entry.id,
        task.attempt,
      );
      entry.actualStartedAt = this.daily.data.job.startedAt;
      await this.daily.task;
      const job = this.daily.data.job;
      if (job?.executionId !== entry.id)
        throw Error("执行身份不一致，自动恢复已停止");
      this.finish(entry, job);
      if (this.daily.lastError) throw Error(this.daily.lastError);
    } catch (e) {
      Object.assign(entry, {
        status: "stopped",
        finishedAt: this.now().toISOString(),
        reason: e.message,
        retryable: false,
      });
      this.event("execution-error", e.message);
    }
    try {
      await this.save();
    } finally {
      this.pendingExecution = null;
    }
  }
  async resumeTrend() {
    const trend = this.daily.store.trend,
      pause = trend?.job?.priorityYield;
    if (
      !pause?.autoResume ||
      trend.active ||
      this.daily.active ||
      this.blocker() ||
      this.error
    )
      return;
    const outcome = this.data.attempts.findLast((a) => a.key === pause.key);
    if (
      !outcome ||
      !["completed", "partial"].includes(outcome.status) ||
      outcome.retryable ||
      outcome.userStopped ||
      (this.sources()?.sina?.blockedUntil || 0) > this.now().getTime()
    )
      return;
    // A restart does not restart a previously paused research job without a user action.
    if (trend.recoveredPriority) return;
    await trend.resumeAfterDaily(pause.key);
  }
  async tick() {
    if (this.checking || this.daily.active || this.error) return;
    this.checking = true;
    try {
      const previous = Math.max(
        Date.parse(this.data.lastSeenAt) || Date.parse(this.startedAt),
          Date.parse(this.data.attempts.at(-1)?.finishedAt) || 0,
          Date.parse(this.daily.data.job?.finishedAt) || 0,
        ),
        now = this.now().getTime();
      if (previous > 0 && now - previous > 180000)
        this.event(
          "check-gap",
          `检查间隔${Math.round((now - previous) / 60000)}分钟，可能停机或休眠；先核对完成行情`,
        );
      this.data.lastSeenAt = this.now().toISOString();
      let policy = this.decision();
      if (policy.status === "protected" || policy.status === "disabled") {
        await this.save();
        return;
      }
      if (policy.task) {
        const blocker = this.blocker();
        if (blocker) {
          if (
            this.data.deferred?.key !== policy.task.key ||
            this.data.deferred?.reason !== blocker
          ) {
            this.data.deferred = {
              key: policy.task.key,
              reason: blocker,
              at: this.now().toISOString(),
            };
            this.event("deferred", blocker);
          }
          this.daily.store.trend?.requestDailyYield?.(policy.task);
          await this.save();
          return;
        }
        this.data.deferred = null;
        await this.runTask(policy.task);
        await this.resumeTrend();
        return;
      }
      if (!this.blocker()) {
        const d = this.daily,
          c = d.calendarReview();
        const open = d.data.tickets.some((t) => openStates.includes(t.state));
        // Before the daily window, new calendar evidence may unlock tracking-only recovery.
        if (
          open &&
          (!c.asOf || c.asOf < verificationTarget(this.now())) &&
          d.calendar?.canRefresh()
        ) {
          await d.refreshCalendar();
          await d.calendarTask;
          policy = this.decision();
          if (policy.task?.kind === "recovery") await this.runTask(policy.task);
        } else if (
          d.data.autoAttempt === chinaClock(this.now()).date &&
          d.calendar?.shouldRefresh()
        ) {
          await d.refreshCalendar();
          await d.calendarTask;
        }
        await this.resumeTrend();
      }
      await this.save();
    } catch (e) {
      this.error ||= `自动调度已保护：${e.message}`;
    } finally {
      this.checking = false;
    }
  }
}
