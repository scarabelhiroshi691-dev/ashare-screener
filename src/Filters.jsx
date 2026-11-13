import React from "react";
import StrategyLibrary from "./StrategyLibrary";
export default function Filters({
  config,
  setConfig,
  disabled,
  strategies,
  updateStrategies,
}) {
  const update = (key, value) => setConfig((c) => ({ ...c, [key]: value }));
  const number = (label, key, step = 1) => (
    <label className="field">
      {label}
      <input
        type="number"
        step={step}
        value={config[key]}
        onChange={(e) => update(key, e.target.value)}
      />
    </label>
  );
  const check = (label, key) => (
    <label className="check">
      <input
        type="checkbox"
        checked={config[key]}
        onChange={(e) => update(key, e.target.checked)}
      />
      {label}
    </label>
  );
  return (
    <aside className="filters">
      <h2>筛选条件</h2>
      <fieldset disabled={disabled}>
        <div className="segmented">
          {[
            ["swing", "波段"],
            ["short", "短线"],
          ].map(([key, text]) => (
            <button
              key={key}
              className={config.strategy === key ? "active" : ""}
              onClick={() => update("strategy", key)}
            >
              {text}
            </button>
          ))}
        </div>
        <label className="field">
          股票范围
          <select
            value={config.board}
            onChange={(e) => update("board", e.target.value)}
          >
            <option value="all">沪深 A 股</option>
            <option value="main">主板</option>
            <option value="growth">创业板</option>
            <option value="star">科创板</option>
          </select>
        </label>
        {check("排除 ST / 退市标记", "excludeST")}
        {check("排除停牌 / 无成交", "excludeInactive")}
        {number("最低成交额（亿）", "minAmountYi", 0.1)}
        {number("最低股价（元）", "minPrice", 0.1)}
        {config.strategy === "swing" ? (
          <>
            {check("收盘价高于 MA20", "priceAboveMa20")}
            {check("MA5 高于 MA20", "ma5AboveMa20")}
          </>
        ) : (
          <>
            <div className="pair">
              {number("涨幅下限（%）", "minChange", 0.1)}
              {number("涨幅上限（%）", "maxChange", 0.1)}
            </div>
            <div className="pair">
              {number("换手下限（%）", "minTurnover", 0.1)}
              {number("换手上限（%）", "maxTurnover", 0.1)}
            </div>
            {number("当日量 / 前 5 日均量 ≥", "minVolumeRatio", 0.1)}
          </>
        )}
        <details className="advanced">
          <summary>进阶条件 · 全部满足</summary>
          {check("MA20 高于 MA60", "ma20AboveMa60")}
          {check("突破前 20 日最高价", "breakout20")}
          {config.strategy === "swing" && (
            <>
              {check("启用量能条件", "useVolume")}
              {config.useVolume &&
                number("当日量 / 前5日均量 ≥", "minVolumeRatio", 0.1)}
            </>
          )}
          {check("RSI14 区间", "useRsi")}
          {config.useRsi && (
            <div className="pair">
              {number("RSI 下限", "minRsi")}
              {number("RSI 上限", "maxRsi")}
            </div>
          )}
          {check("限制偏离均线", "useBias")}
          {config.useBias &&
            number("高于 MA20 的幅度上限（%）", "maxBias", 0.5)}
        </details>
        <label className="field">
          历史指标扫描上限
          <select
            value={config.maxScan}
            onChange={(e) => update("maxScan", Number(e.target.value))}
          >
            {[20, 50, 100, 200, 500, 1000].map((n) => (
              <option key={n} value={n}>
                {n} 只
              </option>
            ))}
          </select>
        </label>
      </fieldset>
      <StrategyLibrary
        config={config}
        setConfig={setConfig}
        disabled={disabled}
        strategies={strategies}
        updateStrategies={updateStrategies}
      />
      <p className="hint">
        按成交额从高到低扫描。规则用于研究，不代表收益概率。
      </p>
      <p className="hint">
        未缓存日线逐只读取，100
        只约需数分钟；临时失败自动重试。进度自动保存，可停止后续跑。
      </p>
    </aside>
  );
}
