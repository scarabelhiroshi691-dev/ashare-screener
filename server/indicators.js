export function average(values) {
  return values.length
    ? values.reduce((sum, n) => sum + n, 0) / values.length
    : null;
}
export function movingAverage(bars, index, count) {
  return index + 1 >= count
    ? average(bars.slice(index + 1 - count, index + 1).map((b) => b.close))
    : null;
}

export function rsi14(bars) {
  if (bars.length < 15) return null;
  let gain = 0,
    loss = 0;
  for (let i = 1; i < bars.length; i++) {
    const delta = bars[i].close - bars[i - 1].close;
    if (i <= 14) {
      gain += Math.max(delta, 0) / 14;
      loss += Math.max(-delta, 0) / 14;
    } else {
      gain = (gain * 13 + Math.max(delta, 0)) / 14;
      loss = (loss * 13 + Math.max(-delta, 0)) / 14;
    }
  }
  return gain === 0 && loss === 0
    ? 50
    : loss === 0
      ? 100
      : 100 - 100 / (1 + gain / loss);
}

export function analyzeBars(input, asOf, cfg) {
  const bars = input.filter((bar) => bar.date <= asOf);
  const last = bars.at(-1);
  if (!last || last.date !== asOf) throw new Error("缺少目标交易日的完成日线");
  if (bars.length < 20) throw new Error("历史日线不足 20 个交易日");
  const ma5 = movingAverage(bars, bars.length - 1, 5);
  const ma20 = movingAverage(bars, bars.length - 1, 20);
  const priorVolume = average(bars.slice(-6, -1).map((b) => b.volume));
  const volumeRatio = priorVolume > 0 ? last.volume / priorVolume : null;
  const ma60 = movingAverage(bars, bars.length - 1, 60),
    rsi = rsi14(bars),
    bias = (last.close / ma20 - 1) * 100;
  if (cfg.ma20AboveMa60 && ma60 === null)
    throw new Error("历史日线不足 60 个交易日");
  if (cfg.breakout20 && bars.length < 21)
    throw new Error("突破条件需至少 21 个交易日");
  const previousHigh =
    bars.length >= 21
      ? Math.max(...bars.slice(-21, -1).map((b) => b.high))
      : null;
  const checks = [];
  const greater = (label, value, threshold, inclusive = false, unit = "") =>
    checks.push({
      label,
      pass:
        value !== null && (inclusive ? value >= threshold : value > threshold),
      value,
      threshold,
      margin: value === null ? null : value - threshold,
      detail:
        value === null
          ? "指标不可用"
          : "实际 " +
            value.toFixed(2) +
            unit +
            " / 门槛 " +
            threshold.toFixed(2) +
            unit,
      gap:
        value === null
          ? "缺少有效数据"
          : "与门槛相差 " + (value - threshold).toFixed(2) + unit,
    });
  if (cfg.strategy === "swing") {
    if (cfg.priceAboveMa20) greater("收盘价高于 20 日均线", last.close, ma20);
    if (cfg.ma5AboveMa20) greater("5 日均线高于 20 日均线", ma5, ma20);
  }
  if (cfg.strategy === "short" || cfg.useVolume)
    greater(
      "当日量 / 前5日均量 ≥ " + cfg.minVolumeRatio,
      volumeRatio,
      cfg.minVolumeRatio,
      true,
      "倍",
    );
  if (cfg.ma20AboveMa60) greater("20 日均线高于 60 日均线", ma20, ma60);
  if (cfg.breakout20)
    greater("收盘突破前 20 日最高价", last.close, previousHigh);
  if (cfg.useRsi) {
    const margin = Math.min(rsi - cfg.minRsi, cfg.maxRsi - rsi);
    checks.push({
      label: "RSI14 在 " + cfg.minRsi + "–" + cfg.maxRsi + " 之间",
      pass: margin >= 0,
      value: rsi,
      margin,
      detail: "实际 " + rsi.toFixed(2),
      gap:
        margin >= 0
          ? "距最近边界 " + margin.toFixed(2)
          : "超出区间 " + (-margin).toFixed(2),
    });
  }
  if (cfg.useBias)
    checks.push({
      label: "高于 MA20 的幅度 ≤ " + cfg.maxBias + "%",
      pass: bias <= cfg.maxBias,
      value: bias,
      threshold: cfg.maxBias,
      margin: cfg.maxBias - bias,
      detail: "实际 " + bias.toFixed(2) + "%",
      gap:
        (bias > cfg.maxBias ? "超过上限 " : "距上限 ") +
        Math.abs(cfg.maxBias - bias).toFixed(2) +
        " 个百分点",
    });

  return {
    passed: checks.every((c) => c.pass),
    checks,
    metrics: {
      ma5,
      ma20,
      ma60,
      rsi14: rsi,
      bias,
      previousHigh,
      volumeRatio,
      adjustedClose: last.close,
      date: asOf,
    },
  };
}

export function chartBars(bars, asOf) {
  const completed = bars.filter((b) => b.date <= asOf);
  return completed
    .map((bar, i) => ({
      ...bar,
      ma5: movingAverage(completed, i, 5),
      ma20: movingAverage(completed, i, 20),
      ma60: movingAverage(completed, i, 60),
      ma120: movingAverage(completed, i, 120),
    }))
    .slice(-80);
}
