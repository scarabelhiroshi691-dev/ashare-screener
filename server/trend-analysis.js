import { movingAverage, average } from "./indicators.js";

const clip = (n) => Math.max(0, Math.min(1, n));
export function analyzeTrend(input, asOf, cfg) {
  const bars = input.filter((b) => b.date <= asOf);
  if (!bars.length || bars.at(-1).date !== asOf)
    throw Error("缺少目标完成交易日线");
  if (bars.length < 120)
    throw Error(`稳健趋势需要至少120根有效日线，当前${bars.length}根`);
  if (
    new Set(bars.map((b) => b.date)).size !== bars.length ||
    bars.some(
      (b, i) =>
        !/^\d{4}-\d{2}-\d{2}$/.test(b.date) ||
        (i > 0 && b.date <= bars[i - 1].date) ||
        ![b.open, b.close, b.high, b.low, b.volume].every(Number.isFinite) ||
        Math.min(b.open, b.close, b.high, b.low, b.volume) <= 0 ||
        b.high < Math.max(b.open, b.close) ||
        b.low > Math.min(b.open, b.close),
    )
  )
    throw Error("趋势日线日期、价格或成交量异常");
  const last = bars.at(-1),
    index = bars.length - 1,
    window = bars.slice(-cfg.lookback);
  const ma20 = movingAverage(bars, index, 20),
    ma60 = movingAverage(bars, index, 60),
    ma120 = movingAverage(bars, index, 120);
  const ma20Rise = (ma20 / movingAverage(bars, index - 10, 20) - 1) * 100;
  const ma60Rise = (ma60 / movingAverage(bars, index - 20, 60) - 1) * 100;
  const closes = window.map((b) => b.close),
    logs = closes.map(Math.log),
    n = logs.length;
  const mean = average(logs),
    center = (n - 1) / 2;
  let xx = 0,
    xy = 0,
    yy = 0,
    path = 0,
    peak = closes[0],
    drawdown = 0;
  for (let i = 0; i < n; i++) {
    xx += (i - center) ** 2;
    xy += (i - center) * (logs[i] - mean);
    yy += (logs[i] - mean) ** 2;
    peak = Math.max(peak, closes[i]);
    drawdown = Math.max(drawdown, (1 - closes[i] / peak) * 100);
    if (i) path += Math.abs(closes[i] - closes[i - 1]);
  }
  const slope = xy / xx,
    fit = yy > 0 ? clip((xy * xy) / (xx * yy)) : 0;
  const efficiency = path > 0 ? (closes.at(-1) - closes[0]) / path : 0;
  const aboveCount = bars
    .slice(-60)
    .filter(
      (b, i) => b.close > movingAverage(bars, bars.length - 60 + i, 60),
    ).length;
  const above = aboveCount / 60,
    change = (last.close / closes[0] - 1) * 100,
    bias = (last.close / ma20 - 1) * 100;
  const volumeRatio =
    last.volume / average(bars.slice(-21, -1).map((b) => b.volume));
  const components = {
    fit: 35 * fit,
    efficiency: 25 * clip(efficiency),
    drawdown: 25 * clip(1 - drawdown / 30),
    above: 15 * above,
  };
  const score = Object.values(components).reduce((a, b) => a + b, 0);
  const checks = [];
  const check = (label, pass, detail, value, threshold) =>
    checks.push({ label, pass, detail, value, threshold });
  check(
    "均线排列：收盘 > MA20 > MA60 > MA120",
    last.close > ma20 && ma20 > ma60 && ma60 > ma120,
    `${last.close.toFixed(2)} / ${ma20.toFixed(2)} / ${ma60.toFixed(2)} / ${ma120.toFixed(2)}`,
  );
  check(
    "中期均线持续上行",
    ma20Rise > 0 && ma60Rise > 0,
    `MA20近10根 ${ma20Rise.toFixed(2)}%；MA60近20根 ${ma60Rise.toFixed(2)}%`,
  );
  check(
    `窗口涨幅 ≥ ${cfg.minReturn}%`,
    change >= cfg.minReturn,
    `实际 ${change.toFixed(2)}%`,
    change,
    cfg.minReturn,
  );
  check(
    `窗口最大收盘回撤 ≤ ${cfg.maxDrawdown}%`,
    drawdown <= cfg.maxDrawdown,
    `实际 ${drawdown.toFixed(2)}%`,
    drawdown,
    cfg.maxDrawdown,
  );
  check(
    `上行拟合度 R² ≥ ${cfg.minFit}`,
    slope > 0 && fit >= cfg.minFit,
    `R² ${fit.toFixed(3)}；斜率${slope > 0 ? "向上" : "未向上"}`,
    fit,
    cfg.minFit,
  );
  check(
    `上涨路径效率 ≥ ${cfg.minEfficiency}%`,
    efficiency * 100 >= cfg.minEfficiency,
    `实际 ${(efficiency * 100).toFixed(2)}%`,
    efficiency * 100,
    cfg.minEfficiency,
  );
  check(
    `近60根站上MA60比例 ≥ ${cfg.minAbove}%`,
    above * 100 >= cfg.minAbove,
    `${aboveCount}/60根，${(above * 100).toFixed(1)}%`,
    above * 100,
    cfg.minAbove,
  );
  check(
    `高于MA20的幅度 ≤ ${cfg.maxBias}%`,
    bias <= cfg.maxBias,
    `实际 ${bias.toFixed(2)}%`,
    bias,
    cfg.maxBias,
  );
  return {
    passed: checks.every((c) => c.pass),
    checks,
    metrics: {
      score,
      components,
      ma20,
      ma60,
      ma120,
      ma20Rise,
      ma60Rise,
      windowReturn: change,
      maxDrawdown: drawdown,
      fit,
      efficiency: efficiency * 100,
      above: above * 100,
      aboveCount,
      bias,
      volumeRatio,
      windowStart: window[0].date,
      windowEnd: last.date,
      windowBars: window.length,
      historyBars: bars.length,
    },
  };
}
