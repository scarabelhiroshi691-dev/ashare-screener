import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { dataDir, writeCache } from "./cache.js";
import { reviewDir, portable } from "./paths.js";
import { sinaProvider } from "./providers.js";
import { chinaClock } from "../shared/time.js";
import {
  buildCalendarReview,
  parseCalendarEvidence,
  validateEvidenceCache,
  validDate,
  closure,
  verificationTarget,
} from "./trading-calendar.js";

const digest = (evidence) =>
  createHash("sha256").update(JSON.stringify(evidence)).digest("hex");
async function readJson(file) {
  try {
    if ((await stat(file)).size > 2 * 1024 * 1024)
      throw Error("交易日证据文件超过2MiB");
    return JSON.parse(await readFile(file, "utf8"));
  } catch (e) {
    if (e.code === "ENOENT") return null;
    throw e;
  }
}
export class CalendarStore {
  data = {
    schema: 1,
    evidence: [],
    sha256: digest([]),
    attempt: null,
    lastError: null,
  };
  active = false;
  constructor({
    now = () => new Date(),
    provider = sinaProvider,
    read = () => readJson(path.join(dataDir, "trading-calendar.json")),
    write = (value) => writeCache("trading-calendar", value),
    readPlan = () => readJson(path.join(reviewDir, "plan.json")),
  } = {}) {
    Object.assign(this, { now, provider, read, write, readPlan });
  }
  async init() {
    try {
      const saved = await this.read();
      if (saved) {
        if (saved.schema !== 1 || saved.sha256 !== digest(saved.evidence))
          throw Error("交易日缓存校验不一致");
        validateEvidenceCache(saved.evidence, this.now());
        if (
          saved.attempt &&
          (!validDate(saved.attempt.date) ||
            !Number.isInteger(saved.attempt.count) ||
            saved.attempt.count < 1 ||
            saved.attempt.count > 2 ||
            !Number.isFinite(Date.parse(saved.attempt.at)))
        )
          throw Error("交易日缓存请求记录异常");
        this.data = saved;
        this.provider.restore(saved.providerStatus);
        if (saved.attempt?.running) {
          saved.attempt.running = false;
          saved.lastError = {
            message: "上次交易日核验中断；保留已验证日期",
            kind: "transient",
            retryAt: null,
          };
        }
      }
    } catch (e) {
      this.cacheError = `交易日缓存不可用：${e.message}；缺少证据的日期保持待核验`;
      // Corrupt retry state must not reset the request allowance at each restart.
      this.writeBlocked = true;
    }
    await this.loadPlan();
  }
  async loadPlan() {
    try {
      const p = await this.readPlan();
      if (!p && this.plan)
        throw Error("原阶段计划文件缺失，保留上次读取的报告状态");
      if (
        p &&
        (!validDate(p.baselineSignalDate) ||
          !Array.isArray(p.checkpoints) ||
          !p.checkpoints.every((c) => [3, 5, 10].includes(c.day)))
      )
        throw Error("阶段计划格式异常");
      this.plan = p;
      this.planError = null;
    } catch (e) {
      this.planError = `阶段计划读取失败：${e.message}`;
    }
  }
  review(ledger, active = false) {
    const report = buildCalendarReview({
      ledger,
      evidence: this.data.evidence,
      plan: this.plan,
      now: this.now(),
      active,
    });
    const planError =
      this.planError ||
      (ledger.plans?.length && !this.plan && !portable
        ? "阶段计划文件缺失，节点状态待核验"
        : null);
    if (planError) {
      report.exact = false;
      report.checkpoints = report.checkpoints.map((c) =>
        c.report ? c : { ...c, status: "unverified", dueDate: null },
      );
    }
    return {
      ...report,
      active: this.active,
      checkedAt: this.data.checkedAt || null,
      fetchedAt: this.data.fetchedAt || null,
      cacheError: this.cacheError || null,
      planError,
      lastError: this.data.lastError,
      attempt: this.data.attempt,
      canRefresh: this.canRefresh(),
      refreshReason: this.refreshReason(),
      excluded: this.data.excluded || null,
      source: "新浪上证综指完成日线 + 当日已保存行情快照",
      cachePath: ".data/trading-calendar.json",
    };
  }
  refreshReason() {
    if (this.active) return "交易日核验进行中";
    if (this.writeBlocked)
      return "交易日缓存异常，需先修复缓存；保留已知日期，不自动重置请求次数";
    const now = this.now().getTime(),
      attempt = this.data.attempt;
    const blocked = Math.max(
      this.provider.status().blockedUntil || 0,
      this.data.lastError?.retryAt || 0,
    );
    if (blocked > now) return `数据源冷却至${new Date(blocked).toISOString()}`;
    if (attempt?.date === chinaClock(this.now()).date) {
      if (attempt.count >= 2) return "今日交易日核验已达到2次上限，等待下一日";
      if (
        !this.data.lastError &&
        this.data.evidence.at(-1)?.date >= verificationTarget(this.now())
      )
        return "今日交易日核验已成功，无需重复请求";
      if (
        this.data.lastError &&
        !["transient", "blocked", "cooldown"].includes(this.data.lastError.kind)
      )
        return "响应或存储异常，需要排查，不自动重复请求";
      if (now < Date.parse(attempt.at) + 600000)
        return "上次核验未满10分钟，稍后按冷却规则重试";
    }
    return null;
  }
  canRefresh() {
    return !this.refreshReason();
  }
  shouldRefresh() {
    const c = chinaClock(this.now());
    return c.minutes >= 980 && !closure(c.date) && this.canRefresh();
  }
  async refresh(signal) {
    const reason = this.refreshReason();
    if (reason) throw Error(reason);
    this.active = true;
    const date = chinaClock(this.now()).date;
    try {
      this.data.attempt = {
        date,
        at: this.now().toISOString(),
        count:
          this.data.attempt?.date === date ? this.data.attempt.count + 1 : 1,
        running: true,
      };
      // Save the attempt before any network I/O, so restarting cannot bypass limits.
      await this.save();
      await this.loadPlan();
      signal?.throwIfAborted();
      const response = await this.provider.fetchCalendar(signal);
      signal?.throwIfAborted();
      const parsed = parseCalendarEvidence(response, this.now());
      const merged = new Map(this.data.evidence.map((e) => [e.date, e]));
      for (const e of parsed.evidence) merged.set(e.date, e);
      const evidence = [...merged.values()].sort((a, b) =>
        a.date.localeCompare(b.date),
      );
      if (evidence.length > 4000) throw Error("交易日证据达到上限，请先归档");
      const target = verificationTarget(this.now());
      const lastError =
        parsed.evidence.at(-1).date < target
          ? {
              message: `指数完成日线仅到${parsed.evidence.at(-1).date}，${target}尚待核验（缺失不代表休市）`,
              kind: "transient",
              retryAt: null,
            }
          : null;
      const next = {
        ...this.data,
        evidence,
        sha256: digest(evidence),
        checkedAt: this.now().toISOString(),
        fetchedAt: response.fetchedAt,
        excluded: parsed.excluded,
        lastError,
        attempt: { ...this.data.attempt, running: false },
        providerStatus: this.provider.status(),
      };
      await this.write(next);
      this.data = next;
    } catch (e) {
      this.data.lastError = {
        message: e.message,
        kind: e.kind || (signal?.aborted ? "transient" : "data"),
        retryAt: e.retryAt || null,
      };
      this.data.attempt.running = false;
      try {
        await this.save();
      } catch (writeError) {
        this.cacheError = `交易日证据保存失败：${writeError.message}`;
        this.writeBlocked = true;
      }
    } finally {
      this.active = false;
    }
  }
  async save() {
    this.data.providerStatus = this.provider.status();
    await this.write(this.data);
  }
}
