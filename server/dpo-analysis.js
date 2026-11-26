import { validateDpo } from "../shared/dpo-rules.js";
import { summarizeTrades } from "./backtest.js";

// All points use only bars through their own index. REF is a positive lag.
export function dpoSeries(bars, cfg) {
  const means = bars.map((_, i) =>
    i + 1 < cfg.period
      ? null
      : bars.slice(i - cfg.period + 1, i + 1).reduce((s, b) => s + b.close, 0) /
        cfg.period,
  );
  const dpo = bars.map((b, i) =>
    i < cfg.shift || means[i - cfg.shift] === null
      ? null
      : b.close - means[i - cfg.shift],
  );
  return bars.map((b, i) => {
    const values = dpo.slice(i - cfg.smooth + 1, i + 1);
    const average =
      i + 1 >= cfg.smooth &&
      values.length === cfg.smooth &&
      values.every(Number.isFinite)
        ? values.reduce((s, v) => s + v, 0) / cfg.smooth
        : null;
    return {
      date: b.date,
      dpo: dpo[i],
      average,
      gap: average === null ? null : dpo[i] - average,
    };
  });
}

export function dpoSignals(bars, points, cfg) {
  let below = 0,
    watch = null;
  return points.map((p, i) => {
    const prev = points[i - 1];
    const result = {
      ...p,
      stage: "none",
      signal: false,
      crossDate: null,
      touchDate: null,
    };
    if (p.gap === null) return result;
    if (p.gap < 0) below++;
    else if (p.gap === 0) below = 0;
    else {
      if (prev?.gap !== null && prev?.gap <= 0 && below >= cfg.belowBars)
        watch = { index: i, date: p.date, touch: null };
      below = 0;
    }
    if (!watch) return result;
    if (p.gap < 0 || i - watch.index > cfg.watchBars) {
      watch = null;
      return result;
    }
    result.crossDate = watch.date;
    result.stage = i === watch.index ? "cross" : "watch";
    if (
      i > watch.index &&
      prev &&
      p.gap <= (bars[i].close * cfg.tolerancePct) / 100 &&
      p.gap < prev.gap
    )
      watch.touch = p.date;
    if (watch.touch) {
      result.touchDate = watch.touch;
      result.stage = "retest";
      if (p.date > watch.touch && p.dpo > prev.dpo && p.gap > prev.gap) {
        result.signal = true;
        result.stage = "entry";
        watch = null; // One entry confirmation per observed cross.
      }
    }
    return result;
  });
}

