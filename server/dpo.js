import { randomUUID, createHash } from "node:crypto";
import { readCache, writeCache } from "./cache.js";
import { baseReason, validateConfig } from "../shared/rules.js";
import { isCompletedDate } from "../shared/time.js";
import {
  dpoVersion,
  dpoFormula,
  dpoAssumptions,
  validateDpo,
} from "../shared/dpo-rules.js";
import { analyzeDpo, summarizeDpo } from "./dpo-analysis.js";
import {
  runItems,
  selectWork,
  recoverJob,
  summarizeJob,
} from "./scan-runner.js";
import { providerStatus, restoreProviderStatus } from "./providers.js";

export class Dpo {
  job = null;
  active = false;
  constructor(store, { read = readCache, write = writeCache } = {}) {
    Object.assign(this, { store, read, write });
  }
  async init() {
    const saved = await this.read("last-dpo");
    if (
      saved &&
      (saved.schema !== 1 ||
        saved.version !== dpoVersion ||
        !Array.isArray(saved.items))
    )
      throw Error("DPO任务格式异常，请保留原文件核对");
    this.job = recoverJob(saved);
    restoreProviderStatus(saved?.providerStatus);
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
    this.job.summary = summarizeDpo(this.job.items);
    this.job.providerStatus = providerStatus();
    await this.write("last-dpo", this.job);
  }
  state() {
    if (!this.job) return { active: this.active, job: null };
    const {
      items,
      results,
      nearMiss,
      errors,
      providerStatus: providers,
      ...job
    } = this.job;
    return { active: this.active, job: { ...job, matched: results.length } };
  }
  rows(query) {
    const view = query.get("view") || "stocks",
      page = Number(query.get("page") || 1);
    if (
      !["stocks", "trades", "pending", "errors"].includes(view) ||
      !Number.isInteger(page) ||
      page < 1 ||
      page > 10000
    )
      throw Error("DPO列表参数不正确");
    const rows = this.records(view),
      size = 25;
    return {
      jobId: this.job?.id,
      page,
      total: rows.length,
      pages: Math.max(1, Math.ceil(rows.length / size)),
      rows: rows.slice((page - 1) * size, page * size),
    };
  }
  records(view) {
    const items = this.job?.items || [];
    if (view === "errors")
      return items
        .filter((i) => i.state === "failed")
        .map((i) => ({ ...i.stock, ...i.error }));
    const valid = items.filter((i) =>
      ["matched", "unmatched"].includes(i.state),
    );
    if (view === "trades") return valid.flatMap((i) => i.analysis.trades);
    if (view === "pending") return valid.flatMap((i) => i.analysis.pending);
    return valid
      .map((i) => ({
        ...i.stock,
        ...i.analysis.latest,
        source: i.source,
        trades: i.analysis.trades.length,
      }))
      .sort(
        (a, b) =>
          Number(b.stage !== "none") - Number(a.stage !== "none") ||
          b.amount - a.amount,
      );
  }
  detail(symbol) {
    const item = this.job?.items.find((i) => i.stock.symbol === symbol);
    if (!item?.analysis) throw Error("没有该股票的DPO证据");
    return {
      stock: item.stock,
      source: item.source,
      fetchedAt: item.fetchedAt,
      inputHash: item.inputHash,
      ...item.analysis,
    };
  }
  export() {
    return {
      ...this.state(),
      trades: this.records("trades"),
      pending: this.records("pending"),
      stocks: this.records("stocks"),
      errors: this.records("errors"),
      evidence: this.job?.items.map((i) => ({
        stock: i.stock,
        state: i.state,
        source: i.source,
        fetchedAt: i.fetchedAt,
        inputHash: i.inputHash,
        from: i.analysis?.from,
        to: i.analysis?.to,
        historyBars: i.analysis?.historyBars,
        error: i.error,
      })),
    };
  }
  async start(input) {
    this.assertIdle();
    const config = validateDpo(input),
      snapshot = this.store.market;
    if (!snapshot || !isCompletedDate(snapshot.date))
      throw Error("请先取得最近完成交易日行情");
    this.active = true;
    try {
      await this.store.checkResources();
      const base = validateConfig({
          strategy: "swing",
          board: "all",
          minAmountYi: 2,
          minPrice: 3,
          excludeST: true,
          excludeInactive: true,
        }),
        excluded = {};
      const pool = snapshot.stocks
        .filter((s) => {
          const reason = baseReason(s, base, snapshot.date);
          if (reason) excluded[reason] = (excluded[reason] || 0) + 1;
          return !reason;
        })
        .sort(
          (a, b) => b.amount - a.amount || a.symbol.localeCompare(b.symbol),
        );
      if (!pool.length) throw Error("当前完成行情没有合格样本");
      this.job = {
        schema: 1,
        version: dpoVersion,
        id: randomUUID(),
        status: "running",
        config,
        date: snapshot.date,
        snapshotFetchedAt: snapshot.fetchedAt,
        baseConfig: base,
        marketCount: snapshot.stocks.length,
        baseCount: pool.length,
        target: Math.min(config.maxStocks, pool.length),
        notScanned: Math.max(0, pool.length - config.maxStocks),
        excluded,
        done: 0,
        failed: 0,
        unmatched: 0,
        cacheHits: 0,
        networkRequests: 0,
        networkRetries: 0,
        results: [],
        errors: [],
        startedAt: new Date().toISOString(),
        formula: dpoFormula,
        assumptions: dpoAssumptions,
        items: pool
          .slice(0, config.maxStocks)
          .map((s) => ({
            stock: {
              symbol: s.symbol,
              code: s.code,
              name: s.name,
              amount: s.amount,
            },
            state: "pending",
            attempts: 0,
          })),
      };
      summarizeJob(this.job);
      await this.save();
      this.controller = new AbortController();
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
  async continue(mode) {
    this.assertIdle();
    if (!["resume", "retry"].includes(mode)) throw Error("无效DPO操作");
    const indices = selectWork(this.job, mode);
    if (!indices.length) throw Error("没有相应的未完成股票");
    this.active = true;
    try {
      await this.store.checkResources();
      this.controller = new AbortController();
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
        load: (s, signal, event) =>
          this.store.history(s.symbol, this.job.date, signal, event),
        evaluate: (s, h, item) => {
          if (h.adjustment !== "前复权") throw Error("DPO要求前复权日线");
          item.analysis = analyzeDpo(s, h.bars, this.job.date, this.job.config);
          item.inputHash = createHash("sha256")
            .update(
              JSON.stringify(h.bars.filter((b) => b.date <= this.job.date)),
            )
            .digest("hex");
          item.fetchedAt = h.fetchedAt;
          return item.analysis.latest.stage !== "none"
            ? { ...s, ...item.analysis.latest }
            : null;
        },
        save: () => this.save(),
      });
    } finally {
      this.active = false;
    }
  }
  stop() {
    this.controller?.abort();
  }
}
