import { randomUUID } from "node:crypto";
import { readCache, writeCache } from "./cache.js";
import { validateConfig } from "../shared/rules.js";
import {
  validateBacktest,
  simulateStock,
  summarizeTrades,
  forwardPerformance,
  assumptions,
} from "./backtest.js";
const thin = (s) =>
  Object.fromEntries(
    [
      "symbol",
      "code",
      "name",
      "price",
      "amount",
      "changePct",
      "quoteDate",
      "source",
      "metrics",
      "checks",
      "historySource",
    ].map((k) => [k, s[k]]),
  );
export function archiveScan(records, job) {
  if (
    !job ||
    !job.id ||
    !job.config ||
    ["running", "stopping"].includes(job.status)
  )
    return records;
  const samples = job.items?.map((i) => i.stock) || job.results;
  const entry = {
    id: job.id,
    date: job.date,
    startedAt: job.startedAt,
    updatedAt: new Date().toISOString(),
    status: job.status,
    config: validateConfig(job.config),
    target: job.target,
    done: job.done,
    failed: job.failed,
    resultCount: job.results.length,
    results: job.results.slice(0, 200).map(thin),
    samples: samples.slice(0, 200).map(thin),
    sampleCount: samples.length,
  };
  const next = [entry, ...records.filter((r) => r.id !== job.id)].slice(0, 30);
  while (
    next.length > 1 &&
    Buffer.byteLength(JSON.stringify(next)) > 8 * 1024 * 1024
  )
    next.pop();
  return next;
}
export function compareRecords(current, previous) {
  const a = new Set(current.results.map((s) => s.symbol)),
    b = new Set(previous.results.map((s) => s.symbol));
  return {
    added: current.results.filter((s) => !b.has(s.symbol)),
    removed: previous.results.filter((s) => !a.has(s.symbol)),
    retained: current.results.filter((s) => b.has(s.symbol)),
    sameConfig:
      JSON.stringify(current.config) === JSON.stringify(previous.config),
  };
}
export class Research {
  records = [];
  job = null;
  active = false;
  controller = null;
  writeTail = Promise.resolve();
  constructor(store) {
    this.store = store;
  }
  async init() {
    this.records = (await readCache("research")) || [];
    if (!Array.isArray(this.records)) this.records = [];
    this.job = await readCache("last-research");
    if (this.job?.status === "running") this.job.status = "stopped";
  }
  list() {
    return this.records.map(({ results, samples, ...r }) => ({
      ...r,
      savedResults: results.length,
      savedSamples: samples.length,
    }));
  }
  record(id) {
    const r = this.records.find((x) => x.id === id);
    if (!r) throw Error("找不到该次筛选记录");
    return r;
  }
  archive(job) {
    const task = this.writeTail.then(async () => {
      this.records = archiveScan(this.records, job);
      await writeCache("research", this.records);
    });
    this.writeTail = task.catch(() => {});
    return task;
  }
  async start(input) {
    this.store.daily?.assertBackgroundAllowed?.();
    if (this.store.daily?.active) throw Error("请等待每日复盘结束");
    if (this.active || this.store.running() || this.store.refresh.running)
      throw Error("请先等待或停止当前任务");
    if (!["backtest", "track"].includes(input.type))
      throw Error("无效研究任务");
    const record = this.record(input.recordId),
      settings = validateBacktest(input.settings),
      asOf = this.store.market?.date;
    if (!asOf || asOf < record.date)
      throw Error("当前行情日期早于入选日，请刷新行情");
    const stocks = (
      input.type === "backtest" ? record.samples : record.results
    ).slice(0, settings.maxStocks);
    if (!stocks.length) throw Error("该记录没有可研究的股票");
    this.active = true;
    try {
      await this.store.checkResources();
      this.controller = new AbortController();
      this.job = {
        id: randomUUID(),
        type: input.type,
        status: "running",
        recordId: record.id,
        config: record.config,
        settings,
        asOf,
        originDate: record.date,
        target: stocks.length,
        total:
          input.type === "backtest" ? record.sampleCount : record.resultCount,
        done: 0,
        failed: 0,
        errors: [],
        trades: [],
        rows: [],
        skipped: 0,
        pending: 0,
        signalCount: 0,
        cacheHits: 0,
        startedAt: new Date().toISOString(),
        assumptions:
          input.type === "backtest"
            ? assumptions
            : "入选日收盘至后续有效日线收盘的复权变化，不是交易收益。未到期显示等待；缺失数据独立列出。",
      };
      await writeCache("last-research", this.job);
      this.task = this.run(stocks, record);
      return this.job;
    } catch (e) {
      if (this.job?.status === "running") {
        this.job.status = "stopped";
        this.job.fatal = e.message;
      }
      this.active = false;
      throw e;
    }
  }
  async run(stocks, record) {
    let transientStreak = 0;
    const job = this.job,
      signal = this.controller.signal;
    try {
      for (const stock of stocks) {
        if (signal.aborted) break;
        job.current = stock.name;
        try {
          const h = await this.store.history(stock.symbol, job.asOf, signal);
          signal.throwIfAborted();
          transientStreak = 0;
          if (h.fromCache) job.cacheHits++;
          if (job.type === "backtest") {
            const result = simulateStock(
              stock,
              h.bars,
              record.config,
              job.settings,
              job.asOf,
            );
            job.trades.push(
              ...result.trades.map((t) => ({ ...t, source: h.source })),
            );
            job.skipped += result.skipped;
            job.pending += result.pending;
            job.signalCount += result.signalCount;
          } else
            job.rows.push({
              ...forwardPerformance(stock, h.bars, record.date, job.asOf),
              historySource: h.source,
            });
        } catch (e) {
          if (signal.aborted) break;
          job.failed++;
          job.errors.push({
            symbol: stock.symbol,
            name: stock.name,
            message: e.message,
          });
          if (["ENOSPC", "EACCES", "EIO", "EPERM", "EROFS"].includes(e.code))
            throw e;
          transientStreak = e.kind === "transient" ? transientStreak + 1 : 0;
          if (
            ["blocked", "cooldown"].includes(e.kind) ||
            transientStreak >= 3
          ) {
            job.fatal =
              transientStreak >= 3
                ? "数据源连续不可用，已保留结果；稍后重新运行会复用缓存。"
                : e.message;
            job.status = "stopped";
          }
        }
        job.done++;
        job.summary = summarizeTrades(job.trades);
        await writeCache("last-research", job);
        if (job.status === "stopped") break;
      }
      job.status =
        signal.aborted || job.done < job.target
          ? "stopped"
          : job.failed
            ? "partial"
            : "completed";
    } catch (e) {
      job.status = "stopped";
      job.fatal = e.message;
    } finally {
      job.current = null;
      job.finishedAt = new Date().toISOString();
      job.summary = summarizeTrades(job.trades);
      try {
        await writeCache("last-research", job);
      } catch (e) {
        job.fatal = e.message;
        job.status = "stopped";
      }
      this.active = false;
    }
  }
  stop() {
    this.controller?.abort();
  }
}
