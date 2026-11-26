import { randomUUID } from "node:crypto";
import { readCache, writeCache, resourceCheck, pruneHistory } from "./cache.js";
import {
  fetchMarket,
  fetchMarketBackup,
  fetchHistory,
  fetchQuotes,
  providerStatus,
  restoreProviderStatus,
} from "./providers.js";
import { chinaClock, isCompletedDate } from "../shared/time.js";
import { validateConfig, baseReason } from "../shared/rules.js";
import { analyzeBars, chartBars } from "./indicators.js";
import { abortable } from "./history-client.js";
import { Research } from "./research.js";
import { Daily } from "./daily.js";
import { Trend } from "./trend.js";
import { Dpo } from "./dpo.js";
import {
  runItems,
  recoverJob,
  selectWork,
  summarizeJob,
} from "./scan-runner.js";

export class Store {
  latest = null;
  eod = null;
  job = null;
  refresh = { running: false, done: 0, total: 0, error: null };
  resourceError = null;
  lastRefreshAttempt = 0;
  quoteCache = new Map();
  quotePending = new Map();
  historyPending = new Map();
  starting = false;
  scanActive = false;
  research = new Research(this);
  daily = new Daily(this);
  trend = new Trend(this);
  dpo = new Dpo(this);

  async init() {
    [this.latest, this.eod, this.job] = await Promise.all(
      ["market", "eod", "last-scan"].map(readCache),
    );
    for (const key of ["latest", "eod"]) {
      if (
        this[key] &&
        (!Array.isArray(this[key].stocks) ||
          !this[key].date ||
          this[key].coverage !== this[key].stocks.length)
      )
        this[key] = null;
      if (this[key]) this[key].fromCache = true;
    }
    this.job = recoverJob(this.job);
    restoreProviderStatus(this.job?.providerStatus);
    await this.research.init();
    await this.daily.init();
    await this.trend.init();
    await this.dpo.init();
    if (this.job && !["running", "stopping"].includes(this.job.status))
      await this.research.archive(this.job);
    this.monitor = setInterval(
      () => this.checkResources().catch(() => {}),
      10000,
    );
    this.monitor.unref();
    this.dailyTimer = setInterval(
      () => this.daily.tick().catch(() => {}),
      60000,
    );
    this.dailyTimer.unref();
  }

  async checkResources() {
    try {
      await resourceCheck();
      this.resourceError = null;
    } catch (error) {
      this.resourceError = error.message;
      this.scanController?.abort(error);
      this.refreshController?.abort(error);
      this.research.stop();
      this.trend.stop();
      this.dpo.stop();
      if (this.daily.active) this.daily.stop("resource");
      throw error;
    }
  }

  get market() {
    return this.eod || this.latest;
  }
  marketMeta() {
    const market = this.market;
    if (!market) return null;
    const { stocks, ...meta } = market;
    return {
      ...meta,
      isEodReady: isCompletedDate(market.date),
      latestDate: this.latest?.date || null,
    };
  }
  state() {
    return {
      market: this.marketMeta(),
      refresh: this.refresh,
      job: this.jobMeta(),
      clock: chinaClock(),
      resourceError: this.resourceError,
      researchActive: this.research.active,
      dailyActive: this.daily.active,
      trendActive: this.trend.active,
      dpoActive: this.dpo.active,
    };
  }
  jobMeta() {
    if (!this.job) return null;
    const { items, ...summary } = this.job;
    return { ...summary, canResume: Boolean(items) };
  }
  running() {
    return (
      this.trend.active ||
      this.dpo.active ||
      this.starting ||
      this.scanActive ||
      (this.job && ["running", "stopping"].includes(this.job.status))
    );
  }

