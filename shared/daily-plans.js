import { defaults, validateConfig } from "./rules.js";
export const dailyPlans = [
  {
    id: "daily-short-v1",
    name: "日常短线·低偏离 v1",
    hold: 3,
    config: validateConfig({
      ...defaults,
      strategy: "short",
      useBias: true,
      maxBias: 3,
    }),
  },
  {
    id: "daily-swing-v1",
    name: "日常波段·趋势跟随 v1",
    hold: 5,
    config: validateConfig({
      ...defaults,
      strategy: "swing",
      ma20AboveMa60: true,
      useBias: true,
      maxBias: 12,
    }),
  },
].map((p) => ({ ...p, costBps: 10, slippageBps: 5 }));
export const dailyMethod =
  "前瞻模拟：仅登记启用后当日收盘信号，不补记过去入选。次根有效日线开盘模拟入场；持有期包含入场日，同策略同股不重叠。一字行情跳过入场或延后退出。每次以同一来源的整段前复权日线计算，已退出结果冻结。成本每边10基点、滑点每边5基点；未模拟整手、最低佣金、完整涨跌停和流动性。统计是单次信号表现，不是账户收益；页面无真实下单。";
