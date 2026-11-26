import React, { useEffect, useRef, useState } from "react";
import { defaults, baseReason, validateConfig } from "../shared/rules";
import { chinaClock, isFreshQuote, alertMatches } from "../shared/time";
import { api, fmt, pct, time, download } from "./api";
import Filters from "./Filters";
import Details from "./Details";
import ResearchPanel from "./ResearchPanel";
import DailyPanel from "./DailyPanel";
import TrendPanel from "./TrendPanel";
import DpoPanel from "./DpoPanel";
import { pollingDelay } from "./paged-view";
import SettingsPanel from "./SettingsPanel";
import { usePreferences } from "./use-preferences";

function saved(key, fallback) {
  try {
    return JSON.parse(localStorage.getItem(key)) ?? fallback;
  } catch {
    return fallback;
  }
}
export default function App() {
  const preferences = usePreferences();
  const watch = preferences.data.watch;
  const [showNear, setShowNear] = useState(false);
  const [tab, setTab] = useState("screen"),
    [config, setConfig] = useState(() => {
      try {
        return validateConfig(saved("a-config", defaults));
      } catch {
        return defaults;
      }
    }),
    [state, setState] = useState(null),
    [market, setMarket] = useState([]),
    [selected, setSelected] = useState(null),
    [search, setSearch] = useState(""),
    [error, setError] = useState(""),
    [preferenceError, setPreferenceError] = useState(""),
    [quotes, setQuotes] = useState({}),
    [auto, setAuto] = useState(false),
    [refreshing, setRefreshing] = useState(false),
    [threshold, setThreshold] = useState(3),
    [alerts, setAlerts] = useState([]),
    [quoteInfo, setQuoteInfo] = useState(null),
    [sort, setSort] = useState("amount");
  const marketVersion = useRef(""),
    syncGeneration = useRef(0),
    activeTab = useRef(tab),
    loaded = useRef(false),
    requestBusy = useRef(false),
    triggered = useRef(new Set());
  activeTab.current = tab;
  const busy =
    state?.dpoActive ||
    state?.trendActive ||
    state?.dailyActive ||
    state?.researchActive ||
    state?.refresh.running ||
    ["running", "stopping"].includes(state?.job?.status);
  useEffect(() => {
    localStorage.setItem("a-config", JSON.stringify(config));
  }, [config]);
  async function sync(signal) {
    const generation = ++syncGeneration.current;
    const options = { signal };
    const s = await api(
      activeTab.current === "screen" ? "state" : "state?summary=1",
      undefined,
      options,
    );
    const current = () =>
      generation === syncGeneration.current && !signal?.aborted;
    if (!current()) return null;
    if (marketVersion.current !== s.market?.fetchedAt) {
      const m = await api("market", undefined, options);
      if (!current()) return null;
      if (m.meta?.fetchedAt !== s.market?.fetchedAt) return null;
      setMarket(m.stocks);
      marketVersion.current = s.market?.fetchedAt;
    }
    setState(s);
    return s;
  }
  useEffect(() => {
    let live = true,
      timer,
      controller;
    async function poll() {
      clearTimeout(timer);
      controller?.abort();
      const request = new AbortController();
      controller = request;
      let running = false;
      try {
        const s = await sync(request.signal);
        running = Boolean(
          s &&
          (s.refresh.running ||
            s.dailyActive ||
            s.trendActive ||
            s.researchActive ||
            s.dpoActive ||
            ["running", "stopping"].includes(s.job?.status)),
        );
        if (s && !loaded.current) {
          loaded.current = true;
          if (!s.market && !s.refresh.running) await api("market/refresh", {});
        }
      } catch (e) {
        if (live && !request.signal.aborted) setError(e.message);
      } finally {
        if (live && !request.signal.aborted)
          timer = setTimeout(poll, pollingDelay(document.hidden, running));
      }
    }
    poll();
    document.addEventListener("visibilitychange", poll);
    return () => {
      live = false;
      syncGeneration.current++;
      controller?.abort();
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", poll);
    };
  }, [tab]);
  async function toggle(s) {
    setPreferenceError("");
    try {
      await preferences.edit((data) => ({
        ...data,
        watch: data.watch.some((x) => x.symbol === s.symbol)
          ? data.watch.filter((x) => x.symbol !== s.symbol)
          : [...data.watch, { symbol: s.symbol, code: s.code, name: s.name }],
      }));
    } catch (e) {
      setPreferenceError(e.message);
    }
  }
  const job = Array.isArray(state?.job?.results) ? state.job : null;
  let basic = [];
  try {
    const c = validateConfig(config);
    basic = market
      .filter((s) => !baseReason(s, c, state?.market?.date))
      .sort((a, b) => b.amount - a.amount)
      .slice(0, c.maxScan);
  } catch {}
  const candidates = job?.results || basic;
  const watched = watch.map(
    (w) =>
      quotes[w.symbol] ||
      market.find((s) => s.symbol === w.symbol) || {
        ...w,
        price: null,
        changePct: null,
        amount: null,
      },
  );
  const pool =
    tab === "screen"
      ? showNear
        ? job?.nearMiss || []
        : candidates
      : tab === "watch"
        ? watched
        : [
            ...new Map(
              [
                ...watched,
                ...candidates.map((s) => ({ ...s, ...quotes[s.symbol] })),
              ].map((s) => [s.symbol, s]),
            ).values(),
          ].slice(0, 200);
  const rows = pool
    .filter(
      (s) => !search || s.name.includes(search) || s.code.includes(search),
    )
    .sort((a, b) => (b[sort] ?? -Infinity) - (a[sort] ?? -Infinity));
  const stock = pool.find((s) => s.symbol === selected) || rows[0];
  let changed = false;
  try {
    changed =
      job &&
      JSON.stringify(validateConfig(config)) !== JSON.stringify(job.config);
  } catch {
    changed = Boolean(job);
  }
  async function action(path, body = {}) {
    setError("");
    try {
      await api(path, body);
      await sync();
    } catch (e) {
      setError(e.message);
    }
  }
  async function refreshQuotes() {
    if (requestBusy.current) return;
    const symbols = pool.map((s) => s.symbol).slice(0, 200);
    if (!symbols.length) return;
    requestBusy.current = true;
    setRefreshing(true);
    try {
      const r = await api("quotes", { symbols });
      setQuotes((prev) => ({
        ...prev,
        ...Object.fromEntries(r.stocks.map((s) => [s.symbol, s])),
      }));
      setQuoteInfo(r);
      const newAlerts = [];
      for (const s of r.stocks) {
        const key = s.symbol + ":" + s.quoteDate;
        if (alertMatches(s, threshold)) {
          if (!triggered.current.has(key))
            newAlerts.push({ ...s, at: new Date().toISOString() });
          triggered.current.add(key);
        } else if (isFreshQuote(s)) triggered.current.delete(key);
      }
      if (newAlerts.length) setAlerts((a) => [...newAlerts, ...a].slice(0, 20));
      setError("");
    } catch (e) {
      setError(e.message);
    } finally {
      requestBusy.current = false;
      setRefreshing(false);
    }
  }
  const quoteFn = useRef(refreshQuotes);
  quoteFn.current = refreshQuotes;
  useEffect(() => {
    if (!auto || tab !== "observe") return;
    const id = setInterval(() => {
      if (!document.hidden) quoteFn.current();
    }, 60000);
    return () => clearInterval(id);
  }, [auto, tab]);
  return (
    <>
      <header>
        <strong>A股选股台</strong>
        <nav>
          {[
            ["screen", "盘后选股"],
            ["observe", "盘中观察"],
            ["watch", "自选股"],
            ["research", "复盘研究"],
            ["trend", "历史趋势"],
            ["dpo", "DPO策略"],
            ["daily", "模拟跟踪"],
            ["settings", "本机备份"],
          ].map(([key, title]) => (
            <button
              className={tab === key ? "selected" : ""}
              onClick={() => {
                setTab(key);
                setSearch("");
              }}
              key={key}
            >
              {title}
              {key === "watch" && watch.length > 0 && (
                <small> {watch.length}</small>
              )}
            </button>
          ))}
        </nav>
        <span className="local">本机运行 · 免费数据</span>
      </header>
      <div className="heading">
        <div>
          <h1>
            {tab === "screen"
              ? "盘后选股"
              : tab === "dpo"
                ? "DPO 独立研究"
                : tab === "observe"
                  ? "盘中观察"
                  : tab === "trend"
                    ? "历史趋势选股"
                    : tab === "research"
                      ? "复盘研究"
                      : tab === "daily"
                        ? "每日复盘与模拟跟踪"
                        : tab === "settings"
                          ? "本机备份与恢复"
                          : "我的自选"}
          </h1>
          <p>
            {tab === "screen"
              ? "按规则筛选，每个结果都能解释。"
              : tab === "dpo"
                ? "观察金叉与回踩，先用历史样本验证。"
                : tab === "observe"
                  ? "观察候选与自选，关注条件变化。"
                  : tab === "trend"
                    ? "从历史路径寻找持续上行、回撤较小的股票。"
                    : tab === "research"
                      ? "从条件到结果，让每次筛选留下证据。"
                      : tab === "daily"
                        ? "固定条件，登记信号，用后续新数据验证。"
                        : tab === "settings"
                          ? "管理此浏览器的自选股和命名策略。"
                          : "把值得继续研究的股票留在这里。"}
          </p>
        </div>
        <div className="actions">
          {tab === "screen" ? (
            <>
              <button disabled={busy} onClick={() => action("market/refresh")}>
                刷新行情
              </button>
              <button
                className="primary"
                disabled={busy || !state?.market?.isEodReady}
                onClick={() => action("scan", config)}
              >
                开始筛选
              </button>
            </>
          ) : ["research", "daily", "trend", "dpo", "settings"].includes(
              tab,
            ) ? null : (
            <button
              className="primary"
              disabled={refreshing || !pool.length}
              onClick={refreshQuotes}
            >
              {refreshing ? "刷新中…" : "刷新报价"}
            </button>
          )}
        </div>
      </div>
      {error && (
        <div className="notice error" role="alert">
          {error}
          <button onClick={() => setError("")}>关闭</button>
        </div>
      )}
      {state?.resourceError && (
        <div className="notice error">{state.resourceError}</div>
      )}
      {state?.refresh.error && (
        <div className="notice error">
          {state.refresh.error} 已保留上次成功数据。
        </div>
      )}
      {state?.refresh.running && (
        <div className="progress">
          <span>
            正在读取沪深行情 · {state.refresh.done} /{" "}
            {state.refresh.total || "…"}
          </span>
          <progress value={state.refresh.done} max={state.refresh.total || 1} />
          <button onClick={() => action("market/stop")}>停止刷新</button>
        </div>
      )}
      {tab === "observe" && (
        <div className="observation">
          <label className="check">
            <input
              type="checkbox"
              checked={auto}
              onChange={(e) => setAuto(e.target.checked)}
            />
            每 60 秒自动刷新
          </label>
          <label>
            提醒：涨跌幅 ≥{" "}
            <input
              aria-label="提醒涨跌幅阈值"
              type="number"
              min="-30"
              max="30"
              value={threshold}
              onChange={(e) => {
                setThreshold(e.target.value);
                triggered.current.clear();
              }}
            />{" "}
            %
          </label>
          <span>
            {chinaClock().tradingWindow
              ? "处于常规交易时段，仍以报价时间为准"
              : "常规交易时段之外"}{" "}
            · 最多观察 200 只
          </span>
          <small>
            页面关闭、后台隐藏或离开本页时暂停自动刷新；提醒仅在本页显示。时段判断未接节假日历。
          </small>
          {quoteInfo && (
            <small>
              获取时间 {time(quoteInfo.fetchedAt)}
              {quoteInfo.fromCache ? " · 60 秒内缓存" : ""}
              {quoteInfo.missing.length
                ? ` · ${quoteInfo.missing.length} 只报价缺失`
                : ""}
            </small>
          )}
          {alerts.map((a) => (
            <div className="alert-row" key={a.symbol + a.at}>
              {a.name} {pct(a.changePct)} · 条件已触发 · {time(a.at)}
            </div>
          ))}
        </div>
      )}
      {tab !== "settings" && (preferenceError || preferences.error) && (
        <p className="notice error" role="alert">
          {preferenceError || preferences.error}
        </p>
      )}
      {tab === "settings" ? (
        <SettingsPanel preferences={preferences} />
      ) : tab === "dpo" ? (
        <DpoPanel
          busy={busy}
          market={state?.market}
          onRefresh={() => action("market/refresh")}
        />
      ) : tab === "research" ? (
        <ResearchPanel busy={busy} />
      ) : tab === "daily" ? (
        <DailyPanel busy={busy} />
      ) : tab === "trend" ? (
        <TrendPanel
          busy={busy}
          market={state?.market}
          watch={watch}
          toggle={toggle}
          onRefresh={() => action("market/refresh")}
        />
      ) : (
        <main>
          {tab === "screen" ? (
            <Filters
              config={config}
              setConfig={setConfig}
              disabled={busy}
              strategies={preferences.data.strategies}
              updateStrategies={(update) =>
                preferences.edit((data) => ({
                  ...data,
                  strategies: update(data.strategies),
                }))
              }
            />
          ) : (
            <aside className="filters">
              <h2>{tab === "watch" ? "添加自选" : "观察范围"}</h2>
              {tab === "watch" ? (
                <>
                  <p className="hint">输入股票名称或代码，从沪深行情中添加。</p>
                  <input
                    aria-label="添加自选搜索"
                    placeholder="名称 / 股票代码"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                  />
                  {search &&
                    market
                      .filter(
                        (s) =>
                          s.name.includes(search) || s.code.includes(search),
                      )
                      .slice(0, 8)
                      .map((s) => (
                        <button
                          className="search-result"
                          key={s.symbol}
                          onClick={() => {
                            toggle(s);
                            setSearch("");
                          }}
                        >
                          {s.name}
                          <small>
                            {s.code}{" "}
                            {watch.some((w) => w.symbol === s.symbol)
                              ? "★"
                              : "＋"}
                          </small>
                        </button>
                      ))}
                </>
              ) : (
                <>
                  <p>自选股与本次筛选候选</p>
                  <p className="hint">
                    只有来源时间在 150
                    秒内的盘中报价才会触发提醒。免费报价可能延迟。
                  </p>
                  <p className="hint">提醒不会自动执行交易。</p>
                </>
              )}
            </aside>
          )}
          <section className="results">
            <div className="results-title">
              <div>
                <h2>
                  {tab === "screen"
                    ? "候选名单"
                    : tab === "watch"
                      ? "自选名单"
                      : "观察名单"}
                </h2>
                <p>
                  {tab === "screen"
                    ? job
                      ? `${job.date} · ${job.config.strategy === "swing" ? "波段" : "短线"} · ${{ completed: "筛选完成", partial: "扫描结束，仍有失败", paused: "已暂停，可继续", running: "正在筛选", stopping: "正在停止", failed: "筛选中断", stopped: "已停止，可继续" }[job.status] || job.status}${changed ? " · 条件已修改，需重新筛选" : ""}`
                      : "基础候选 · 尚未计算历史指标"
                    : `${pool.length} 只股票 · 报价以来源时间为准`}
                </p>
              </div>
              <button
                disabled={!rows.length || (tab === "screen" && showNear)}
                onClick={() => download(rows)}
              >
                导出名单
              </button>
            </div>
            {tab === "screen" && job && (
              <div className="scan-status">
                <span>
                  行情覆盖 {job.marketCount} → 基础池 {job.baseCount} → 已处理{" "}
                  {job.done}/{job.target} → 命中 {job.results.length}
                </span>
                <small>
                  上限外 {job.notScanned} · 待计算{" "}
                  {Math.max(0, job.target - job.done)} · 失败 {job.failed} ·
                  不符合 {job.unmatched}
                </small>
                <small>
                  成功计算 {job.results.length + job.unmatched} · 使用缓存{" "}
                  {job.cacheHits} · 自动重试 {job.networkRetries || 0} 次
                </small>
                {job.current && (
                  <small>
                    正在处理 {job.current.name}
                    {job.waiting
                      ? ` · 等待至 ${time(new Date(job.waiting.until).toISOString())}${job.waiting.type === "retry" ? " 后自动重试" : ""}`
                      : ""}
                  </small>
                )}
                {busy && (
                  <>
                    <progress value={job.done} max={job.target || 1} />
                    <button onClick={() => action("scan/stop")}>
                      停止筛选
                    </button>
                  </>
                )}
                {!busy &&
                  job.canResume &&
                  (job.failed > 0 || job.pending > 0) && (
                    <div className="recovery-actions">
                      {job.failed > 0 && (
                        <button onClick={() => action("scan/retry")}>
                          重试失败 {job.failed} 只
                        </button>
                      )}
                      {job.pending > 0 && (
                        <button onClick={() => action("scan/resume")}>
                          继续剩余 {job.pending} 只
                        </button>
                      )}
                      <small>
                        沿用本任务的条件与行情日期，已成功的股票不会重算。
                      </small>
                    </div>
                  )}
                {job.fatal && <p className="error">{job.fatal}</p>}
                {job.errors.length > 0 && (
                  <details>
                    <summary>查看未完成的股票与原因</summary>
                    {job.errors.map((e) => (
                      <p key={e.symbol}>
                        {e.name}（{e.symbol.slice(2)}）：{e.message}
                        {e.retryAt && (
                          <small>
                            {" "}
                            可再尝试时间：
                            {time(new Date(e.retryAt).toISOString())}
                          </small>
                        )}
                        {job.canResume && (
                          <button
                            disabled={busy}
                            onClick={() =>
                              action("scan/retry", { symbols: [e.symbol] })
                            }
                          >
                            重试 {e.name}
                          </button>
                        )}
                      </p>
                    ))}
                  </details>
                )}
              </div>
            )}
            {tab === "screen" && job && (
              <div className="evidence-switch">
                <button
                  className={!showNear ? "active" : ""}
                  onClick={() => setShowNear(false)}
                >
                  正式入选 {job.results.length}
                </button>
                <button
                  className={showNear ? "active" : ""}
                  onClick={() => setShowNear(true)}
                >
                  临界观察 {job.nearMiss?.length || 0}
                </button>
                {showNear && (
                  <small>
                    基础筛选已过，仅差一项技术条件；尚未入选。最多显示 20
                    只，按成交额排列。
                  </small>
                )}
              </div>
            )}
            <div className="table-tools">
              <input
                aria-label="搜索名单"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="搜索名称或代码"
              />
              <label>
                排序{" "}
                <select
                  aria-label="排序"
                  value={sort}
                  onChange={(e) => setSort(e.target.value)}
                >
                  <option value="amount">成交额</option>
                  <option value="changePct">涨跌幅</option>
                  <option value="price">价格</option>
                </select>
              </label>
            </div>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>股票</th>
                    <th>最新价</th>
                    <th>涨跌幅</th>
                    <th>成交额</th>
                    <th>{tab === "screen" ? "入选依据" : "报价日期"}</th>
                    <th>自选</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((s) => (
                    <tr
                      key={s.symbol}
                      className={stock?.symbol === s.symbol ? "highlight" : ""}
                      onClick={() => setSelected(s.symbol)}
                    >
                      <td>
                        <button
                          className="stock-link"
                          onClick={() => setSelected(s.symbol)}
                        >
                          {s.name}
                        </button>
                        <small>{s.code}</small>
                      </td>
                      <td>{fmt(s.price)}</td>
                      <td className={s.changePct >= 0 ? "up" : "down"}>
                        {pct(s.changePct)}
                      </td>
                      <td>
                        {s.amount === null || s.amount === undefined
                          ? "—"
                          : fmt(s.amount / 1e8) + "亿"}
                      </td>
                      <td className="basis">
                        {tab === "screen" ? (
                          s.metrics ? (
                            s.checks?.some((c) => !c.pass) ? (
                              "差 1 项技术条件"
                            ) : s.strategy === "swing" ? (
                              "趋势条件命中"
                            ) : (
                              "价量条件命中"
                            )
                          ) : (
                            "待历史筛选"
                          )
                        ) : (
                          <>
                            {s.quoteDate || "无报价"}
                            {chinaClock().tradingWindow && !isFreshQuote(s) && (
                              <small className="error">报价陈旧</small>
                            )}
                          </>
                        )}
                      </td>
                      <td>
                        <button
                          className="star"
                          aria-label={`${watch.some((w) => w.symbol === s.symbol) ? "取消" : "加入"}自选 ${s.name}`}
                          onClick={(e) => {
                            e.stopPropagation();
                            toggle(s);
                          }}
                        >
                          {watch.some((w) => w.symbol === s.symbol) ? "★" : "☆"}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {!rows.length && (
                <div className="empty">
                  {state?.refresh.running
                    ? "正在加载真实行情…"
                    : tab === "watch"
                      ? "自选名单还是空的"
                      : job
                        ? "没有符合条件的结果，可调整条件后重新筛选"
                        : "刷新行情后开始筛选"}
                  <small>未使用演示报价或模拟收益</small>
                </div>
              )}
            </div>
            <footer>
              数据日期 {state?.market?.date || "—"} · 实际覆盖{" "}
              {state?.market?.coverage || 0} 只<br />
              获取于 {time(state?.market?.fetchedAt)}
              {state?.market?.fromCache ? " · 本地缓存" : ""}
            </footer>
          </section>
          <Details
            stock={stock}
            asOf={tab === "screen" && job ? job.date : state?.market?.date}
            watch={watch.some((w) => w.symbol === stock?.symbol)}
            toggle={toggle}
          />
        </main>
      )}
    </>
  );
}
