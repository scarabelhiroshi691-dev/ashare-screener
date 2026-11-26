import React, { useEffect, useRef, useState } from "react";
import { api, fmt, pct, time } from "./api";
import { pollingDelay } from "./paged-view";
import { dpoDefaults } from "../shared/dpo-rules";

const stages = {
  none: "无观察信号",
  cross: "金叉观察",
  watch: "等待回踩",
  retest: "回踩待确认",
  entry: "入场确认",
};
function DpoChart({ detail }) {
  const rows = detail?.chart;
  if (!rows?.length) return null;
  const values = rows
      .flatMap((p) => [p.dpo, p.average])
      .filter(Number.isFinite),
    lo = Math.min(...values),
    hi = Math.max(...values),
    range = hi - lo || 1;
  const x = (i) => 45 + (i * 690) / (rows.length - 1 || 1),
    y = (v) => 185 - ((v - lo) * 155) / range;
  return (
    <figure className="dpo-chart">
      <figcaption>
        {detail.stock.name} {detail.stock.code} · 最近 {rows.length} 根日线 ·
        蓝线 DPO / 黄线 MADPO
      </figcaption>
      <svg
        viewBox="0 0 760 225"
        role="img"
        aria-label="DPO与MADPO历史曲线，圆点为入场确认"
      >
        <text x="0" y="30" fontSize="12">
          {fmt(hi)}
        </text>
        <text x="0" y="185" fontSize="12">
          {fmt(lo)}
        </text>
        {["dpo", "average"].map((key, i) => (
          <polyline
            key={key}
            fill="none"
            stroke={i ? "#976b00" : "#285bd2"}
            strokeWidth="2"
            points={rows.map((p, j) => `${x(j)},${y(p[key])}`).join(" ")}
          />
        ))}
        {rows.map((p, i) =>
          p.signal ? (
            <circle key={p.date} cx={x(i)} cy={y(p.dpo)} r="4" fill="#b32f2f">
              <title>{p.date} 入场确认；下一有效日线才模拟入场</title>
            </circle>
          ) : null,
        )}
        <text x="45" y="215" fontSize="12">
          {rows[0].date}
        </text>
        <text x="735" y="215" textAnchor="end" fontSize="12">
          {rows.at(-1).date}
        </text>
      </svg>
      <p className="hint">
        {detail.source} · 获取 {time(detail.fetchedAt)}
        ；图上信号不代表当日可按收盘价成交。
      </p>
    </figure>
  );
}
export default function DpoPanel({ busy, market, onRefresh }) {
  const chartRef = useRef(null);
  const [state, setState] = useState({ job: null, active: false }),
    [config, setConfig] = useState({ ...dpoDefaults }),
    [error, setError] = useState(""),
    [view, setView] = useState("stocks"),
    [page, setPage] = useState(1),
    [data, setData] = useState(null),
    [detail, setDetail] = useState(null),
    [symbol, setSymbol] = useState(""),
    [requesting, setRequesting] = useState(false);
  useEffect(() => {
    if (detail) {
      chartRef.current?.scrollIntoView({ block: "start" });
      chartRef.current?.focus({ preventScroll: true });
    }
  }, [detail]);
  const job = state.job,
    active = state.active;
  useEffect(() => {
    let live = true,
      timer,
      controller;
    async function load() {
      clearTimeout(timer);
      controller?.abort();
      controller = new AbortController();
      const c = controller;
      try {
        const s = await api("dpo", undefined, { signal: c.signal });
        if (live) {
          setState(s);
          timer = setTimeout(load, pollingDelay(document.hidden, s.active));
        }
      } catch (e) {
        if (live && !c.signal.aborted) {
          setError(e.message);
          timer = setTimeout(load, 15000);
        }
      }
    }
    load();
    document.addEventListener("visibilitychange", load);
    return () => {
      live = false;
      clearTimeout(timer);
      controller?.abort();
      document.removeEventListener("visibilitychange", load);
    };
  }, []);
  useEffect(() => {
    setPage(1);
    setSymbol("");
    setDetail(null);
  }, [job?.id, view]);
  useEffect(() => {
    let live = true;
    setData(null);
    if (job)
      api(`dpo/rows?view=${view}&page=${page}`)
        .then((r) => {
          if (live && r.jobId === job.id) setData(r);
        })
        .catch((e) => {
          if (live) setError(e.message);
        });
    return () => {
      live = false;
    };
  }, [job?.id, job?.done, job?.status, view, page]);
  useEffect(() => {
    let live = true;
    setDetail(null);
    if (symbol)
      api("dpo/detail?symbol=" + encodeURIComponent(symbol))
        .then((d) => {
          if (live) setDetail(d);
        })
        .catch((e) => {
          if (live) setError(e.message);
        });
    return () => {
      live = false;
    };
  }, [symbol, job?.id]);
  async function action(kind) {
    setError("");
    setRequesting(true);
    try {
      setState(await api("dpo/" + kind, kind === "start" ? config : {}));
    } catch (e) {
      setError(e.message);
    } finally {
      setRequesting(false);
    }
  }
  function field(label, key, min, max, step = 1) {
    return (
      <label className="field" key={key}>
        {label}
        <input
          type="number"
          min={min}
          max={max}
          step={step}
          disabled={active || requesting}
          value={config[key]}
          onChange={(e) => setConfig((c) => ({ ...c, [key]: e.target.value }))}
        />
      </label>
    );
  }
  const s = job?.summary,
    locked = busy || active || requesting;
  return (
    <section className="research-panel dpo-panel">
      {error && (
        <p className="notice error" role="alert">
          {error}
        </p>
      )}
      <div className="research-layout">
        <aside className="research-controls">
          <h2>DPO 独立策略</h2>
          <p>金叉后观察，回踩确认后入场。独立回测，不启用每日模拟。</p>
          {field("研究数量上限", "maxStocks", 1, 200)}
          {field("信号窗口（有效日线）", "window", 30, 120)}
          <details>
            <summary>指标与交易参数</summary>
            {field("均线周期 N", "period", 5, 40)}
            {field("均线滞后 L", "shift", 1, 20)}
            {field("DPO平滑 M", "smooth", 2, 12)}
            {field("金叉前在黄线下的连续根数", "belowBars", 1, 10)}
            {field("金叉后的观察根数", "watchBars", 2, 30)}
            {field("回踩容差（占收盘价%）", "tolerancePct", 0, 2, 0.1)}
            {field("收盘止损阈值%", "stopLossPct", 1, 30, 0.5)}
            {field("最多持有根数", "maxHold", 2, 40)}
            {field("单边综合成本（bp）", "costBps", 0, 100)}
            {field("单边滑点（bp）", "slippageBps", 0, 100)}
          </details>
          <button
            className="primary"
            disabled={locked || !market?.isEodReady}
            onClick={() => action("start")}
          >
            开始独立筛选与回测
          </button>
          <button disabled={locked} onClick={onRefresh}>
            刷新完成行情
          </button>
          {active ? (
            <button disabled={requesting} onClick={() => action("stop")}>
              停止 DPO 任务
            </button>
          ) : (
            <>
              {!!job?.pending && (
                <button disabled={locked} onClick={() => action("resume")}>
                  继续未完成 {job.pending} 只
                </button>
              )}
              {!!job?.failed && (
                <button disabled={locked} onClick={() => action("retry")}>
                  重试失败 {job.failed} 只
                </button>
              )}
            </>
          )}
          <p className="hint">
            当前行情 {market?.date || "尚未取得"}
            。取合格池成交额靠前的样本，不按 DPO
            是否命中挑样本。新任务会替换本页上次结果，请先导出需要保留的结果。
          </p>
        </aside>
        <div className="research-results">
          <div className="research-card methodology">
            <h3>本版规则与限制</h3>
            <p>
              DPO＝收盘价－L 根前的 MA(N)，黄线＝DPO 的
              MA(M)，不居中。金叉后，在观察期内两线差收窄至容差内且不跌破，后续蓝线与差值一起上升才确认入场。
            </p>
            <p>
              收盘确认，下一有效日线开盘成交；同股不重叠、T+1。蓝线下降、跌破黄线、收盘止损或持有上限触发后下一开盘退出。一字行情跳过入场或延后退出。
            </p>
            <p>
              当前样本回看有选择及幸存者偏差，前复权历史并非逐日存档。未完整模拟涨跌停、流动性及资金占用。下列收益是已完成信号的含费用统计，不是账户收益。
            </p>
          </div>
          {!job ? (
            <div className="empty">
              尚无 DPO 结果。取得完成行情后，点击左侧开始；运行进度会逐股保存。
            </div>
          ) : (
            <>
              <div className="research-card">
                <div className="split">
                  <h3>DPO 回测结果</h3>
                  <a href="/api/dpo/export" download="dpo-research.json">
                    导出完整结果与规则
                  </a>
                </div>
                <p role="status">
                  {{
                    running: "运行中",
                    paused: "已暂停",
                    stopped: "已停止",
                    completed: "已完成",
                    partial: "部分失败",
                  }[job.status] || job.status}{" "}
                  · 截至 {job.date} · 已处理 {job.done}/{job.target} · 有效{" "}
                  {s?.stocks || 0} · 失败 {job.failed} · 未处理 {job.pending}
                </p>
                <p className="hint">
                  缓存 {job.cacheHits} 只 · 当前 {job.current?.name || "无"}
                  {job.waiting ? " · 正在按数据源要求等待" : ""}。基础合格{" "}
                  {job.baseCount}/{job.marketCount}，本次未扫描 {job.notScanned}
                  。
                </p>
                {job.fatal && (
                  <p className="notice error" role="alert">
                    {job.fatal}
                  </p>
                )}
                <p>
                  本结果参数：DPO（{job.config.period}，{job.config.shift}，
                  {job.config.smooth}），窗口 {job.config.window} 根；回踩容差{" "}
                  {job.config.tolerancePct}%，观察 {job.config.watchBars}{" "}
                  根；每边成本 {job.config.costBps}bp＋滑点{" "}
                  {job.config.slippageBps}bp。
                </p>
                <div className="table-scroll">
                  <table>
                    <thead>
                      <tr>
                        <th>完成交易</th>
                        <th>平均净收益</th>
                        <th>中位数</th>
                        <th>盈利比例</th>
                        <th>最差 / 最好</th>
                        <th>单笔最大路径回撤</th>
                      </tr>
                    </thead>
                    <tbody>
                      <tr>
                        <td>{s?.count || 0}</td>
                        <td>{pct(s?.average)}</td>
                        <td>{pct(s?.median)}</td>
                        <td>
                          {s?.winRate == null ? "—" : fmt(s.winRate) + "%"}
                        </td>
                        <td>
                          {pct(s?.worst)} / {pct(s?.best)}
                        </td>
                        <td>
                          {s?.worstTradeDrawdown == null
                            ? "—"
                            : fmt(s.worstTradeDrawdown) + "%"}
                        </td>
                      </tr>
                    </tbody>
                  </table>
                </div>
                <p className="hint">
                  未退出 {s?.pending || 0} 条，跳过入场 {s?.skipped || 0}{" "}
                  次，有效但无已完成交易 {s?.noTrades || 0}{" "}
                  只。路径回撤按单笔持有期间收盘标记及退出开盘计算，非组合回撤，也不含盘中极值。
                </p>
                {!!s?.months?.length && (
                  <div className="table-scroll">
                    <table>
                      <caption>按入场月份拆分的已完成交易</caption>
                      <thead>
                        <tr>
                          <th>月份</th>
                          <th>交易数</th>
                          <th>平均净收益</th>
                        </tr>
                      </thead>
                      <tbody>
                        {s.months.map((m) => (
                          <tr key={m.month}>
                            <td>{m.month}</td>
                            <td>{m.count}</td>
                            <td>{pct(m.average)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
              <div className="research-card">
                <div className="segmented">
                  {[
                    ["stocks", "当前观察与信号"],
                    ["trades", "已完成交易"],
                    ["pending", "未退出"],
                    ["errors", "数据失败"],
                  ].map(([v, label]) => (
                    <button
                      key={v}
                      className={view === v ? "active" : ""}
                      aria-pressed={view === v}
                      onClick={() => {
                        setView(v);
                        setPage(1);
                      }}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                {!data ? (
                  <p>读取结果…</p>
                ) : !data.total ? (
                  <p className="empty">
                    此列表暂无记录；不代表其他列表也为空。
                  </p>
                ) : (
                  <>
                    <div className="table-scroll">
                      <table>
                        <thead>
                          <tr>
                            <th>股票</th>
                            {view === "stocks" ? (
                              <>
                                <th>状态</th>
                                <th>DPO / MADPO</th>
                                <th>金叉日</th>
                                <th>完成交易</th>
                              </>
                            ) : view === "trades" ? (
                              <>
                                <th>信号 / 入场 / 退出</th>
                                <th>净收益</th>
                                <th>持有根数</th>
                                <th>退出原因</th>
                              </>
                            ) : view === "pending" ? (
                              <>
                                <th>信号日</th>
                                <th>入场日</th>
                                <th>状态</th>
                              </>
                            ) : (
                              <th>原因</th>
                            )}
                          </tr>
                        </thead>
                        <tbody>
                          {data.rows.map((r, i) => (
                            <tr key={r.symbol + ":" + i}>
                              <td>
                                <button
                                  onClick={() => setSymbol(r.symbol)}
                                  aria-pressed={symbol === r.symbol}
                                  disabled={view === "errors"}
                                >
                                  {r.name} {r.code || r.symbol}
                                </button>
                              </td>
                              {view === "stocks" ? (
                                <>
                                  <td>{stages[r.stage]}</td>
                                  <td>
                                    {fmt(r.dpo)} / {fmt(r.average)}
                                  </td>
                                  <td>{r.crossDate || "—"}</td>
                                  <td>{r.trades}</td>
                                </>
                              ) : view === "trades" ? (
                                <>
                                  <td>
                                    {r.signalDate} / {r.entryDate} /{" "}
                                    {r.exitDate}
                                  </td>
                                  <td>{pct(r.net)}</td>
                                  <td>{r.holdBars}</td>
                                  <td>
                                    {r.reason}
                                    {r.delayed
                                      ? " · 延后" + r.delayed + "根"
                                      : ""}
                                  </td>
                                </>
                              ) : view === "pending" ? (
                                <>
                                  <td>{r.signalDate}</td>
                                  <td>{r.entryDate || "—"}</td>
                                  <td>{r.state}</td>
                                </>
                              ) : (
                                <td>{r.message}</td>
                              )}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    <div className="split">
                      <button
                        disabled={page <= 1}
                        onClick={() => setPage((p) => p - 1)}
                      >
                        上一页
                      </button>
                      <span>
                        第 {page}/{data.pages} 页，共 {data.total} 条
                      </span>
                      <button
                        disabled={page >= data.pages}
                        onClick={() => setPage((p) => p + 1)}
                      >
                        下一页
                      </button>
                    </div>
                  </>
                )}
                <p className="hint">
                  点击股票名称查看 DPO 曲线；表格较宽时可左右滑动。
                </p>
                <div ref={chartRef} tabIndex={-1}>
                  {symbol && !detail && <p role="status">正在读取股票曲线…</p>}
                  <DpoChart detail={detail} />
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </section>
  );
}
