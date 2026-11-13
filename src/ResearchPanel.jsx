import React, { useEffect, useState } from "react";
import { api, fmt, pct, time } from "./api";

function conditionSummary(c) {
  if (!c) return [];
  return [
    `${c.strategy === "short" ? "短线" : "波段"} · ${{ all: "沪深 A 股", main: "主板", growth: "创业板", star: "科创板" }[c.board]} · 最多扫描 ${c.maxScan} 只`,
    `成交额至少 ${c.minAmountYi} 亿，股价至少 ${c.minPrice} 元`,
    c.excludeST && "排除 ST / 退市标记",
    c.excludeInactive && "排除停牌 / 无成交",
    c.strategy === "short" &&
      `涨幅 ${c.minChange}%–${c.maxChange}%，换手率 ${c.minTurnover}%–${c.maxTurnover}%`,
    c.strategy === "swing" && c.priceAboveMa20 && "收盘价高于 MA20",
    c.strategy === "swing" && c.ma5AboveMa20 && "MA5 高于 MA20",
    (c.strategy === "short" || c.useVolume) &&
      `当日量 / 前 5 日均量 ≥ ${c.minVolumeRatio}`,
    c.ma20AboveMa60 && "MA20 高于 MA60",
    c.breakout20 && "收盘突破前 20 日最高价",
    c.useRsi && `RSI14：${c.minRsi}–${c.maxRsi}`,
    c.useBias && `高于 MA20 的幅度 ≤ ${c.maxBias}%`,
  ].filter(Boolean);
}

