import * as fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { validDate } from "./trading-calendar.js";
import { validateTrend } from "../shared/trend-rules.js";
import { compareTrend, comparable, ruleKey } from "./trend-compare.js";
import { paginate } from "./status-view.js";
import { archiveRoot } from "./paths.js";

const MiB = 1024 ** 2,
  MAX_FILE = 12 * MiB;
const idPattern = /^[a-f0-9]{64}$/;
const stopped = ["completed", "partial", "stopped", "paused"];
const states = ["matched", "unmatched", "failed", "pending"];
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");

function metadata(record, id, size) {
  const { job } = record;
  if (
    record.schema !== 1 ||
    record.ruleVersion !== 1 ||
    !job?.id ||
    !validDate(job.date) ||
    !Number.isFinite(Date.parse(job.finishedAt)) ||
    !stopped.includes(job.status) ||
    !Array.isArray(job.items) ||
    job.items.length !== job.target ||
    job.items.length > 2000
  )
    throw Error("趋势档案格式异常");
  const config = validateTrend(job.config);
  const symbols = new Set(),
    counts = Object.fromEntries(states.map((s) => [s, 0]));
  for (const i of job.items) {
    const symbol = i.stock?.symbol;
    if (
      !/^(sh|sz)\d{6}$/.test(symbol) ||
      symbols.has(symbol) ||
      !states.includes(i.state)
    )
      throw Error("趋势档案股票身份或状态异常");
    symbols.add(symbol);
    if (
      ["matched", "unmatched"].includes(i.state) &&
      !Array.isArray(i.evidence?.checks)
    )
      throw Error("趋势档案缺少有效判定依据");
    counts[i.state]++;
  }
  return {
    id,
    size,
    jobId: job.id,
    date: job.date,
    finishedAt: job.finishedAt,
    startedAt: job.startedAt,
    snapshotFetchedAt: job.snapshotFetchedAt,
    status: job.status,
    config,
    ruleVersion: record.ruleVersion,
    marketCount: job.marketCount,
    baseCount: job.baseCount,
    target: job.target,
    notScanned: job.notScanned,
    counts,
    comparable: comparable(job),
  };
}

