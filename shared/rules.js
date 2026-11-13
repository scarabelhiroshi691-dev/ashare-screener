export const defaults = {
  strategy: "swing",
  board: "all",
  excludeST: true,
  excludeInactive: true,
  minAmountYi: 2,
  minPrice: 3,
  priceAboveMa20: true,
  ma5AboveMa20: true,
  minChange: 1,
  maxChange: 7,
  minTurnover: 2,
  maxTurnover: 15,
  minVolumeRatio: 1.2,
  maxScan: 100,
  ma20AboveMa60: false,
  breakout20: false,
  useRsi: false,
  minRsi: 35,
  maxRsi: 70,
  useBias: false,
  maxBias: 10,
  useVolume: false,
};

export function numberOrNull(value) {
  if (value === null || value === undefined || value === "" || value === "-")
    return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export function validateConfig(input = {}) {
  const cfg = { ...defaults, ...input };
  if (
    !["swing", "short"].includes(cfg.strategy) ||
    !["all", "main", "growth", "star"].includes(cfg.board)
  )
    throw new Error("请选择有效策略和股票范围。");
  for (const key of [
    "excludeST",
    "excludeInactive",
    "priceAboveMa20",
    "ma5AboveMa20",
    "ma20AboveMa60",
    "breakout20",
    "useRsi",
    "useBias",
    "useVolume",
  ]) {
    if (typeof cfg[key] !== "boolean") throw new Error("筛选开关格式不正确。");
  }
  const bounds = {
    minAmountYi: [0, 10000],
    minPrice: [0, 100000],
    minChange: [-30, 30],
    maxChange: [-30, 30],
    minTurnover: [0, 100],
    maxTurnover: [0, 100],
    minVolumeRatio: [0, 100],
    maxScan: [1, 1000],
    minRsi: [0, 100],
    maxRsi: [0, 100],
    maxBias: [0, 100],
  };
  for (const [key, [min, max]] of Object.entries(bounds)) {
    const val = numberOrNull(cfg[key]);
    if (val === null || val < min || val > max)
      throw new Error("筛选数值超出允许范围，请检查输入。");
    cfg[key] = val;
  }
  if (
    !Number.isInteger(cfg.maxScan) ||
    cfg.minChange > cfg.maxChange ||
    cfg.minTurnover > cfg.maxTurnover ||
    cfg.minRsi > cfg.maxRsi
  )
    throw new Error("上下限或扫描数量不正确。");
  return Object.fromEntries(Object.keys(defaults).map((k) => [k, cfg[k]]));
}

export function symbolBoard(code) {
  return /^68/.test(code) ? "star" : /^30/.test(code) ? "growth" : "main";
}
export function validSymbol(symbol) {
  return /^(sh(600|601|603|605|688|689)\d{3}|sz(000|001|002|003|300|301)\d{3})$/.test(
    symbol,
  );
}

export function baseReason(stock, cfg, asOf) {
  if (stock.quoteDate !== asOf) return "报价日期不匹配";
  if (cfg.board !== "all" && stock.board !== cfg.board) return "不在选定板块";
  if (cfg.excludeST && /ST|退/i.test(stock.name)) return "风险警示或退市标记";
  if (stock.price === null || stock.amount === null || stock.volume === null)
    return "关键行情缺失";
  if (cfg.excludeInactive && (stock.price <= 0 || stock.volume <= 0))
    return "停牌或无有效成交";
  if (stock.price < cfg.minPrice || stock.amount < cfg.minAmountYi * 1e8)
    return "价格或成交额不符";
  if (cfg.strategy === "short") {
    if (stock.changePct === null || stock.turnover === null)
      return "短线指标缺失";
    if (stock.changePct < cfg.minChange || stock.changePct > cfg.maxChange)
      return "涨跌幅不符";
    if (stock.turnover < cfg.minTurnover || stock.turnover > cfg.maxTurnover)
      return "换手率不符";
  }
  return null;
}
