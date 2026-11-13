import { numberOrNull, validateConfig } from "./rules.js";

export const trendDefaults = {
  board: "all",
  minAmountYi: 2,
  minPrice: 3,
  maxScan: 100,
  lookback: 120,
  minReturn: 10,
  maxDrawdown: 15,
  minFit: 0.6,
  minEfficiency: 15,
  minAbove: 70,
  maxBias: 8,
};
export function validateTrend(input = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw Error("趋势参数格式不正确");
  const cfg = { ...trendDefaults, ...input };
  if (!["all", "main", "growth", "star"].includes(cfg.board))
    throw Error("股票范围不正确");
  const bounds = {
    minAmountYi: [0, 10000],
    minPrice: [0, 100000],
    maxScan: [1, 2000],
    minReturn: [0, 200],
    maxDrawdown: [0, 80],
    minFit: [0, 1],
    minEfficiency: [0, 100],
    minAbove: [0, 100],
    maxBias: [0, 50],
  };
  for (const [key, [lo, hi]] of Object.entries(bounds)) {
    const n = numberOrNull(cfg[key]);
    if (n === null || n < lo || n > hi)
      throw Error("趋势参数超出范围，请检查输入");
    cfg[key] = n;
  }
  cfg.lookback = Number(cfg.lookback);
  if (![60, 120].includes(cfg.lookback) || !Number.isInteger(cfg.maxScan))
    throw Error("窗口或扫描数量不正确");
  return Object.fromEntries(
    Object.keys(trendDefaults).map((key) => [key, cfg[key]]),
  );
}
export function trendBaseConfig(config) {
  return validateConfig({
    board: config.board,
    minAmountYi: config.minAmountYi,
    minPrice: config.minPrice,
    strategy: "swing",
    excludeST: true,
    excludeInactive: true,
  });
}