function exportResearch(job) {
  const lines =
    job.type === "backtest"
      ? [
          [
            "代码",
            "名称",
            "信号日",
            "入场日",
            "出场日",
            "毛收益%",
            "净收益%",
            "有效持有日",
            "延后退出日",
            "日线来源",
          ],
          ...job.trades.map((t) => [
            t.symbol,
            t.name,
            t.signalDate,
            t.entryDate,
            t.exitDate,
            t.gross,
            t.net,
            t.holdBars,
            t.delayed,
            t.source,
          ]),
        ]
      : [
          [
            "代码",
            "名称",
            "入选日",
            "1日变化%",
            "5日变化%",
            "10日变化%",
            "日线来源",
          ],
          ...job.rows.map((s) => [
            s.symbol,
            s.name,
            job.originDate,
            s.returns[1]?.pct ?? "未到期",
            s.returns[5]?.pct ?? "未到期",
            s.returns[10]?.pct ?? "未到期",
            s.historySource,
          ]),
        ];
  const safe = (x) =>
    '"' +
    (typeof x === "number"
      ? String(x)
      : String(x ?? "").replace(/^[\s]*[=+@-]/, "'$&")
    ).replaceAll('"', '""') +
    '"';
  const meta = [
    ["口径", job.assumptions],
    ["截止日期", job.asOf],
    ["覆盖", `${job.done - job.failed}/${job.target}`],
    ["状态", job.status],
    ["条件", JSON.stringify(job.config)],
    ["参数", JSON.stringify(job.settings)],
  ];
  const blob = new Blob(
      [
        "\ufeff" +
          [...meta, ...lines].map((r) => r.map(safe).join(",")).join("\r\n"),
      ],
      { type: "text/csv;charset=utf-8" },
    ),
    url = URL.createObjectURL(blob),
    a = document.createElement("a");
  a.href = url;
  a.download = "选股研究-" + job.type + ".csv";
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export default function ResearchPanel({ busy }) {
  const [state, setState] = useState({ records: [], job: null }),
    [selected, setSelected] = useState(""),
    [previous, setPrevious] = useState(""),
    [record, setRecord] = useState(null),
    [older, setOlder] = useState(null),
    [mode, setMode] = useState("track"),
    [error, setError] = useState(""),
    [settings, setSettings] = useState({
      window: 60,
      hold: 5,
      costBps: 10,
      slippageBps: 5,
      maxStocks: 50,
    });
  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const r = await api("research");
        if (alive) {
          setState(r);
          setSelected((s) => s || r.records[0]?.id || "");
        }
      } catch (e) {
        if (alive) setError(e.message);
      }
    };
    load();
    const id = setInterval(load, 2500);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);
  useEffect(() => {
    let alive = true;
    setRecord(null);
    if (selected)
      api("research/record?id=" + encodeURIComponent(selected))
        .then((r) => {
          if (alive) setRecord(r);
        })
        .catch((e) => {
          if (alive) setError(e.message);
        });
    return () => {
      alive = false;
    };
  }, [selected, state.records.find((r) => r.id === selected)?.updatedAt]);
  useEffect(() => {
    let alive = true;
    setOlder(null);
    if (previous)
      api("research/record?id=" + encodeURIComponent(previous))
        .then((r) => {
          if (alive) setOlder(r);
        })
        .catch((e) => {
          if (alive) setError(e.message);
        });
    return () => {
      alive = false;
    };
  }, [previous]);
  const job = state.job,
    active = state.active;
  async function action(path, input) {
    setError("");
    try {
      await api(path, input);
      setState(await api("research"));
    } catch (e) {
      setError(e.message);
    }
  }
  const field = (title, key, min, max) => (
    <label className="field">
      {title}
      <input
        type="number"
        min={min}
        max={max}
        value={settings[key]}
        disabled={active}
        onChange={(e) => setSettings((s) => ({ ...s, [key]: e.target.value }))}
      />
    </label>
  );
  const oldSymbols = new Set(older?.results.map((s) => s.symbol) || []),
    newSymbols = new Set(record?.results.map((s) => s.symbol) || []);
  const added = record?.results.filter((s) => !oldSymbols.has(s.symbol)) || [],
    removed = older?.results.filter((s) => !newSymbols.has(s.symbol)) || [];
  const changed =
    record &&
    older &&
    JSON.stringify(record.config) !== JSON.stringify(older.config);
  const resultMismatch =
    job && (job.recordId !== selected || job.type !== mode);
  return (
    <section className="research-panel">
      <div className="research-intro">
        <div>
          <span className="eyebrow">选股证据链</span>
          <h2>把一次筛选，变成可以复盘的记录。</h2>
          <p>保存条件版本，比较名单，再用历史信号检查规则表现。</p>
        </div>
        <span className="research-badge">本机保存 · 免费日线</span>
      </div>
      {error && (
        <div className="notice error" role="alert">
          {error}
        </div>
      )}
      {!state.records.length ? (
        <div className="empty">先完成一次盘后筛选，记录会自动保存在这里。</div>
      ) : (
        <>
          <div className="research-layout">
            <aside className="research-controls">
              <h3>选择筛选记录</h3>
              <select
                aria-label="研究记录"
                value={selected}
                disabled={active}
                onChange={(e) => {
                  setSelected(e.target.value);
                  setPrevious("");
                }}
              >
                {state.records.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.date} · {r.config.strategy === "short" ? "短线" : "波段"}{" "}
                    · {r.resultCount} 命中 · {time(r.startedAt)}
                  </option>
                ))}
              </select>
              {record && (
                <p className="hint">
                  已处理 {record.done}/{record.target}，失败 {record.failed}
                  。保存入选 {record.results.length}/{record.resultCount}，样本{" "}
                  {record.samples.length}/{record.sampleCount}。最多保留最近 30
                  次记录。
                </p>
              )}
              <div className="segmented">
                <button
                  className={mode === "track" ? "active" : ""}
                  disabled={active}
                  onClick={() => setMode("track")}
                >
                  名单复盘
                </button>
                <button
                  className={mode === "backtest" ? "active" : ""}
                  disabled={active}
                  onClick={() => setMode("backtest")}
                >
                  信号回测
                </button>
              </div>
              {field("研究数量上限", "maxStocks", 1, 100)}
              {mode === "backtest" && (
                <>
                  {field("信号窗口（最近有效日线数）", "window", 30, 90)}
                  {field("持有期（有效日线数）", "hold", 2, 20)}
                  {field("单边综合成本（基点）", "costBps", 0, 100)}
                  {field("单边滑点（基点）", "slippageBps", 0, 100)}
                  <p className="hint">
                    1 基点 =
                    0.01%。综合成本由你设定，包含拟计入的佣金和税费；这里只按比例估算。
                  </p>
                </>
              )}
              <button
                className="primary"
                disabled={busy || active || !record}
                onClick={() =>
                  action("research/start", {
                    type: mode,
                    recordId: selected,
                    settings,
                  })
                }
              >
                {mode === "backtest" ? "运行技术信号回测" : "更新后续表现"}
              </button>
              {active && (
                <button onClick={() => action("research/stop", {})}>
                  停止研究任务
                </button>
              )}
              <details>
                <summary>查看这次筛选的条件版本</summary>
                <ul>
                  {conditionSummary(record?.config).map((line) => (
                    <li key={line}>{line}</li>
                  ))}
                </ul>
              </details>
            </aside>
            <div className="research-results">
              {mode === "track" && record && (
                <div className="research-card">
                  <h3>名单变化</h3>
                  <select
                    aria-label="对比记录"
                    value={previous}
                    onChange={(e) => setPrevious(e.target.value)}
                  >
                    <option value="">选择另一份记录进行对比</option>
                    {state.records
                      .filter((r) => r.id !== selected)
                      .map((r) => (
                        <option value={r.id} key={r.id}>
                          {r.date} ·{" "}
                          {r.config.strategy === "short" ? "短线" : "波段"} ·{" "}
                          {r.resultCount} 命中 · {time(r.startedAt)}
                        </option>
                      ))}
                  </select>
                  {older && (
                    <>
                      <p>
                        相对对比记录：本记录独有 {added.length} · 对比记录独有{" "}
                        {removed.length} · 共同{" "}
                        {record.results.length - added.length}
                      </p>
                      <p className="hint">
                        {changed
                          ? "两次筛选条件不同，名单差异不能单独归因于市场变化。"
                          : "两次筛选条件相同；仍需核对行情日期和实际覆盖范围。"}{" "}
                        对比仅覆盖已保存名单。
                      </p>
                      <div className="comparison">
                        <div>
                          <strong>本记录独有</strong>
                          <p>
                            {added
                              .map((s) => s.name + " " + s.code)
                              .join("、") || "无"}
                          </p>
                        </div>
                        <div>
                          <strong>对比记录独有</strong>
                          <p>
                            {removed
                              .map((s) => s.name + " " + s.code)
                              .join("、") || "无"}
                          </p>
                        </div>
                      </div>
                    </>
                  )}
                  <details>
                    <summary>
                      本次保存的入选名单（{record.results.length}）
                    </summary>
                    <p>
                      {record.results
                        .map((s) => s.name + " " + s.code)
                        .join("、") || "没有入选股票"}
                    </p>
                  </details>
                </div>
              )}
              {mode === "backtest" && (
                <div className="research-card methodology">
                  <h3>先看回测口径</h3>
                  <p>
                    只重放均线、量能、突破、RSI
                    等技术条件。当前成交额、股价、涨幅、换手率和风险标记不回填到过去。
                  </p>
                  <p>
                    当前样本回看有选择及幸存者偏差；不是全市场回测。收盘信号在下一根有效日线开盘入场，固定持有，同股不重叠；一字行情跳过入场或延后退出。
                  </p>
                  <p>
                    没有完整模拟历史涨跌停、流动性、最低佣金和资金占用。下面的收益是单次信号统计，不能当作账户收益率。
                  </p>
                </div>
              )}
              {job && (
                <div className="research-card">
                  <div className="split">
                    <h3>
                      {job.type === "backtest"
                        ? "技术信号回测结果"
                        : "入选后表现"}
                    </h3>
                    <button
                      disabled={
                        active || (!job.trades?.length && !job.rows?.length)
                      }
                      onClick={() => exportResearch(job)}
                    >
                      导出研究结果
                    </button>
                  </div>
                  <p>
                    {job.originDate} 记录 · 截至 {job.asOf} ·{" "}
                    {
                      {
                        running: "运行中",
                        completed: "完成",
                        partial: "完成，存在失败",
                        stopped: "已停止",
                      }[job.status]
                    }{" "}
                    · {job.done}/{job.target} · 失败 {job.failed} · 缓存{" "}
                    {job.cacheHits}
                  </p>
                  {resultMismatch && (
                    <p className="notice">
                      这是上一任务的结果，与左侧当前选择不同；点击运行后才会生成新结果。
                    </p>
                  )}
                  <p className="hint">
                    本任务只研究前 {job.target}/{job.total} 只；
                    {job.type === "backtest"
                      ? `信号窗口 ${job.settings.window}，持有 ${job.settings.hold} 日，单边成本 ${job.settings.costBps} 基点、滑点 ${job.settings.slippageBps} 基点。`
                      : "未到期表示尚无足够的后续有效日线。"}
                  </p>
                  {active && (
                    <>
                      <progress max={job.target} value={job.done} />
                      <p>正在处理：{job.current || "准备中"}</p>
                    </>
                  )}
                  {job.fatal && <p className="error">{job.fatal}</p>}
                  {job.type === "backtest" ? (
                    <>
                      <div className="research-metrics">
                        {[
                          ["完成交易", job.summary?.count ?? 0],
                          ["单次平均净收益", pct(job.summary?.average)],
                          ["净收益中位数", pct(job.summary?.median)],
                          [
                            "盈利交易比例",
                            job.summary?.winRate == null
                              ? "—"
                              : fmt(job.summary.winRate) + "%",
                          ],
                          ["最差单次", pct(job.summary?.worst)],
                        ].map(([label, value]) => (
                          <div key={label}>
                            <small>{label}</small>
                            <strong>{value}</strong>
                          </div>
                        ))}
                      </div>
                      <p className="hint">
                        跳过入场 {job.skipped} · 尚未完成持有期/退出{" "}
                        {job.pending}。未完成交易未计入收益统计。
                      </p>
                      <h4>按入场月份 · 单次平均净收益</h4>
                      <p className="hint">
                        中线为 0%，图形范围 −20% 至 +20%；超出范围以数值为准。
                      </p>
                      <div className="month-bars">
                        {job.summary?.months.map((m) => (
                          <div key={m.month}>
                            <span>
                              {m.month} · {m.count} 笔
                            </span>
                            <span
                              className="return-track"
                              role="img"
                              aria-label={`${m.month} 平均净收益 ${pct(m.average)}`}
                            >
                              <span
                                className={
                                  m.average >= 0 ? "positive" : "negative"
                                }
                                style={{
                                  width:
                                    Math.min(20, Math.abs(m.average)) * 2.5 +
                                    "%",
                                  left:
                                    (m.average >= 0
                                      ? 50
                                      : 50 -
                                        Math.min(20, Math.abs(m.average)) *
                                          2.5) + "%",
                                }}
                              />
                            </span>
                            <strong className={m.average >= 0 ? "up" : "down"}>
                              {pct(m.average)}
                            </strong>
                          </div>
                        ))}
                      </div>
                      <div className="table-wrap">
                        <table>
                          <thead>
                            <tr>
                              {[
                                "股票",
                                "信号日",
                                "入场 → 出场",
                                "净收益",
                                "毛收益",
                                "持有",
                              ].map((t) => (
                                <th key={t}>{t}</th>
                              ))}
                            </tr>
                          </thead>
                          <tbody>
                            {job.trades?.slice(0, 200).map((t, i) => (
                              <tr key={t.symbol + t.entryDate + i}>
                                <td>
                                  {t.name}
                                  <small>{t.code}</small>
                                </td>
                                <td>{t.signalDate}</td>
                                <td>
                                  {t.entryDate}
                                  <small>
                                    → {t.exitDate}
                                    {t.delayed
                                      ? `（延后 ${t.delayed} 日）`
                                      : ""}
                                  </small>
                                </td>
                                <td className={t.net >= 0 ? "up" : "down"}>
                                  {pct(t.net)}
                                </td>
                                <td>{pct(t.gross)}</td>
                                <td>{t.holdBars} 日</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                      <p className="hint">
                        页面显示前 200 笔，导出包含本任务全部交易。
                        {job.summary?.count === 0
                          ? "没有完成交易，不生成收益统计。"
                          : ""}
                      </p>
                    </>
                  ) : (
                    <div className="table-wrap">
                      <table>
                        <thead>
                          <tr>
                            {[
                              "股票",
                              "入选日期",
                              "后1日",
                              "后5日",
                              "后10日",
                            ].map((t) => (
                              <th key={t}>{t}</th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {job.rows?.map((s) => (
                            <tr key={s.symbol}>
                              <td>
                                {s.name}
                                <small>{s.code}</small>
                              </td>
                              <td>{s.baseDate}</td>
                              {[1, 5, 10].map((n) => (
                                <td key={n}>
                                  {s.returns[n] ? (
                                    <>
                                      {pct(s.returns[n].pct)}
                                      <small>{s.returns[n].date}</small>
                                    </>
                                  ) : (
                                    "未到期"
                                  )}
                                </td>
                              ))}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                  {!!job.errors?.length && (
                    <details>
                      <summary>未完成股票及原因（{job.errors.length}）</summary>
                      {job.errors.map((e) => (
                        <p key={e.symbol}>
                          {e.name}：{e.message}
                        </p>
                      ))}
                    </details>
                  )}
                  <details>
                    <summary>完整计算说明</summary>
                    <p>{job.assumptions}</p>
                  </details>
                </div>
              )}
            </div>
          </div>
        </>
      )}
    </section>
  );
}
