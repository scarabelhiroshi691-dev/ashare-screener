import { createHash } from "node:crypto";
import { dailyPlans, dailyMethod } from "../shared/daily-plans.js";
import { chinaClock, isCompletedDate } from "../shared/time.js";
import { baseReason } from "../shared/rules.js";
import { analyzeBars } from "./indicators.js";
import { LedgerStorage } from "./ledger-storage.js";
import { CalendarStore } from "./calendar-store.js";
import { DailyScheduler } from "./daily-scheduler.js";
import { ReviewReports } from "./review-reports.js";
import { buildCalendarReview, closure } from "./trading-calendar.js";
import { providerStatus, restoreProviderStatus } from "./providers.js";
import {
  registerSignal,
  advanceTicket,
  paperStats,
  openStates,
} from "./paper-ledger.js";

export function canRegisterDay(date, activationDate, now = new Date()) {
  const c = chinaClock(now);
  return (
    c.weekday && c.minutes >= 910 && date === c.date && date >= activationDate
  );
}
export class Daily {
  data = {
    schema: 1,
    plans: [],
    days: [],
    tickets: [],
    job: null,
    autoAttempt: null,
  };
  active = false;
  controller = null;
  constructor(
    store,
    {
      read,
      write,
      storage,
      calendar,
      scheduler,
      reports,
      now = () => new Date(),
    } = {},
  ) {
    this.storage = storage || (!read && !write ? new LedgerStorage() : null);
    this.calendar =
      calendar === undefined && !read && !write && !storage
        ? new CalendarStore({ now })
        : calendar;
    Object.assign(this, {
      store,
      now,
      read: read || (() => this.storage.load()),
      write: write || ((_key, data) => this.storage.write(data)),
    });
    this.scheduler =
      scheduler === undefined && !read && !write && !storage
        ? new DailyScheduler(this, { now })
        : scheduler;
    this.reports =
      reports === undefined && !read && !write && !storage
        ? new ReviewReports(this, { now })
        : reports;
  }
  async init() {
    try {
      this.accept(await this.read("daily"));
    } catch (e) {
      if (!this.storage) throw e;
      this.lastError = `账本已保护：${this.storage.status().message || e.message}`;
      this.committed = structuredClone(this.data);
    }
    await this.calendar?.init();
    await this.scheduler?.init();
    await this.reports?.init();
    await this.reports?.refresh();
  }
  accept(saved) {
    if (saved) {
      if (
        saved.schema !== 1 ||
        !Array.isArray(saved.plans) ||
        !Array.isArray(saved.days) ||
        !Array.isArray(saved.tickets)
      )
        throw Error("模拟账本格式异常，已停止启动以保留原记录");
      this.data = saved;
      restoreProviderStatus(saved.providerStatus);
      if (saved.job?.status === "running") {
        saved.job.status = "stopped";
        saved.job.finishedAt = null;
        saved.job.recoveredAt = this.now().toISOString();
        saved.job.note = "上次运行中断，进度已恢复，等待有限自动重试";
      }
    }
    this.committed = structuredClone(this.data);
  }
  requireWritable() {
    if (this.storage?.status().blocked)
      throw Error("账本已保护，请先检查并恢复，不能启用或写入");
  }
  async storageAction(action, token) {
    if (!this.storage) throw Error("当前存储不支持恢复操作");
    if (
      this.scheduler?.pendingExecution ||
      this.active ||
      this.store.running() ||
      this.store.refresh.running ||
      this.store.research.active
    )
      throw Error("请等待当前任务结束后检查账本");
    this.active = true;
    try {
      const data =
        action === "restore"
          ? await this.storage.restore(token)
          : await this.storage.load();
      this.accept(data);
      this.lastError = null;
    } catch (e) {
      this.lastError = `账本已保护：${this.storage.status().message || e.message}`;
      throw e;
    } finally {
      this.active = false;
    }
    return this.state();
  }
  async persist() {
    try {
      this.requireWritable();
      this.data.providerStatus = providerStatus();
      if (Buffer.byteLength(JSON.stringify(this.data)) > 10 * 1024 * 1024)
        throw Error("模拟账本达到10MiB上限，请先导出保留记录");
      await this.write("daily", this.data);
      this.committed = structuredClone(this.data);
    } catch (e) {
      this.data = structuredClone(this.committed);
      throw e;
    }
  }
  state(data = this.data, stats = paperStats(data.tickets, data.plans)) {
    const calendar = this.calendarReview();
    return {
      ...data,
      active: this.active,
      ledgerStorage: this.storage?.status() || null,
      lastError: this.lastError || null,
      method: dailyMethod,
      stats,
      clock: chinaClock(this.now()),
      schedule:
        "上海时间工作日16:20，服务运行时自动检查；临时失败10分钟后最多自动补跑1次，访问拒绝遵守冷却；休市无新数据不登记。",
      gaps: calendar.missed,
      calendar,
      execution: this.scheduler?.state() || null,
    };
  }
  gaps() {
    return this.calendarReview().missed;
  }
  calendarReview() {
    const result =
      this.calendar?.review(this.data, this.active) ||
      buildCalendarReview({
        ledger: this.data,
        now: this.now(),
        active: this.active,
      });
    result.checkpoints = (result.checkpoints || []).map((c) => {
      const stage = this.reports?.data?.stages.find((s) => s.day === c.day);
      return stage?.status === "prepared"
        ? {
            ...c,
            report: stage.report,
            reportPreparedAt: stage.preparedAt,
            asOf: stage.asOf,
            status: "reported",
          }
        : c;
    });
    return result;
  }
  async refreshCalendar() {
    if (!this.calendar) throw Error("交易日核验尚未配置");
    if (this.scheduler?.pendingExecution)
      throw Error("每日任务启动中，请稍后核验日期");
    if (
      this.active ||
      this.store.running() ||
      this.store.refresh.running ||
      this.store.research.active
    )
      throw Error("请等待当前任务结束后核验交易日");
    const reason = this.calendar.refreshReason();
    if (reason) throw Error(reason);
    this.active = true;
    this.controller = new AbortController();
    this.calendarTask = this.calendar
      .refresh(this.controller.signal)
      .finally(() => {
        this.active = false;
      });
    return this.state();
  }
  async activate() {
    this.requireWritable();
    if (
      this.scheduler?.pendingExecution ||
      this.active ||
      this.store.running() ||
      this.store.refresh.running ||
      this.store.research.active
    )
      throw Error("请等待当前任务结束");
    if (this.data.plans.length) return this.state();
    this.active = true;
    try {
      const activatedAt = this.now().toISOString();
      this.data.activatedAt = activatedAt;
      this.data.plans = dailyPlans.map((p) => ({
        ...structuredClone(p),
        activatedAt,
        ruleHash: createHash("sha256").update(JSON.stringify(p)).digest("hex"),
      }));
      await this.persist();
    } finally {
      this.active = false;
    }
    return this.state();
  }
  assertBackgroundAllowed() {
    this.scheduler?.assertBackgroundAllowed();
  }
  async start(
    automatic = false,
    trackingAsOf = null,
    executionId = null,
    executionAttempt = null,
  ) {
    if (
      this.scheduler?.pendingExecution &&
      this.scheduler.pendingExecution !== executionId
    )
      throw Error("每日任务已预约启动，请等待当前执行");
    this.requireWritable();
    if (!this.data.plans.length) throw Error("请先启用固定策略前瞻验证");
    if (
      trackingAsOf !== null &&
      (typeof trackingAsOf !== "string" ||
        !/^\d{4}-\d{2}-\d{2}$/.test(trackingAsOf) ||
        Number.isNaN(Date.parse(trackingAsOf)) ||
        new Date(trackingAsOf).toISOString().slice(0, 10) !== trackingAsOf ||
        !isCompletedDate(trackingAsOf, this.now()) ||
        trackingAsOf < chinaClock(this.data.activatedAt).date)
    )
      throw Error("请选择启用后已完成的有效截止日期");
    if (
      trackingAsOf &&
      this.calendar &&
      !this.calendarReview().dates.some(
        (d) => d.date === trackingAsOf && d.market === "open",
      )
    )
      throw Error("该截止日尚无完成开市证据，请先核验交易日");
    if (
      this.active ||
      this.store.running() ||
      this.store.refresh.running ||
      this.store.research.active
    )
      throw Error("请等待或停止当前任务");
    this.active = true;
    this.controller = new AbortController();
    try {
      await this.store.checkResources();
      this.lastError = null;
      if (automatic) {
        const date = chinaClock(this.now()).date;
        this.data.autoRetryCount =
          this.data.autoAttempt === date
            ? (this.data.autoRetryCount || 0) + 1
            : 0;
        this.data.autoAttempt = date;
      }
      this.data.job = {
        status: "running",
        phase: "准备",
        startedAt: this.now().toISOString(),
        done: 0,
        target: 0,
        errors: [],
        automatic,
        trackingAsOf,
        executionId,
        executionAttempt,
      };
      await this.persist();
      this.task = this.run();
      return this.state();
    } catch (e) {
      this.active = false;
      throw e;
    }
  }
  async run() {
    const signal = this.controller.signal;
    let transientStreak = 0;
    try {
      const clock = chinaClock(this.now());
      const trackingAsOf = this.data.job.trackingAsOf;
      if (!trackingAsOf && (closure(clock.date) || clock.minutes < 910)) {
        this.data.job.status = "waiting";
        this.data.job.note =
          "当日尚无收盘验证条件，等待工作日盘后；不使用昨日结果补记今日信号";
        return;
      }
      if (!trackingAsOf) {
        this.data.job.phase = "刷新完成日行情";
        await this.persist();
        await this.store.startRefresh(true);
        await this.store.refreshTask;
        signal.throwIfAborted();
        if (this.store.refresh.error) throw Error(this.store.refresh.error);
      }
      const snapshot = this.store.market;
      if (!trackingAsOf && (!snapshot?.date || snapshot.date > clock.date))
        throw Error("行情日期无效");
      const asOf = trackingAsOf || snapshot.date;
      const load = async (symbol) => {
        signal.throwIfAborted();
        const h = await this.store.history(symbol, asOf, signal);
        signal.throwIfAborted();
        transientStreak = 0;
        return h;
      };
      const failure = (e, symbol) => {
        if (signal.aborted) throw e;
        if (
          e.kind === "capacity" ||
          ["ENOSPC", "EACCES", "EIO", "EPERM", "EROFS"].includes(e.code)
        )
          throw e;
        this.data.job.errors.push({
          symbol,
          message: e.message,
          kind: e.kind || "data",
          retryAt: e.retryAt || null,
        });
        transientStreak = e.kind === "transient" ? transientStreak + 1 : 0;
        if (["blocked", "cooldown"].includes(e.kind) || transientStreak >= 3) {
          this.data.job.done++;
          throw e;
        }
      };
      this.data.job.phase = "推进已登记模拟持仓";
      const tickets = this.data.tickets.filter((t) =>
        openStates.includes(t.state),
      );
      this.data.job.target = tickets.length;
      for (const ticket of tickets) {
        if (ticket.asOf && ticket.asOf > asOf) {
          this.data.job.done++;
          continue;
        }
        try {
          Object.assign(
            ticket,
            advanceTicket(ticket, await load(ticket.symbol), asOf),
          );
        } catch (e) {
          ticket.error = e.message;
          failure(e, ticket.symbol);
        }
        this.data.job.done++;
        await this.persist();
      }
      if (trackingAsOf) {
        this.data.job.status = this.data.job.errors.length
          ? "partial"
          : "completed";
        this.data.job.note = `仅推进已登记信号至${asOf}，未补记漏跑日期的新信号`;
        return;
      }
      if (
        !canRegisterDay(
          asOf,
          chinaClock(this.data.activatedAt).date,
          this.now(),
        )
      ) {
        this.data.job.status = "waiting";
        this.data.job.note = `只取得${asOf}行情，未取得今日完成快照；已登记持仓可更新，今日不新增信号`;
        return;
      }
      let day = this.data.days.find((d) => d.date === asOf);
      if (!day) {
        if (this.data.days.length >= 90 || this.data.tickets.length >= 6000)
          throw Error(
            "前瞻记录达到90日或6000条上限，保留账本，暂停新增；请先导出记录",
          );
        day = {
          date: asOf,
          createdAt: this.now().toISOString(),
          snapshotFetchedAt: snapshot.fetchedAt,
          coverage: snapshot.stocks.length,
          plans: this.data.plans.map((p) => {
            const pool = snapshot.stocks
              .filter((s) => !baseReason(s, p.config, asOf))
              .sort(
                (a, b) =>
                  b.amount - a.amount || a.symbol.localeCompare(b.symbol),
              );
            return {
              planId: p.id,
              ruleHash: p.ruleHash,
              baseCount: pool.length,
              notScanned: Math.max(0, pool.length - p.config.maxScan),
              items: pool
                .slice(0, p.config.maxScan)
                .map((s) => ({ stock: s, state: "pending", attempts: 0 })),
            };
          }),
        };
        this.data.days.push(day);
        await this.persist();
      }
      this.data.job.phase = "记录当日固定规则信号";
      const work = day.plans.flatMap((p) =>
        p.items
          .filter((i) => ["pending", "failed"].includes(i.state))
          .map((item) => ({
            plan: this.data.plans.find((x) => x.id === p.planId),
            item,
          })),
      );
      this.data.job.target += work.length;
      for (const { plan, item } of work) {
        signal.throwIfAborted();
        if (
          !canRegisterDay(
            day.date,
            chinaClock(this.data.activatedAt).date,
            this.now(),
          )
        )
          throw Error("已跨日，停止补记旧信号；剩余股票保留为未完成");
        item.attempts++;
        this.data.job.current = item.stock.name;
        try {
          const h = await load(item.stock.symbol),
            analysis = analyzeBars(h.bars, asOf, plan.config);
          item.checks = analysis.checks;
          item.source = h.source;
          item.error = null;
          item.state = analysis.passed ? "matched" : "unmatched";
          if (analysis.passed) {
            const t = registerSignal(
              this.data.tickets,
              plan,
              item.stock,
              asOf,
              this.now().toISOString(),
              analysis.checks,
              h.source,
            );
            if (t) {
              if (this.data.tickets.length >= 6000)
                throw Object.assign(
                  Error("模拟信号已达到6000条上限，请导出记录，已保存信号保留"),
                  { kind: "capacity" },
                );
              this.data.tickets.push(t);
              item.ticketId = t.id;
            } else item.overlap = true;
          }
        } catch (e) {
          item.state = "failed";
          item.error = e.message;
          failure(e, item.stock.symbol);
        }
        this.data.job.done++;
        await this.persist();
      }
      this.data.job.status = this.data.job.errors.length
        ? "partial"
        : "completed";
      this.data.job.note =
        "今日快照与条件已冻结；再次更新仅补失败与待处理，不改写成功信号";
    } catch (e) {
      this.data.job.status = "stopped";
      this.data.job.note = signal.aborted
        ? "已停止，保留已保存记录；当日可再次更新补齐"
        : e.message;
    } finally {
      this.data.job.current = null;
      this.data.job.finishedAt = this.now().toISOString();
      try {
        await this.persist();
      } catch (e) {
        this.lastError = e.message;
      }
      if (!signal.aborted && this.calendar?.shouldRefresh())
        await this.calendar.refresh(signal).catch(() => {});
      this.active = false;
    }
  }
  stop(reason = "user") {
    if (this.active && this.data.job?.status === "running")
      this.data.job.stopReason = reason;
    this.controller?.abort();
    if (this.store.refresh.running) this.store.stopRefresh();
  }
  async tick() {
    if (this.scheduler) {
      try {
        return await this.scheduler.tick();
      } finally {
        await this.reports?.refresh();
      }
    }
    const c = chinaClock(this.now());
    // Retry calendar evidence independently of a terminal screening failure.
    if (
      this.data.autoAttempt === c.date &&
      !this.canRetryAutomatically() &&
      !this.active &&
      !this.store.running() &&
      !this.store.refresh.running &&
      !this.store.research.active &&
      this.calendar?.shouldRefresh()
    )
      await this.refreshCalendar();
    if (
      this.storage?.status().blocked ||
      !this.data.plans.length ||
      closure(c.date) ||
      c.minutes < 980 ||
      (this.data.autoAttempt === c.date &&
        (!this.canRetryAutomatically() ||
          (this.data.autoRetryCount || 0) >= 1)) ||
      this.active ||
      this.store.running() ||
      this.store.refresh.running ||
      this.store.research.active
    )
      return;
    try {
      await this.start(true);
    } catch (e) {
      this.lastError = e.message;
    }
  }
  canRetryAutomatically() {
    const job = this.data.job;
    if (!job?.automatic || !["stopped", "partial"].includes(job.status))
      return false;
    const finished = Date.parse(job.finishedAt || job.recoveredAt);
    if (
      !Number.isFinite(finished) ||
      this.now().getTime() < finished + 10 * 60 * 1000
    )
      return false;
    const errors = job.errors || [];
    if (
      errors.some(
        (e) =>
          ["blocked", "cooldown"].includes(e.kind) &&
          (!e.retryAt || this.now().getTime() < e.retryAt),
      )
    )
      return false;
    return (
      errors.some((e) =>
        ["transient", "blocked", "cooldown"].includes(e.kind),
      ) ||
      (job.status === "stopped" &&
        !errors.length &&
        /超时|连接|网络|中断|socket|fetch/i.test(job.note || ""))
    );
  }
}