  async startRefresh(forDaily = false) {
    if (!forDaily) this.daily.assertBackgroundAllowed();
    if (this.daily.active && !forDaily) throw Error("请等待每日复盘结束");
    if (this.research.active) throw Error("请先等待或停止研究任务");
    if (this.refresh.running) return;
    if (this.running()) throw new Error("请先等待或停止当前筛选。");
    if (Date.now() - this.lastRefreshAttempt < 60000)
      throw new Error("全市场行情刷新至少间隔 60 秒，请稍后重试。");
    // Reserve before the first await so a simultaneous DPO/research start sees it.
    this.refresh.running = true;
    try {
      await this.checkResources();
    } catch (error) {
      this.refresh.running = false;
      throw error;
    }
    this.lastRefreshAttempt = Date.now();
    this.refresh = {
      running: true,
      done: 0,
      total: 0,
      error: null,
      startedAt: new Date().toISOString(),
    };
    this.refreshController = new AbortController();
    this.refreshTask = this.performRefresh();
  }
  async performRefresh() {
    try {
      const options = {
        signal: this.refreshController.signal,
        onProgress: (p) => Object.assign(this.refresh, p),
      };
      let market;
      try {
        market = await fetchMarket(options);
      } catch (error) {
        if (options.signal.aborted) throw error;
        this.refresh.fallback = "主数据源不可用，正在使用新浪目录与腾讯报价。";
        market = await fetchMarketBackup(options);
      }
      await writeCache("market", market);
      if (isCompletedDate(market.date)) {
        await writeCache("eod", market);
        this.eod = market;
      }
      this.latest = market;
      this.refresh.finishedAt = new Date().toISOString();
    } catch (error) {
      this.refresh.error = this.refreshController.signal.aborted
        ? "行情刷新已停止。"
        : error.message;
    } finally {
      this.refresh.running = false;
    }
  }
  stopRefresh() {
    this.refreshController?.abort();
  }

  async history(symbol, asOf, signal, onEvent) {
    const key = `${symbol}-${asOf}`;
    if (this.historyPending.has(key)) {
      try {
        await abortable(this.historyPending.get(key), signal);
      } catch {}
      signal?.throwIfAborted();
      return this.history(symbol, asOf, signal, onEvent);
    }
    const pending = this.loadHistory(symbol, asOf, signal, onEvent);
    this.historyPending.set(key, pending);
    try {
      return await pending;
    } finally {
      this.historyPending.delete(key);
    }
  }
  async loadHistory(symbol, asOf, signal, onEvent) {
    signal?.throwIfAborted();
    const today = chinaClock().date;
    const key = `history/${symbol}-${today}`;
    const cached = await readCache(key);
    if (
      cached?.bars?.length &&
      chinaClock(cached.fetchedAt).date === today &&
      cached.bars.at(-1).date >= asOf
    )
      return { ...cached, fromCache: true };
    const history = await fetchHistory(symbol, signal, asOf, onEvent);
    await writeCache(key, history);
    return { ...history, fromCache: false };
  }

