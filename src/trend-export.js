export function trendCSV(job) {
  const rows = [
    ["历史稳健趋势", "形态研究评分，不是胜率或收益预测"],
    [
      "完成日",
      job.date,
      "窗口根数",
      job.config.lookback,
      "任务状态",
      job.status,
    ],
    ["本次条件", JSON.stringify(job.config)],
    [
      "代码",
      "名称",
      "趋势评分",
      "窗口涨幅%",
      "最大收盘回撤%",
      "R²",
      "路径效率%",
      "站稳MA60比例%",
      "MA20偏离%",
      "日线来源",
      "日线获取时间",
    ],
    ...job.results.map((s) => [
      s.code + "." + s.symbol.slice(0, 2).toUpperCase(),
      s.name,
      s.metrics.score,
      s.metrics.windowReturn,
      s.metrics.maxDrawdown,
      s.metrics.fit,
      s.metrics.efficiency,
      s.metrics.above,
      s.metrics.bias,
      s.historySource,
      s.historyFetchedAt,
    ]),
  ];
  const cell = (v) =>
    '"' +
    (typeof v === "number"
      ? String(v)
      : String(v ?? "").replace(/^[\s]*[=+@-]/, "'$&")
    ).replaceAll('"', '""') +
    '"';
  return "\ufeff" + rows.map((row) => row.map(cell).join(",")).join("\r\n");
}
