import React, { useState } from "react";
import { api, pct, time } from "./api";
import { dailyPlans, dailyMethod } from "../shared/daily-plans";
import CalendarPanel from "./CalendarPanel";
import ExecutionPanel from "./ExecutionPanel";
import ReportsPanel from "./ReportsPanel";
import DailyArchive, { JobIssues } from "./DailyArchive";
import {
  useViewStatus,
  useViewRows,
  PageNav,
  downloadView,
} from "./paged-view";

const status = {
  running: "运行中",
  completed: "完成",
  partial: "完成，存在失败",
  stopped: "已停止",
  waiting: "等待数据",
  pending: "待入场",
  holding: "模拟持有",
  "exit-wait": "等待可退出日线",
  closed: "已模拟退出",
  skipped: "跳过入场",
};
export default function DailyPanel({ busy }) {
  const { state, error: pollError, refresh } = useViewStatus("daily");
  const [error, setError] = useState(""),
    [planId, setPlanId] = useState("all"),
    [view, setView] = useState("open"),
    [pending, setPending] = useState(false),
    [trackingDate, setTrackingDate] = useState(""),
    [page, setPage] = useState(1),
    [search, setSearch] = useState(""),
    [sort, setSort] = useState("recent");
  const result = useViewRows(
    "daily",
    state?.version,
    { type: "tickets", plan: planId, filter: view, q: search, sort, page },
    refresh,
  );
  const tickets = result.data?.rows || [];
  async function exportLedger(format) {
    setError("");
    try {
      await downloadView("daily", state.version, format);
    } catch (e) {
      setError(e.message);
      if (e.status === 409) refresh();
    }
  }
  async function action(path, input = {}) {
    setError("");
    setPending(true);
    try {
      await api(path, input);
      await refresh();
    } catch (e) {
      setError(e.message);
    } finally {
      setPending(false);
    }
  }
  const enabled = !!state?.plans.length,
    active = state?.active,
    storage = state?.ledgerStorage,
    protectedLedger = storage?.blocked,
    plans = enabled ? state.plans : dailyPlans;
  return (
    <section className="daily-panel">
      <div className="research-intro">
        <div>
          <span className="eyebrow">前瞻验证 · 模拟记录</span>
          <h2>条件先固定，结果慢慢验证。</h2>
          <p>
            短线持有3根有效日线，波段5根；包含入场日。只跟踪启用后实际登记的信号。
          </p>
        </div>
        <span className="research-badge">真实后续日线 · 模拟成交</span>
      </div>
      {(error || pollError || state?.lastError) && (
        <p role="alert" className="notice error">
          {error || pollError || state.lastError}
        </p>
      )}
      {storage && (
        <div className="research-card">
          <h3>
            {protectedLedger ? "账本保护中 · 自动复盘已暂停" : "账本保护与备份"}
          </h3>
          <p>
            {protectedLedger
              ? "原文件已保留。恢复完成前不能重新启用策略、推进信号或自动写入。"
              : storage.state === "new"
                ? "尚未启用；首次登记后自动保存验证备份。"
                : "每次保存先校验并备份，原策略及已完成结果受到保护。"}
          </p>
          {storage.backup && (
            <p>
              最近验证备份：{time(storage.backup.savedAt)} ·{" "}
              {storage.backup.tickets}条信号 · 已退出{storage.backup.closed}条 ·{" "}
              {storage.backup.days}个留档日
            </p>
          )}
          {protectedLedger && (
            <p role="alert">
              {storage.message}
              {storage.recoveryError ? `；${storage.recoveryError}` : ""}
            </p>
          )}
          <details>
            <summary>备份位置与恢复说明</summary>
            <p>
              <code className="rule-hash">{storage.backupDir}</code>
            </p>
            <p>
              保留首次验证、最近验证及前一份备份。主文件写入失败时，最近备份可能包含刚完成校验的进度；请核对上方数量。恢复会先另存原文件，不新增模拟信号，也不自动回退到较旧备份。
            </p>
            {storage.quarantinedFile && (
              <p>
                恢复前原文件：
                <code className="rule-hash">{storage.quarantinedFile}</code>
              </p>
            )}
          </details>
          <div className="daily-buttons">
            <button
              disabled={busy || active || pending}
              onClick={() => action("daily/storage/check")}
            >
              检查账本与备份
            </button>
            {protectedLedger && (
              <button
                className="primary"
                disabled={busy || active || pending || !storage.canRestore}
                onClick={() =>
                  action("daily/storage/restore", {
                    token: storage.restoreToken,
                  })
                }
              >
                保留原文件并恢复上述备份
              </button>
            )}
          </div>
        </div>
      )}
      <CalendarPanel
        calendar={state?.calendar}
        disabled={busy || active || pending}
        onRefresh={() => action("daily/calendar/refresh")}
      />
      <ExecutionPanel execution={state?.execution} />
      <ReportsPanel disabled={busy || active || pending || protectedLedger} />
      <div className="research-card">
        <div className="split">
          <h3>
            {protectedLedger
              ? "固定策略写入已锁定"
              : enabled
                ? "固定策略已启用"
                : "开始每日前瞻复盘"}
          </h3>
          <div className="daily-buttons">
            {!enabled ? (
              <button
                className="primary"
                disabled={protectedLedger || busy || pending || !state}
                onClick={() => action("daily/activate")}
              >
                启用这两套固定策略
              </button>
            ) : (
              <>
                <button
                  className="primary"
                  disabled={protectedLedger || busy || active || pending}
                  onClick={() => action("daily/run")}
                >
                  刷新并完成今日复盘
                </button>
                {active && (
                  <button
                    disabled={pending}
                    onClick={() => action("daily/stop")}
                  >
                    停止复盘
                  </button>
                )}
                <label>
                  已登记信号跟踪截止日
                  <input
                    type="text"
                    inputMode="numeric"
                    placeholder="YYYY-MM-DD"
                    aria-label="已登记信号跟踪截止日"
                    value={trackingDate}
                    onChange={(e) => setTrackingDate(e.target.value)}
                    disabled={protectedLedger || active || pending}
                  />
                </label>
                <button
                  disabled={
                    protectedLedger ||
                    busy ||
                    active ||
                    pending ||
                    !trackingDate
                  }
                  onClick={() =>
                    action("daily/advance", { asOf: trackingDate })
                  }
                >
                  仅推进已登记信号
                </button>
                <button
                  disabled={active || pending || protectedLedger}
                  onClick={() => exportLedger("csv")}
                >
                  导出模拟明细（全部）
                </button>
                <button
                  disabled={active || pending || protectedLedger}
                  onClick={() => exportLedger("json")}
                >
                  导出完整账本
                </button>
              </>
            )}
          </div>
        </div>
        <p>
          {enabled
            ? `启用于 ${time(state.activatedAt)}。版本已锁定；当前页不提供改写历史条件。`
            : "启用时记录规则版本和时间。此前回测、旧筛选均不计入前瞻实绩。"}
        </p>
        <div className="daily-plans">
          {plans.map((p) => (
            <div key={p.id}>
              <h4>
                {p.name} · 持有{p.hold}日
              </h4>
              <p>
                {p.id.includes("short")
                  ? "涨幅1%–7%，换手率2%–15%，当日量/前5日均量≥1.2，偏离MA20≤3%。"
                  : "收盘价>MA20，MA5>MA20，MA20>MA60，偏离MA20≤12%。"}
              </p>
              <p className="hint">
                沪深A股，成交额≥2亿、股价≥3元，排除ST/无成交，按成交额取前100只。每边成本0.10%、滑点0.05%。
              </p>
              {p.ruleHash && (
                <details>
                  <summary>固定版本指纹</summary>
                  <code className="rule-hash">{p.ruleHash}</code>
                </details>
              )}
            </div>
          ))}
        </div>
        <p className="hint">
          {state?.schedule}{" "}
          关机、未登录或服务不可用期间可能漏跑，恢复后需检查；旧日期不会事后补买。交易日证据和休市来源见上方核验卡片。
        </p>
        {state?.job && (
          <div className="notice">
            <strong>
              {status[state.job.status]} · {state.job.phase}
            </strong>
            <p>
              已处理 {state.job.done}/{state.job.target} · 开始于{" "}
              {time(state.job.startedAt)}
            </p>
            <p>{state.job.note}</p>
            {active && (
              <>
                <progress value={state.job.done} max={state.job.target || 1} />
                <p>正在处理：{state.job.current || "等待行情返回"}</p>
              </>
            )}
            {!!state.job.issueCount && (
              <JobIssues state={state} refresh={refresh} />
            )}
          </div>
        )}
      </div>
      {enabled && (
        <>
          <div className="daily-plans">
            {state.stats.map((s) => (
              <div className="research-card" key={s.planId}>
                <h3>{plans.find((p) => p.id === s.planId)?.name}</h3>
                <div className="research-metrics">
                  {[
                    ["完成", s.count],
                    ["单次平均净收益", pct(s.average)],
                    ["净收益中位数", pct(s.median)],
                    ["最差单次", pct(s.worst)],
                    [
                      "盈利比例",
                      s.winRate == null ? "—" : s.winRate.toFixed(2) + "%",
                    ],
                  ].map(([k, v]) => (
                    <div key={k}>
                      <small>{k}</small>
                      <strong>{v}</strong>
                    </div>
                  ))}
                </div>
                <p>
                  待入场 {s.pending} · 模拟持有 {s.holding} · 跳过 {s.skipped} ·
                  数据问题 {s.errors} · 已退出股票数 {s.uniqueStocks}
                </p>
                <p className="notice">{s.assessment}</p>
                <p className="hint">
                  完成少于30笔、少于20只股票或不足3个入场月份时只显示样本不足；达到数量也不等于统计显著或稳定盈利。
                </p>
                {!!s.months.length && (
                  <details>
                    <summary>按入场月份的已完成信号</summary>
                    {s.months.map((m) => (
                      <p key={m.month}>
                        {m.month}：{m.count}笔 · 平均净变化 {pct(m.average)}
                      </p>
                    ))}
                    <p className="hint">
                      当月、未完成持仓及各月到期比例可能不同，不是完整月度组合收益。
                    </p>
                  </details>
                )}
              </div>
            ))}
          </div>
          <DailyArchive state={state} refresh={refresh} />
          <div className="research-card">
            <div className="split">
              <h3>模拟信号与持仓</h3>
              <div className="daily-buttons">
                <input
                  aria-label="搜索模拟股票"
                  placeholder="搜索名称或代码"
                  maxLength={80}
                  value={search}
                  onChange={(e) => {
                    setSearch(e.target.value);
                    setPage(1);
                  }}
                />
                <select
                  aria-label="模拟排序"
                  value={sort}
                  onChange={(e) => {
                    setSort(e.target.value);
                    setPage(1);
                  }}
                >
                  <option value="recent">最近登记</option>
                  <option value="net">净收益从高到低</option>
                  <option value="code">代码顺序</option>
                </select>
                <select
                  aria-label="模拟策略"
                  value={planId}
                  onChange={(e) => {
                    setPlanId(e.target.value);
                    setPage(1);
                  }}
                >
                  <option value="all">全部策略</option>
                  {plans.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
                <select
                  aria-label="模拟状态"
                  value={view}
                  onChange={(e) => {
                    setView(e.target.value);
                    setPage(1);
                  }}
                >
                  <option value="open">待入场 / 持有</option>
                  <option value="closed">已退出</option>
                  <option value="all">全部含跳过</option>
                </select>
              </div>
            </div>
            <p className="hint">
              浮动值按最新完成日线假设退出并扣两边费用；只在退出后进入已完成统计。价格均为当前整段前复权口径，持有中可随除权重标，已退出结果冻结。
            </p>
            {!result.data ? null : !tickets.length ? (
              <p className="empty">当前没有该状态的前瞻模拟记录。</p>
            ) : (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      {[
                        "股票 / 策略",
                        "信号 / 状态",
                        "入场 → 退出",
                        "已持有 / 目标",
                        "净收益 / 浮动",
                        "数据截至 / 问题",
                      ].map((x) => (
                        <th key={x}>{x}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {tickets.map((t) => (
                      <tr key={t.id}>
                        <td>
                          {t.name}
                          <small>
                            {t.code} ·{" "}
                            {plans.find((p) => p.id === t.planId)?.name}
                          </small>
                        </td>
                        <td>
                          {t.signalDate}
                          <small>{status[t.state]}</small>
                        </td>
                        <td>
                          {t.entryDate || "等待次有效日线"}
                          <small>→ {t.exitDate || "未退出"}</small>
                        </td>
                        <td>
                          {t.holdBars ?? "—"} / {t.hold}
                        </td>
                        <td>
                          {t.net != null
                            ? pct(t.net)
                            : t.markNet != null
                              ? `${pct(t.markNet)}（浮动）`
                              : "—"}
                        </td>
                        <td>
                          {t.asOf || "待更新"}
                          <small>{t.source || t.signalSource}</small>
                          <small className="error">{t.error || t.reason}</small>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <PageNav result={result} onPage={setPage} />
            <p className="hint">导出包含全部记录，不受当前筛选或页码影响。</p>
          </div>
        </>
      )}
      <details className="research-card">
        <summary>模拟规则与验证边界</summary>
        <p>{dailyMethod}</p>
        <p>
          开始日与每个信号实际登记时间均保留；每个有效日是有成交的日线，遇停牌等待。所选100只随每天的真实成交额排序变化，扫描范围以当天留档为准。单次统计不计算资金复利、仓位或组合最大回撤。
        </p>
      </details>
    </section>
  );
}