  async detail(symbol, asOf, signal) {
    const date = asOf || this.market?.date;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date || "") || !isCompletedDate(date))
      throw new Error("还没有可用的完成交易日，请收盘后刷新行情。");
    const history = await this.history(symbol, date, signal);
    return {
      ...history,
      bars: chartBars(history.bars, date),
      asOf: date,
      latestBarDate:
        history.bars.filter((b) => b.date <= date).at(-1)?.date || null,
    };
  }

  async startScan(input) {
    this.daily.assertBackgroundAllowed();
    if (this.daily.active) throw Error("请等待每日复盘结束");
    if (this.research.active) throw Error("请先等待或停止研究任务");
    if (this.running() || this.refresh.running)
      throw new Error("请先等待或停止当前任务。");
    if (!this.market) throw new Error("请先刷新行情。");
    if (!isCompletedDate(this.market.date))
      throw new Error("当前只有盘中快照，请收盘后刷新，或使用盘中观察。");
    this.starting = true;
    try {
      await this.checkResources();
      const config = validateConfig(input),
        snapshot = this.market;
      const excluded = {};
      const pool = snapshot.stocks
        .filter((stock) => {
          const reason = baseReason(stock, config, snapshot.date);
          if (reason) excluded[reason] = (excluded[reason] || 0) + 1;
          return !reason;
        })
        .sort(
          (a, b) => b.amount - a.amount || a.symbol.localeCompare(b.symbol),
        );
      const selected = pool.slice(0, config.maxScan);
      this.job = {
        schema: 2,
        id: randomUUID(),
        status: "running",
        config,
        date: snapshot.date,
        marketCount: snapshot.stocks.length,
        baseCount: pool.length,
        target: selected.length,
        notScanned: pool.length - selected.length,
        done: 0,
        failed: 0,
        unmatched: 0,
        cacheHits: 0,
        excluded,
        errors: [],
        results: [],
        startedAt: new Date().toISOString(),
        snapshotFetchedAt: snapshot.fetchedAt,
        networkRequests: 0,
        networkRetries: 0,
        items: selected.map((stock) => ({
          stock,
          state: "pending",
          attempts: 0,
        })),
      };
      summarizeJob(this.job);
      await writeCache("last-scan", this.job);
      this.scanController = new AbortController();
      this.scanTask = this.performScan(
        selected.map((_, i) => i),
        this.job,
        this.scanController,
      );
      return this.jobMeta();
    } catch (error) {
      if (this.job?.status === "running") {
        this.job.status = "paused";
        this.job.fatal = error.message;
      }
      throw error;
    } finally {
      this.starting = false;
    }
  }

  async continueScan(mode, symbols) {
    this.daily.assertBackgroundAllowed();
    if (this.daily.active) throw Error("请等待每日复盘结束");
    if (this.research.active) throw Error("请先等待或停止研究任务");
    if (this.running() || this.refresh.running)
      throw new Error("请先等待或停止当前任务。");
    const indices = selectWork(this.job, mode, symbols);
    if (!indices.length)
      throw new Error(
        mode === "retry" ? "没有需要重试的失败股票。" : "没有待续跑的股票。",
      );
    this.starting = true;
    try {
      await this.checkResources();
      this.scanController = new AbortController();
      this.scanTask = this.performScan(indices, this.job, this.scanController);
      return this.jobMeta();
    } finally {
      this.starting = false;
    }
  }

  async performScan(indices, job, controller) {
    this.scanActive = true;
    try {
      await runItems(job, indices, {
        signal: controller.signal,
        load: (stock, signal, onEvent) =>
          this.history(stock.symbol, job.date, signal, onEvent),
        evaluate: (stock, history, item) => {
          const analysis = analyzeBars(history.bars, job.date, job.config);
          item.evidence = {
            ...stock,
            metrics: analysis.metrics,
            checks: analysis.checks,
            strategy: job.config.strategy,
            historySource: history.source,
          };
          if (!analysis.passed) return null;
          const checks = [
            {
              label: "成交额 ≥ " + job.config.minAmountYi + " 亿元",
              pass: true,
              detail: "实际 " + (stock.amount / 1e8).toFixed(2) + " 亿元",
            },
          ];
          if (job.config.strategy === "short")
            checks.push(
              {
                label:
                  "涨跌幅 " +
                  job.config.minChange +
                  "%–" +
                  job.config.maxChange +
                  "%",
                pass: true,
                detail: "实际 " + stock.changePct.toFixed(2) + "%",
              },
              {
                label:
                  "换手率 " +
                  job.config.minTurnover +
                  "%–" +
                  job.config.maxTurnover +
                  "%",
                pass: true,
                detail: "实际 " + stock.turnover.toFixed(2) + "%",
              },
            );
          return {
            ...stock,
            metrics: analysis.metrics,
            checks: [...analysis.checks, ...checks],
            strategy: job.config.strategy,
            historySource: history.source,
          };
        },
        save: (value) => {
          value.providerStatus = providerStatus();
          return writeCache("last-scan", value);
        },
      });
      try {
        await this.research.archive(job);
        await pruneHistory();
      } catch (error) {
        this.resourceError = error.message;
      }
    } finally {
      this.scanActive = false;
    }
  }
  stopScan() {
    if (this.job && ["running", "stopping"].includes(this.job.status)) {
      this.job.status = "stopping";
      this.scanController?.abort();
    }
  }

  async quotes(symbols) {
    const unique = [...new Set(symbols)].sort();
    const key = unique.join(",");
    const cached = this.quoteCache.get(key);
    if (cached && Date.now() - Date.parse(cached.fetchedAt) < 60000)
      return { ...cached, fromCache: true };
    if (this.quotePending.has(key)) return this.quotePending.get(key);
    const pending = fetchQuotes(unique)
      .then((result) => {
        if (this.quoteCache.size >= 20)
          this.quoteCache.delete(this.quoteCache.keys().next().value);
        this.quoteCache.set(key, result);
        return result;
      })
      .finally(() => this.quotePending.delete(key));
    this.quotePending.set(key, pending);
    return pending;
  }
}
