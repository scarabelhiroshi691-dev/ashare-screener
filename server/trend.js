import { randomUUID, createHash } from "node:crypto";
import { readCache, writeCache } from "./cache.js";
import { baseReason } from "../shared/rules.js";
import { chinaClock, isCompletedDate } from "../shared/time.js";
import { validateTrend, trendBaseConfig } from "../shared/trend-rules.js";
import { analyzeTrend } from "./trend-analysis.js";
import {
  runItems,
  selectWork,
  recoverJob,
  summarizeJob,
} from "./scan-runner.js";
import { providerStatus, restoreProviderStatus } from "./providers.js";
import { chartBars } from "./indicators.js";

export class Trend {
  job = null;
  active = false;
  constructor(store, { read = readCache, write = writeCache } = {}) {
    Object.assign(this, { store, read, write });
  }
  async init() {
    const saved = await this.read("last-trend");
    if (saved && (saved.schema !== 1 || !Array.isArray(saved.items)))
      throw Error("趋势任务缓存格式异常，保留原文件并停止加载");
    this.job = recoverJob(saved);
    this.recoveredPriority = !!this.job?.priorityYield;
    restoreProviderStatus(this.job?.providerStatus);
  }
  state({ summaryOnly = false } = {}) {
    if (!this.job) return { active: this.active, job: null };
    const { items, nearMiss, results, errors, ...summary } = this.job;
    const rank = (a, b) =>
      b.metrics.score - a.metrics.score || a.symbol.localeCompare(b.symbol);
    return {
      active: this.active,
      job: {
        ...summary,
        matched: results.length,
        priorityNotice: this.yieldRequest
          ? "每日复盘已预约；当前股票保存后暂停让行"
          : this.job.priorityYield
            ? this.recoveredPriority
              ? "上次因每日复盘让行；服务已重启，请手动继续原任务"
              : this.job.priorityYield.autoResume
                ? "已保存进度并让行；每日复盘正常结束后继续原剩余队列"
                : "原进度已保留，请手动核对后继续"
            : null,
        ...(summaryOnly
          ? {}
          : {
              errors,
              results: [...results].sort(rank),
              unmatchedResults: items
                .filter((i) => i.state === "unmatched")
                .map((i) => i.evidence)
                .sort(rank),
            }),
      },
    };
  }
  assertIdle() {
    this.store.daily.assertBackgroundAllowed?.();
    if (
      this.active ||
      this.store.running() ||
      this.store.refresh.running ||
      this.store.research.active ||
      this.store.daily.active
    )
      throw Error("请等待或停止当前任务");
  }
  async save() {
    this.job.providerStatus = providerStatus();
    await this.write("last-trend", this.job);
  }
  async archiveCurrent() {
    if (!this.archive) return;
    // Read the durable task, not a recovered or in-flight memory copy.
    await this.archive.capture(await this.read("last-trend"));
  }
  async load(symbol, date, signal, onEvent) {
    signal?.throwIfAborted();
    const cached = await this.read(`history/${symbol}-${date}`);
    if (
      cached?.symbol === symbol &&
      cached.adjustment === "前复权" &&
      cached.bars?.length &&
      cached.bars.at(-1).date === date &&
      Number.isFinite(Date.parse(cached.fetchedAt)) &&
      chinaClock(cached.fetchedAt).date === date &&
      chinaClock(cached.fetchedAt).minutes >= 910
    )
      return { ...cached, fromCache: true };
    return this.store.history(symbol, date, signal, onEvent);
  }
  async start(input) {
    this.assertIdle();
    const config = validateTrend(input),
      snapshot = this.store.market;
    if (!snapshot || !isCompletedDate(snapshot.date))
      throw Error("请先取得最近完成交易日行情");
    this.active = true;
    try {
      await this.store.checkResources();
      await this.archiveCurrent();
      const excluded = {},
        base = trendBaseConfig(config);
      const pool = snapshot.stocks
        .filter((s) => {
          const r = baseReason(s, base, snapshot.date);
          if (r) excluded[r] = (excluded[r] || 0) + 1;
          return !r;
        })
        .sort(
          (a, b) => b.amount - a.amount || a.symbol.localeCompare(b.symbol),
        );
      this.job = {
        schema: 1,
        id: randomUUID(),
        status: "running",
        config,
        date: snapshot.date,
        snapshotFetchedAt: snapshot.fetchedAt,
        marketCount: snapshot.stocks.length,
        baseCount: pool.length,
        target: Math.min(pool.length, config.maxScan),
        notScanned: Math.max(0, pool.length - config.maxScan),
        excluded,
        done: 0,
        pending: 0,
        failed: 0,
        unmatched: 0,
        results: [],
        errors: [],
        cacheHits: 0,
        networkRequests: 0,
        networkRetries: 0,
        startedAt: new Date().toISOString(),
        items: structuredClone(pool.slice(0, config.maxScan)).map((stock) => ({
          stock,
          state: "pending",
          attempts: 0,
        })),
      };
      this.controller = new AbortController();
      this.yieldRequest = null;
      this.recoveredPriority = false;
      summarizeJob(this.job);
      await this.save();
      this.task = this.run(this.job.items.map((_, i) => i));
      return this.state();
    } catch (e) {
      this.active = false;
      if (this.job?.status === "running") {
        this.job.status = "paused";
        this.job.fatal = e.message;
      }
      throw e;
    }
  }
  async continue(mode, symbols) {
    this.assertIdle();
    if (!["resume", "retry"].includes(mode)) throw Error("无效趋势任务操作");
    const indices = selectWork(this.job, mode, symbols);
    if (!indices.length) throw Error("没有相应的未完成股票");
    this.active = true;
    try {
      await this.store.checkResources();
      this.controller = new AbortController();
      this.job.priorityYield = null;
      this.yieldRequest = null;
      this.recoveredPriority = false;
      this.task = this.run(indices);
      return this.state();
    } catch (e) {
      this.active = false;
      throw e;
    }
  }
  async run(indices) {
    try {
      await runItems(this.job, indices, {
        signal: this.controller.signal,
        beforeItem: (remaining) => {
          if (!this.yieldRequest) return false;
          this.job.priorityYield = {
            ...this.yieldRequest,
            jobId: this.job.id,
            indices: remaining,
            identityHash: this.identityHash(),
            pausedAt: new Date().toISOString(),
            autoResume: true,
          };
          this.yieldRequest = null;
          return true;
        },
        load: (stock, signal, event) =>
          this.load(stock.symbol, this.job.date, signal, event),
        evaluate: (stock, h, item) => {
          const a = analyzeTrend(h.bars, this.job.date, this.job.config);
          item.evidence = {
            ...stock,
            trend: true,
            metrics: a.metrics,
            checks: a.checks,
            historySource: h.source,
            historyFetchedAt: h.fetchedAt,
          };
          return a.passed ? item.evidence : null;
        },
        save: () => this.save(),
        onResourceError: (e) => {
          this.lastError = e.message;
        },
      });
      if (!this.job.fatal?.startsWith("无法保存"))
        await this.archiveCurrent().catch(() => {});
    } finally {
      this.yieldRequest = null;
      if (this.job?.fatal?.startsWith("无法保存") && this.job.priorityYield)
        this.job.priorityYield.autoResume = false;
      this.active = false;
    }
  }
  identityHash() {
    return createHash("sha256")
      .update(
        JSON.stringify({
          date: this.job.date,
          config: this.job.config,
          symbols: this.job.items.map((i) => i.stock.symbol),
        }),
      )
      .digest("hex");
  }
  requestDailyYield(task) {
    if (!this.active || this.controller?.signal.aborted || this.yieldRequest)
      return;
    this.yieldRequest = {
      key: task.key,
      requestedAt: new Date().toISOString(),
      reason: "每日复盘优先，当前股票保存后让行",
    };
  }
  async resumeAfterDaily(key) {
    const p = this.job?.priorityYield;
    if (
      !p?.autoResume ||
      p.key !== key ||
      p.jobId !== this.job.id ||
      p.identityHash !== this.identityHash() ||
      !Array.isArray(p.indices) ||
      !p.indices.length ||
      new Set(p.indices).size !== p.indices.length ||
      p.indices.some(
        (i) =>
          !Number.isInteger(i) ||
          i < 0 ||
          i >= this.job.items.length ||
          !["pending", "failed"].includes(this.job.items[i].state),
      )
    )
      throw Error("趋势续跑身份或剩余队列不一致，请手动核对");
    this.assertIdle();
    this.active = true;
    try {
      await this.store.checkResources();
      const indices = [...p.indices];
      this.job.priorityYield = null;
      this.controller = new AbortController();
      await this.save();
      this.task = this.run(indices);
    } catch (e) {
      this.active = false;
      throw e;
    }
  }
  async stop() {
    this.yieldRequest = null;
    if (this.job?.priorityYield) this.job.priorityYield.autoResume = false;
    this.controller?.abort();
    if (!this.active && this.job?.priorityYield) {
      try {
        await this.save();
      } catch (e) {
        this.job.fatal = `无法保存取消续跑：${e.message}`;
      }
    }
  }
  async detail(symbol, date, signal) {
    const item = this.job?.items.find((i) => i.stock.symbol === symbol);
    if (!item || date !== this.job.date)
      throw Error("请选择当前趋势任务内的股票与日期");
    const h = await this.load(symbol, date, signal);
    if (
      item.evidence?.historySource &&
      item.evidence.historySource !== h.source
    )
      throw Error("图表来源与本次评分不同，请重新筛选后查看");
    return {
      ...h,
      bars: chartBars(h.bars, date),
      asOf: date,
      latestBarDate: h.bars.at(-1)?.date,
    };
  }
}
