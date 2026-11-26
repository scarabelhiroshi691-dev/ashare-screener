import { numberOrNull } from "./rules.js";

export const dpoVersion = "dpo-retest-v1";
export const dpoDefaults = Object.freeze({
  period: 20,
  shift: 10,
  smooth: 6,
  belowBars: 5,
  watchBars: 15,
  tolerancePct: 0.3,
  stopLossPct: 8,
  maxHold: 20,
  window: 120,
  maxStocks: 100,
  costBps: 10,
  slippageBps: 5,
});
export const dpoFormula =
  "DPO=CLOSE-REF(MA(CLOSE,N),L)；MADPO=MA(DPO,M)，不居中、不向过去回填。";
export const dpoAssumptions =
  "独立DPO信号事件回测。当前沪深合格池按当前成交额降序抽样，存在选择及幸存者偏差，不是历史全市场回测。金叉仅观察，回踩不破后再次上拐收盘确认，下一有效日线开盘入场；同股不重叠，T+1。蓝线下降/跌破黄线、收盘止损或持有上限触发后下一开盘离场；一字行情跳过入场或延后退出。未退出不计入已完成收益。每边比例成本及滑点，不含最低佣金、完整历史涨跌停、流动性和资金占用；单次信号收益不是组合/年化收益。前复权历史为当前可得版本，非逐日存档数据。";
export function validateDpo(input = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw Error("DPO参数格式不正确");
  const bounds = {
    period: [5, 40],
    shift: [1, 20],
    smooth: [2, 12],
    belowBars: [1, 10],
    watchBars: [2, 30],
    tolerancePct: [0, 2],
    stopLossPct: [1, 30],
    maxHold: [2, 40],
    window: [30, 120],
    maxStocks: [1, 200],
    costBps: [0, 100],
    slippageBps: [0, 100],
  };
  const cfg = {};
  for (const [k, [lo, hi]] of Object.entries(bounds)) {
    const n = numberOrNull(input[k] ?? dpoDefaults[k]);
    if (
      n === null ||
      n < lo ||
      n > hi ||
      (!["tolerancePct", "stopLossPct"].includes(k) && !Number.isInteger(n))
    )
      throw Error("DPO参数超出范围：" + k);
    cfg[k] = n;
  }
  return cfg;
}