const tradable = (b) => b && b.volume > 0 && b.high > b.low && b.open > 0;
export function replayDpo(stock, bars, points, signals, cfg, start) {
  const trades = [],
    pending = [];
  let lastExit = -1,
    skipped = 0,
    signalCount = 0;
  for (let i = start; i < bars.length; i++) {
    if (i <= lastExit || !signals[i].signal) continue;
    signalCount++;
    const entry = i + 1;
    if (entry >= bars.length) {
      pending.push({
        symbol: stock.symbol,
        name: stock.name,
        signalDate: bars[i].date,
        state: "待入场",
      });
      break;
    }
    if (!tradable(bars[entry])) {
      skipped++;
      continue;
    }
    const entryPrice = bars[entry].open * (1 + cfg.slippageBps / 10000);
    let decision = -1,
      reason;
    for (let j = entry; j < bars.length; j++) {
      if (points[j].gap < 0) reason = "跌破黄线";
      else if (points[j].dpo < points[j - 1].dpo) reason = "蓝线向下";
      else if ((bars[j].close / entryPrice - 1) * 100 <= -cfg.stopLossPct)
        reason = "收盘止损";
      else if (j - entry + 1 >= cfg.maxHold) reason = "持有上限";
      else continue;
      decision = j;
      break;
    }
    let exit = decision < 0 ? bars.length : decision + 1;
    const planned = exit;
    while (exit < bars.length && !tradable(bars[exit])) exit++;
    if (exit >= bars.length) {
      pending.push({
        symbol: stock.symbol,
        name: stock.name,
        signalDate: bars[i].date,
        entryDate: bars[entry].date,
        entryPrice,
        state: decision < 0 ? "持有中" : "待退出",
        reason: decision < 0 ? null : reason,
      });
      break;
    }
    const exitPrice = bars[exit].open * (1 - cfg.slippageBps / 10000);
    const net =
      ((exitPrice * (1 - cfg.costBps / 10000)) /
        (entryPrice * (1 + cfg.costBps / 10000)) -
        1) *
      100;
    // Closing-mark path for this single trade, not a multi-stock portfolio.
    let peak = entryPrice * (1 + cfg.costBps / 10000),
      drawdown = 0;
    for (const value of [
      ...bars
        .slice(entry, exit)
        .map(
          (b) =>
            b.close * (1 - cfg.slippageBps / 10000) * (1 - cfg.costBps / 10000),
        ),
      exitPrice * (1 - cfg.costBps / 10000),
    ]) {
      peak = Math.max(peak, value);
      drawdown = Math.max(drawdown, (1 - value / peak) * 100);
    }
    trades.push({
      ...stock,
      signalDate: bars[i].date,
      crossDate: signals[i].crossDate,
      touchDate: signals[i].touchDate,
      entryDate: bars[entry].date,
      exitSignalDate: bars[decision].date,
      exitDate: bars[exit].date,
      entryPrice,
      exitPrice,
      gross: (bars[exit].open / bars[entry].open - 1) * 100,
      net,
      holdBars: exit - entry,
      delayed: exit - planned,
      reason,
      maxDrawdown: drawdown,
    });
    lastExit = exit;
  }
  return { trades, pending, skipped, signalCount };
}

export function analyzeDpo(stock, input, asOf, config) {
  const cfg = validateDpo(config),
    bars = input.filter((b) => b.date <= asOf);
  if (!bars.length || bars.at(-1).date !== asOf)
    throw Error("缺少DPO截止日完成日线");
  if (
    bars.some(
      (b, i) =>
        !/^\d{4}-\d{2}-\d{2}$/.test(b.date) ||
        (i && b.date <= bars[i - 1].date) ||
        ["open", "high", "low", "close", "volume"].some(
          (k) => !Number.isFinite(b[k]),
        ) ||
        b.close <= 0 ||
        b.open <= 0 ||
        b.high < Math.max(b.open, b.close) ||
        b.low > Math.min(b.open, b.close) ||
        b.low <= 0 ||
        b.volume <= 0,
    )
  )
    throw Error("DPO日线结构或顺序异常");
  const warmup = cfg.period + cfg.shift + cfg.smooth - 2 + cfg.belowBars;
  if (bars.length < warmup + cfg.window)
    throw Error(
      `DPO有效历史不足：需要至少${warmup + cfg.window}根，实际${bars.length}根`,
    );
  const points = dpoSeries(bars, cfg),
    signals = dpoSignals(bars, points, cfg),
    start = bars.length - cfg.window;
  return {
    ...replayDpo(stock, bars, points, signals, cfg, start),
    from: bars[start].date,
    to: asOf,
    historyBars: bars.length,
    latest: signals.at(-1),
    chart: signals.slice(-cfg.window).map((p, i) => ({
      ...p,
      close: bars[bars.length - cfg.window + i].close,
    })),
  };
}

export function summarizeDpo(items) {
  const valid = items.filter((i) => ["matched", "unmatched"].includes(i.state)),
    trades = valid.flatMap((i) => i.analysis.trades);
  return {
    ...summarizeTrades(trades),
    stocks: valid.length,
    noTrades: valid.filter((i) => !i.analysis.trades.length).length,
    pending: valid.reduce((s, i) => s + i.analysis.pending.length, 0),
    skipped: valid.reduce((s, i) => s + i.analysis.skipped, 0),
    signalCount: valid.reduce((s, i) => s + i.analysis.signalCount, 0),
    worstTradeDrawdown: trades.length
      ? Math.max(...trades.map((t) => t.maxDrawdown))
      : null,
  };
}
