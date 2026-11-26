import React, { useEffect, useState } from "react";
import Chart from "./Chart";
import ChartObservation from "./ChartObservation";
import { bollingerBands, observeDailyChart } from "./chart-observation";
import { api, fmt, pct, time } from "./api";
export default function Details({
  stock,
  asOf,
  watch,
  toggle,
  historyPath = "history",
}) {
  const [history, setHistory] = useState(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const [showBands, setShowBands] = useState(false);
  const historyKey = [
    historyPath,
    stock?.symbol,
    asOf,
    stock?.historySource,
    stock?.historyFetchedAt,
  ].join("/");
  const current = history?.key === historyKey ? history.data : null;
  const bars = current?.bars ?? [];
  const bands = showBands ? bollingerBands(bars) : [];
  const observation = current ? observeDailyChart(bars, asOf) : null;
  useEffect(() => {
    let alive = true;
    const controller = new AbortController();
    setHistory(null);
    setError("");
    if (!stock || !asOf) return;
    setBusy(true);
    api(`${historyPath}?symbol=${stock.symbol}&asOf=${asOf}`, undefined, {
      timeout: 180000,
      signal: controller.signal,
    })
      .then((h) => {
        if (alive) setHistory({ key: historyKey, data: h });
      })
      .catch((e) => {
        if (alive) setError(e.message);
      })
      .finally(() => {
        if (alive) setBusy(false);
      });
    return () => {
      alive = false;
      controller.abort();
    };
  }, [
    stock?.symbol,
    stock?.historySource,
    stock?.historyFetchedAt,
    asOf,
    historyPath,
    historyKey,
  ]);
  if (!stock)
    return (
      <aside className="details">
        <div className="empty">
          选择一只股票
          <br />
          <small>查看日 K 与入选依据</small>
        </div>
      </aside>
    );
  return (
    <aside className="details">
      <div className="split">
        <div>
          <h2>{stock.name}</h2>
          <span className="muted">{stock.code}</span>
        </div>
        <button
          onClick={() => toggle(stock)}
          aria-label={watch ? "取消自选" : "加入自选"}
        >
          {watch ? "★ 已自选" : "☆ 加入自选"}
        </button>
      </div>
      <div className={"price " + (stock.changePct >= 0 ? "up" : "down")}>
        {fmt(stock.price)} <small>{pct(stock.changePct)}</small>
      </div>
      <div className="section">
        {stock.trend && (
          <div className="trend-facts">
            <h3>历史趋势证据</h3>
            <dl>
              <dt>趋势评分</dt>
              <dd>{fmt(stock.metrics.score, 1)} / 100</dd>
              <dt>上行拟合度</dt>
              <dd>R² {fmt(stock.metrics.fit, 3)}</dd>
              <dt>路径效率</dt>
              <dd>{fmt(stock.metrics.efficiency)}%</dd>
              <dt>站上MA60</dt>
              <dd>{stock.metrics.aboveCount} / 60根</dd>
              <dt>20日相对量</dt>
              <dd>{fmt(stock.metrics.volumeRatio)}倍（参考）</dd>
              <dt>评分区间</dt>
              <dd>
                {stock.metrics.windowStart} → {stock.metrics.windowEnd}
              </dd>
            </dl>
            <p className="hint">
              日线：{stock.historySource} · 取得于{" "}
              {time(stock.historyFetchedAt)}。这是形态评分，不是收益概率。
            </p>
          </div>
        )}
        <div className="split">
          <h3>日 K · 前复权</h3>
          <small>
            {!stock.trend && <span className="blue">━ MA5</span>}{" "}
            <span className="orange">━ MA20</span>
            {stock.trend && (
              <>
                <span className="trend-ma60"> ━ MA60</span>
                <span className="trend-ma120"> ━ MA120</span>
              </>
            )}
          </small>
        </div>
        {busy ? (
          <div className="empty">正在读取日线…</div>
        ) : error ? (
          <p className="notice error">{error}</p>
        ) : (
          <>
            <Chart bars={bars} trend={stock.trend} bands={bands} />
            {bars.length >= 20 && (
              <div className="chart-options">
                <button
                  type="button"
                  aria-pressed={showBands}
                  onClick={() => setShowBands((value) => !value)}
                >
                  布林带 BOLL（20, 2）
                </button>
                {showBands && <small>虚线为上下轨，MA20 为中轨</small>}
              </div>
            )}
            {current && (
              <ChartObservation observation={observation} asOf={asOf} />
            )}
          </>
        )}
        <p className="hint">价格为原始报价，日 K 为前复权。成交量单位：股。</p>
      </div>
      <div className="section">
        <h3>
          {stock.checks?.some((c) => !c.pass) ? "还差哪项条件" : "选股证据"}
        </h3>
        {stock.checks?.length ? (
          stock.checks.map((c) => (
            <div className="reason" key={c.label}>
              <span className={c.pass ? "" : "error"}>
                {c.pass ? "✓" : "✗"}
              </span>
              <div>
                {c.label}
                <small>{c.detail}</small>
                {c.gap && <small>{c.gap}</small>}
              </div>
            </div>
          ))
        ) : (
          <p className="muted">
            尚未进行历史筛选。点击「开始筛选」查看规则命中结果。
          </p>
        )}
      </div>
      <div className="section">
        <h3>数据状态</h3>
        <dl>
          <dt>报价来源</dt>
          <dd>{stock.source}</dd>
          <dt>来源时间</dt>
          <dd>{time(stock.quoteAt)}</dd>
          <dt>完成日线截至</dt>
          <dd>{current?.latestBarDate || "—"}</dd>
          <dt>日线来源</dt>
          <dd>
            {current?.source || "—"}
            {current?.fromCache ? " · 缓存" : ""}
          </dd>
          <dt>换手率</dt>
          <dd>{fmt(stock.turnover)}%</dd>
        </dl>
        {current?.latestBarDate && current.latestBarDate !== asOf && (
          <p className="notice">
            缺少目标交易日日线，图表截至 {current.latestBarDate}。
          </p>
        )}
      </div>
    </aside>
  );
}
