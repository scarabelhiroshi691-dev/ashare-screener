import React, { useEffect, useState } from "react";
import { trendDefaults, validateTrend } from "../shared/trend-rules";
import { api, fmt, pct, time } from "./api";
import {
  useViewStatus,
  useViewRows,
  PageNav,
  downloadView,
} from "./paged-view";
import Details from "./Details";
import TrendArchivePanel from "./TrendArchivePanel";

const statusNames = {
  running: "正在筛选",
  completed: "扫描完成",
  partial: "扫描完成，存在失败",
  paused: "已暂停",
  stopped: "已停止",
};
function initialConfig() {
  try {
    return validateTrend(
      JSON.parse(localStorage.getItem("a-trend-config")) || {},
    );
  } catch {
    return trendDefaults;
  }
}
export default function TrendPanel({ busy, market, watch, toggle, onRefresh }) {
  const [config, setConfig] = useState(initialConfig),
    [error, setError] = useState(""),
    [view, setView] = useState("matched"),
    [search, setSearch] = useState(""),
    [sort, setSort] = useState("score"),
    [selected, setSelected] = useState(null),
    [page, setPage] = useState(1),
    [requesting, setRequesting] = useState(false);
  useEffect(() => {
    localStorage.setItem("a-trend-config", JSON.stringify(config));
  }, [config]);
  const { state, error: pollError, refresh } = useViewStatus("trend");
  const result = useViewRows(
    "trend",
    state?.job && state.version,
    { type: view, q: search, sort, page },
    refresh,
  );
  const job = state?.job,
    active = state?.active || requesting,
    locked = busy || active;
  let changed = false;
  try {
    changed =
      job &&
      JSON.stringify(validateTrend(config)) !== JSON.stringify(job.config);
  } catch {
    changed = Boolean(job);
  }
  const rows = result.data?.rows || [];
  const stock = ["matched", "unmatched"].includes(view)
    ? rows.find((s) => s.symbol === selected) || rows[0]
    : null;
  async function action(path, body = {}) {
    setError("");
    setRequesting(true);
    try {
      await api("trend/" + path, body);
      await refresh();
    } catch (e) {
      setError(e.message);
    } finally {
      setRequesting(false);
    }
  }
  const field = (key, label, min, max, step = 1) => (
    <label key={key}>
      {label}
      <input
        type="number"
        aria-label={label}
        value={config[key]}
        min={min}
        max={max}
        step={step}
        onChange={(e) => setConfig((c) => ({ ...c, [key]: e.target.value }))}
      />
    </label>
  );
  async function exportResults(format) {
    setError("");
    try {
      await downloadView("trend", state.version, format);
    } catch (e) {
      setError(e.message);
      if (e.status === 409) refresh();
    }
  }
  return (
    <main className="trend-layout">
      <aside className="filters trend-controls">
        <h2>稳健趋势条件</h2>
        <p className="hint">
          先找持续上行，再检查回撤和平顺度。不是寻找当天涨幅最大的股票。
        </p>
        <fieldset disabled={locked}>
          <label>
            股票范围
            <select
              value={config.board}
              onChange={(e) =>
                setConfig((c) => ({ ...c, board: e.target.value }))
              }
            >
              <option value="all">沪深 A 股</option>
              <option value="main">主板</option>
              <option value="growth">创业板</option>
              <option value="star">科创板</option>
            </select>
          </label>
          <label>
            历史分析窗口
            <select
              value={config.lookback}
              onChange={(e) =>
                setConfig((c) => ({ ...c, lookback: Number(e.target.value) }))
              }
            >
              <option value={120}>120 根 · 约半年</option>
              <option value={60}>60 根 · 约三个月</option>
            </select>
          </label>
          <label>
            历史扫描上限
            <select
              value={config.maxScan}
              onChange={(e) =>
                setConfig((c) => ({ ...c, maxScan: Number(e.target.value) }))
              }
            >
              {[100, 200, 500, 1000, 2000].map((n) => (
                <option key={n} value={n}>
                  {n} 只
                </option>
              ))}
            </select>
          </label>
          {field("minAmountYi", "最低成交额（亿）", 0, 10000, 0.5)}
          {field("minPrice", "最低股价（元）", 0, 100000)}
          {field("minReturn", "窗口最低涨幅（%）", 0, 200)}
          {field("maxDrawdown", "窗口最大回撤上限（%）", 0, 80)}
          {field("maxBias", "高于 MA20 幅度上限（%）", 0, 50)}
          <details>
            <summary>平顺度与持续性</summary>
            {field("minFit", "最低拟合度 R²", 0, 1, 0.05)}
            {field("minEfficiency", "最低路径效率（%）", 0, 100, 5)}
            {field("minAbove", "最低站稳 MA60 比例（%）", 0, 100, 5)}
          </details>
          <button
            className="primary"
            disabled={!market?.isEodReady}
            onClick={() => {
              setSelected(null);
              setPage(1);
              action("start", config);
            }}
          >
            开始历史筛选
          </button>
          <button onClick={() => setConfig(trendDefaults)}>
            恢复趋势默认值
          </button>
        </fieldset>
        <p className="hint">
          固定结构：收盘 &gt; MA20 &gt; MA60 &gt; MA120，MA20 与 MA60 上行。排除
          ST / 无成交；至少需要 120 根有效日线。
        </p>
        <button disabled={locked} onClick={onRefresh}>
          刷新市场行情
        </button>
        <p className="hint">
          使用最近完成日快照，按成交额取前 N
          只；不是全市场排名。日线优先复用该完成日的合格缓存。
        </p>
      </aside>
      <section className="trend-results">
        <TrendArchivePanel />
        <div className="split">
          <div>
            <h2>历史趋势名单</h2>
            <p className="hint">
              {job
                ? `截至 ${job.date} · ${job.config.lookback} 根窗口 · ${statusNames[job.status] || job.status}`
                : "等待首次筛选"}
            </p>
          </div>
          <div className="daily-buttons">
            <button
              disabled={active || !job?.matched}
              onClick={() => exportResults("csv")}
            >
              导出符合名单
            </button>
            <button
              disabled={active || !job}
              onClick={() => exportResults("json")}
            >
              导出完整趋势结果
            </button>
          </div>
        </div>
        {(error || pollError) && (
          <div className="notice error" role="alert">
            {error || pollError}
            <button onClick={() => setError("")}>关闭</button>
          </div>
        )}
        {changed && (
          <div className="notice">
            当前参数与结果不同，名单仍使用上次任务条件。
            <button disabled={locked} onClick={() => setConfig(job.config)}>
              加载本次结果条件
            </button>
          </div>
        )}
        {job ? (
          <>
            <div className="trend-status" role="status">
              <p>
                行情覆盖 {job.marketCount} → 基础池 {job.baseCount} → 已处理{" "}
                {job.done}/{job.target} → 符合 {job.matched}
              </p>
              <p className="hint">
                上限外 {job.notScanned} · 未通过 {job.unmatched} · 失败{" "}
                {job.failed} · 待处理 {job.pending} · 缓存 {job.cacheHits}
              </p>
              <progress value={job.done} max={job.target || 1} />
              {job.current && (
                <p>
                  正在处理：{job.current.name}
                  {job.waiting ? " · 等待数据源冷却 / 重试" : ""}
                </p>
              )}
              {job.fatal && <p className="error">{job.fatal}</p>}
              {job.priorityNotice && (
                <p className="notice">{job.priorityNotice}</p>
              )}
              {!active && job.priorityYield?.autoResume && (
                <button onClick={() => action("stop")}>
                  取消自动续跑，保留趋势进度
                </button>
              )}
              <div className="trend-actions">
                {active ? (
                  <button onClick={() => action("stop")}>停止趋势筛选</button>
                ) : (
                  <>
                    <button
                      disabled={busy || !job.pending}
                      onClick={() => action("resume")}
                    >
                      继续剩余
                    </button>
                    <button
                      disabled={busy || !job.failed}
                      onClick={() => action("retry")}
                    >
                      重试失败
                    </button>
                  </>
                )}
              </div>
            </div>
            <details className="trend-method">
              <summary>本次筛选条件与评分口径</summary>
              <p>
                窗口涨幅 ≥{job.config.minReturn}%，最大收盘回撤 ≤
                {job.config.maxDrawdown}%，R² ≥{job.config.minFit}
                且斜率向上，路径效率 ≥{job.config.minEfficiency}
                %，近60根站上MA60 ≥{job.config.minAbove}%，MA20偏离 ≤
                {job.config.maxBias}%。
              </p>
              <p>
                R²为对数收盘价按有效日线序号的线性拟合度。评分 0–100：R²×35 +
                正向路径效率×25 + max(0,1−最大回撤/30%)×25 +
                站稳率×15。路径效率=窗口净涨额/每日涨跌绝对额之和。最高100分不代表必涨；窗口涨幅是历史变化，不是模拟收益。
              </p>
              <p>
                窗口 {job.config.lookback} 根含首尾，共{" "}
                {job.config.lookback - 1}{" "}
                个价格变化间隔。回撤按窗口内历史收盘高点计算；不含基本面、行业相对强弱或收益验证。图表展示最近80根。
              </p>
              <p>
                快照取得于 {time(job.snapshotFetchedAt)}；任务开始于{" "}
                {time(job.startedAt)}。
              </p>
            </details>
            <div className="trend-views" role="group" aria-label="趋势结果类型">
              {[
                ["matched", `符合趋势 ${job.matched}`],
                ["unmatched", "未通过 " + job.unmatched],
                ["failed", "失败 " + job.failed],
                ["pending", "待处理 " + job.pending],
              ].map(([key, label]) => (
                <button
                  key={key}
                  aria-pressed={view === key}
                  className={view === key ? "selected" : ""}
                  onClick={() => {
                    setView(key);
                    setSelected(null);
                    setPage(1);
                  }}
                >
                  {label}
                </button>
              ))}
            </div>
            <div className="trend-search">
              <input
                aria-label="搜索趋势股票"
                maxLength={80}
                placeholder="搜索名称或代码"
                value={search}
                onChange={(e) => {
                  setSearch(e.target.value);
                  setPage(1);
                }}
              />
              <label>
                排序
                <select
                  value={sort}
                  disabled={view === "failed" || view === "pending"}
                  onChange={(e) => {
                    setSort(e.target.value);
                    setPage(1);
                  }}
                >
                  <option value="score">趋势评分</option>
                  <option value="windowReturn">窗口涨幅</option>
                  <option value="maxDrawdown">回撤小到大</option>
                </select>
              </label>
            </div>
            {rows.length && (view === "failed" || view === "pending") ? (
              <div>
                {rows.map((s) => (
                  <div className="trend-error" key={s.symbol}>
                    <p>
                      {s.name} {s.code || s.symbol.slice(2)}：
                      {view === "failed" ? s.message : "尚未处理完成"}
                    </p>
                    {view === "failed" && (
                      <button
                        disabled={locked || /历史.*不足/.test(s.message || "")}
                        onClick={() => action("retry", { symbols: [s.symbol] })}
                      >
                        重试 {s.name}
                      </button>
                    )}
                  </div>
                ))}
                {view === "failed" && (
                  <p className="hint">
                    历史不足不适合反复重试。临时网络错误等待冷却后再试。
                  </p>
                )}
              </div>
            ) : rows.length ? (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      {["股票", "趋势评分", "窗口涨幅", "最大回撤", "自选"].map(
                        (t) => (
                          <th key={t}>{t}</th>
                        ),
                      )}
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((s) => (
                      <tr
                        key={s.symbol}
                        className={
                          s.symbol === stock?.symbol ? "trend-selected" : ""
                        }
                      >
                        <td>
                          <button
                            className="stock-link"
                            onClick={() => setSelected(s.symbol)}
                          >
                            {s.name}
                          </button>
                          <small>
                            {s.code}
                            {view === "unmatched"
                              ? ` · 未过${s.checks.filter((c) => !c.pass).length}项`
                              : ""}
                          </small>
                        </td>
                        <td>{fmt(s.metrics.score, 1)}</td>
                        <td
                          className={
                            s.metrics.windowReturn >= 0 ? "up" : "down"
                          }
                        >
                          {pct(s.metrics.windowReturn)}
                        </td>
                        <td>{fmt(s.metrics.maxDrawdown)}%</td>
                        <td>
                          <button
                            aria-label={
                              (watch.some((w) => w.symbol === s.symbol)
                                ? "取消自选 "
                                : "加入自选 ") + s.name
                            }
                            onClick={() => toggle(s)}
                          >
                            {watch.some((w) => w.symbol === s.symbol)
                              ? "已自选"
                              : "自选"}
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : result.data ? (
              <div className="empty">
                {active
                  ? "正在读取历史，请稍候…"
                  : search
                    ? "没有匹配的股票"
                    : view === "matched"
                      ? "当前没有通过全部趋势条件的股票"
                      : "当前没有该分类的记录"}
                <small>数据失败单独显示，不当作未通过。</small>
              </div>
            ) : null}
            <PageNav result={result} onPage={setPage} />
          </>
        ) : (
          <div className="empty">
            选择条件后点击「开始历史筛选」
            <small>将用真实前复权日线计算趋势，不自动加入原模拟计划。</small>
          </div>
        )}
      </section>
      <Details
        key={job?.id + ":" + (stock?.symbol || "")}
        stock={stock}
        asOf={job?.date}
        watch={watch.some((w) => w.symbol === stock?.symbol)}
        toggle={toggle}
        historyPath="trend/history"
      />
    </main>
  );
}