export class TrendArchive {
  entries = [];
  version = randomUUID();
  tail = Promise.resolve();
  constructor({
    dir = path.join(archiveRoot, "trend"),
    maxFiles = 30,
    maxBytes = 180 * MiB,
  } = {}) {
    Object.assign(this, { dir: path.resolve(dir), maxFiles, maxBytes });
  }
  async safe(target) {
    if (/^e:/i.test(target)) throw Error("E盘冻结，不能访问趋势档案");
    let dir = path.parse(target).root;
    for (const part of target
      .slice(dir.length)
      .split(path.sep)
      .filter(Boolean)) {
      dir = path.join(dir, part);
      try {
        if ((await fs.lstat(dir)).isSymbolicLink())
          throw Error("趋势档案路径不能经过链接");
      } catch (e) {
        if (e.code === "ENOENT") break;
        throw e;
      }
    }
  }
  file(id) {
    if (!idPattern.test(id || "")) throw Error("无效档案编号");
    return path.join(this.dir, id + ".json");
  }
  async read(id) {
    const file = this.file(id);
    await this.safe(file);
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.size > MAX_FILE)
      throw Error("趋势档案文件类型或容量异常");
    const raw = await fs.readFile(file);
    if (raw.length > MAX_FILE || sha(raw) !== id)
      throw Error("趋势档案校验失败，已保留原文件");
    const record = JSON.parse(raw);
    return { record, raw, entry: metadata(record, id, raw.length) };
  }
  async init() {
    try {
      await this.safe(this.dir);
      await fs.mkdir(this.dir, { recursive: true });
      const files = (await fs.readdir(this.dir)).filter((f) =>
        /^[a-f0-9]{64}\.json$/.test(f),
      );
      if (files.length > this.maxFiles) throw Error("档案目录超过数量上限");
      for (const file of files) {
        try {
          this.entries.push((await this.read(file.slice(0, -5))).entry);
        } catch (e) {
          this.loadError = e.message;
        }
      }
      this.order();
    } catch (e) {
      this.loadError = e.message;
    }
  }
  order() {
    this.entries.sort(
      (a, b) =>
        b.date.localeCompare(a.date) ||
        b.finishedAt.localeCompare(a.finishedAt) ||
        a.id.localeCompare(b.id),
    );
  }
  state() {
    return {
      version: this.version,
      active: false,
      entries: this.entries,
      bytes: this.entries.reduce((n, e) => n + e.size, 0),
      maxFiles: this.maxFiles,
      maxBytes: this.maxBytes,
      error: this.loadError || this.saveError || null,
    };
  }
  capture(job) {
    if (
      !job?.finishedAt ||
      !stopped.includes(job.status) ||
      job.fatal?.startsWith("无法保存")
    )
      return Promise.resolve(null);
    const raw = Buffer.from(JSON.stringify({ schema: 1, ruleVersion: 1, job }));
    const task = this.tail
      .then(() => this.write(raw))
      .catch((e) => {
        this.saveError = e.message;
        throw e;
      });
    this.tail = task.catch(() => {});
    return task;
  }
  async write(raw) {
    if (this.loadError) throw Error(this.loadError);
    const id = sha(raw);
    if (this.entries.some((e) => e.id === id)) {
      const { entry } = await this.read(id);
      this.saveError = null;
      return entry;
    }
    if (
      raw.length > MAX_FILE ||
      this.entries.length >= this.maxFiles ||
      this.state().bytes + raw.length > this.maxBytes
    )
      throw Error("趋势档案已达容量上限。请先导出并整理档案，现有记录已保留");
    const entry = metadata(JSON.parse(raw), id, raw.length);
    await this.safe(this.dir);
    const disk = await fs.statfs(this.dir);
    if (disk.bavail * disk.bsize < 1024 ** 3)
      throw Error("F盘剩余空间不足1GiB，已停止归档");
    const file = this.file(id),
      temp = path.join(this.dir, randomUUID() + ".tmp");
    const h = await fs.open(temp, "wx");
    try {
      try {
        await h.writeFile(raw);
        await h.sync();
      } finally {
        await h.close();
      }
      // Publish a complete file without ever overwriting an existing snapshot.
      try {
        await fs.link(temp, file);
      } catch (e) {
        if (e.code !== "EEXIST") throw e;
      }
      await this.read(id);
    } finally {
      await fs.unlink(temp);
    }
    this.entries.push(entry);
    this.order();
    this.version = randomUUID();
    this.saveError = null;
    return entry;
  }
  checkVersion(query) {
    if (query.get("v") !== this.version)
      throw Object.assign(Error("档案已更新，请重新读取"), { status: 409 });
  }
  async get(id) {
    if (!this.entries.some((e) => e.id === id)) throw Error("档案不存在");
    try {
      return await this.read(id);
    } catch (e) {
      this.loadError = e.message;
      this.comparisonCache = null;
      throw e;
    }
  }
  async comparison(older, newer, version) {
    const key = JSON.stringify([version, older, newer]);
    if (this.comparisonCache?.key === key) return this.comparisonCache.task;
    const task = (async () => {
      const a = (await this.get(older)).record,
        b = (await this.get(newer)).record;
      // Load only compact per-stock states for compatible history; keep two full
      // endpoints for the evidence displayed in the comparison.
      const history = [];
      for (const e of this.entries) {
        if (
          e.date >= b.job.date ||
          e.date === a.job.date ||
          !e.comparable ||
          ruleKey({ ruleVersion: e.ruleVersion, job: e }) !== ruleKey(b)
        )
          continue;
        const { record } = await this.get(e.id);
        history.push({
          ...record,
          job: {
            ...record.job,
            results: undefined,
            errors: undefined,
            nearMiss: undefined,
            items: record.job.items.map((i) => ({
              stock: { symbol: i.stock.symbol },
              state: i.state,
            })),
          },
        });
      }
      return compareTrend(a, b, history);
    })();
    this.comparisonCache = { key, task };
    try {
      return await task;
    } catch (e) {
      if (this.comparisonCache?.task === task) this.comparisonCache = null;
      throw e;
    }
  }
  async rows(query) {
    this.checkVersion(query);
    const version = this.version;
    const q = (query.get("q") || "").trim().toLowerCase();
    if (q.length > 80) throw Error("搜索最多80个字符");
    let rows, summary;
    if (query.has("older")) {
      const result = await this.comparison(
        query.get("older"),
        query.get("newer"),
        version,
      );
      const { rows: all, ...meta } = result;
      summary = meta;
      const type = query.get("type") || "retained";
      if (!["added", "retained", "removed", "unknown"].includes(type))
        throw Error("无效比较分类");
      rows = all.filter((r) => r.category === type);
    } else {
      const { record } = await this.get(query.get("id"));
      const type = query.get("type") || "matched";
      if (!states.includes(type)) throw Error("无效档案分类");
      rows = record.job.items
        .filter((i) => i.state === type)
        .map((i) => ({
          symbol: i.stock.symbol,
          code: i.stock.code,
          name: i.stock.name,
          state: i.state,
          source: i.evidence?.historySource || i.source,
          error: i.error?.message,
          checks: i.evidence?.checks || [],
          score: i.evidence?.metrics?.score,
        }));
    }
    this.checkVersion(query);
    if (q)
      rows = rows.filter((r) =>
        [r.name, r.code, r.symbol].some((s) => s?.toLowerCase().includes(q)),
      );
    return { version, summary, ...paginate(rows, query) };
  }
  async export(query) {
    this.checkVersion(query);
    const { raw, entry } = await this.get(query.get("id"));
    this.checkVersion(query);
    return {
      format: "json",
      name: "trend-archive-" + entry.date + ".json",
      count: entry.target,
      body: raw,
    };
  }
}
