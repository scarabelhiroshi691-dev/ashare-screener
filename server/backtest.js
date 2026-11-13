import { analyzeBars } from "./indicators.js";
import { numberOrNull } from "../shared/rules.js";
export const assumptions =
  "技术信号事件回测：当前样本回看，存在选择及幸存者偏差。只重放技术条件，不重放当前报价的成交额、股价、涨幅、换手、ST和板块基础过滤。收盘信号，下一根有效日线开盘入场；同股不重叠。持有期以有效日线计，一字行情跳过入场或延后退出。费用为设定的比例模型，未模拟最低佣金、买卖股数、逐日涨跌停、流动性和资金占用。统计为单次信号表现，不是组合收益或年化收益。";
export function validateBacktest(input = {}) {
  const cfg = {
    window: 60,
    hold: 5,
    costBps: 10,
    slippageBps: 5,
    maxStocks: 50,
    ...input,
  };
  for (const [key, min, max] of [
    ["window", 30, 90],
    ["hold", 2, 20],
    ["costBps", 0, 100],
    ["slippageBps", 0, 100],
    ["maxStocks", 1, 100],
  ]) {
    const n = numberOrNull(cfg[key]);
    if (n === null || n < min || n > max || !Number.isInteger(n))
      throw Error("回测参数超出范围：" + key);
    cfg[key] = n;
  }
  return Object.fromEntries(
    ["window", "hold", "costBps", "slippageBps", "maxStocks"].map((k) => [
      k,
      cfg[k],
    ]),
  );
}
function tradable(bar) {
  return (
    bar && bar.volume > 0 && bar.high > bar.low && bar.open > 0 && bar.close > 0
  );
}
export function simulateStock(stock, input, config, settings, asOf) {
  const bars = input.filter((b) => b.date <= asOf);
  if (!bars.length || bars.at(-1).date !== asOf)
    throw Error("缺少回测截止日的完成日线");
  const warmup = config.ma20AboveMa60 ? 60 : config.breakout20 ? 21 : 20;
  if (bars.length < warmup + settings.hold + 1)
    throw Error("有效历史不足以完成一次回测交易");
  const trades = [];
  let skipped = 0,
    pending = 0,
    lastExit = -1,
    signalCount = 0;
  const start = Math.max(warmup - 1, bars.length - settings.window);
  for (let i = start; i < bars.length; i++) {
    if (i <= lastExit) continue;
    const signal = analyzeBars(bars.slice(0, i + 1), bars[i].date, config);
    if (!signal.passed) continue;
    signalCount++;
    const entry = i + 1;
    if (entry >= bars.length) {
      pending++;
      break;
    }
    if (!tradable(bars[entry])) {
      skipped++;
      continue;
    }
    let exit = entry + settings.hold - 1;
    if (exit >= bars.length) {
      pending++;
      break;
    }
    const planned = exit;
    while (exit < bars.length && !tradable(bars[exit])) exit++;
    if (exit >= bars.length) {
      pending++;
      break;
    }
    const entryPrice = bars[entry].open * (1 + settings.slippageBps / 10000);
    const exitPrice = bars[exit].close * (1 - settings.slippageBps / 10000);
    const gross = (bars[exit].close / bars[entry].open - 1) * 100;
    const net =
      (((exitPrice / entryPrice) * (1 - settings.costBps / 10000)) /
        (1 + settings.costBps / 10000) -
        1) *
      100;
    trades.push({
      symbol: stock.symbol,
      code: stock.code,
      name: stock.name,
      signalDate: bars[i].date,
      entryDate: bars[entry].date,
      exitDate: bars[exit].date,
      entryPrice,
      exitPrice,
      gross,
      net,
      holdBars: exit - entry + 1,
      delayed: exit - planned,
      checks: signal.checks.map((c) => c.label),
    });
    lastExit = exit;
  }
  return {
    trades,
    skipped,
    pending,
    signalCount,
    from: bars[start]?.date,
    to: bars.at(-1).date,
  };
}
export function summarizeTrades(trades) {
  if (!trades.length)
    return {
      count: 0,
      average: null,
      median: null,
      winRate: null,
      worst: null,
      best: null,
      months: [],
    };
  const sorted = trades.map((t) => t.net).sort((a, b) => a - b),
    count = sorted.length;
  const mean = (values) => values.reduce((a, b) => a + b, 0) / values.length;
  const months = new Map();
  for (const t of trades) {
    const m = t.entryDate.slice(0, 7);
    if (!months.has(m)) months.set(m, []);
    months.get(m).push(t.net);
  }
  return {
    count,
    average: mean(sorted),
    median:
      count % 2
        ? sorted[(count - 1) / 2]
        : (sorted[count / 2 - 1] + sorted[count / 2]) / 2,
    winRate: (sorted.filter((n) => n > 0).length / count) * 100,
    worst: sorted[0],
    best: sorted.at(-1),
    months: [...months]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([month, v]) => ({ month, count: v.length, average: mean(v) })),
  };
}
export function forwardPerformance(stock, bars, date, asOf) {
  const series = bars.filter((b) => b.date <= asOf),
    index = series.findIndex((b) => b.date === date);
  if (index < 0) throw Error("历史序列没有入选日，无法比较");
  const origin = series[index].close;
  return {
    ...stock,
    baseDate: date,
    baseClose: origin,
    latestDate: series.at(-1).date,
    returns: Object.fromEntries(
      [1, 5, 10].map((n) => [
        n,
        series[index + n]
          ? {
              date: series[index + n].date,
              pct: (series[index + n].close / origin - 1) * 100,
            }
          : null,
      ]),
    ),
  };
}
