import React, { useState } from "react";
import { useViewRows, PageNav } from "./paged-view";

export function JobIssues({ state, refresh }) {
  const [open, setOpen] = useState(false),
    [page, setPage] = useState(1);
  const result = useViewRows(
    "daily",
    open && state.version,
    { type: "job-issues", page },
    refresh,
  );
  return (
    <details onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary>本次问题（{state.job.issueCount}）</summary>
      {open && (
        <>
          {result.data?.rows.map((e, i) => (
            <p key={i}>
              {e.symbol}：{e.message}
            </p>
          ))}
          <PageNav result={result} onPage={setPage} />
        </>
      )}
    </details>
  );
}

const itemLabels = {
  matched: "入选",
  unmatched: "未通过",
  failed: "失败",
  pending: "待处理",
  running: "处理中",
};
function DayItems({ selection, state, refresh, planName }) {
  const [filter, setFilter] = useState("all"),
    [page, setPage] = useState(1),
    [search, setSearch] = useState("");
  const result = useViewRows(
    "daily",
    state.version,
    {
      type: "day-items",
      date: selection.date,
      plan: selection.planId,
      filter,
      page,
      q: search,
    },
    refresh,
  );
  return (
    <section>
      <h4>
        {selection.date} · {planName(selection.planId)}逐股结果
      </h4>
      <div className="daily-buttons">
        <input
          aria-label="搜索复盘股票"
          placeholder="搜索名称或代码"
          maxLength={80}
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            setPage(1);
          }}
        />
        <select
          aria-label="复盘明细范围"
          value={filter}
          onChange={(e) => {
            setFilter(e.target.value);
            setPage(1);
          }}
        >
          <option value="all">全部扫描股票</option>
          {Object.entries(itemLabels)
            .filter(([k]) => k !== "running")
            .map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
        </select>
      </div>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>股票</th>
              <th>结果</th>
              <th>依据或问题</th>
            </tr>
          </thead>
          <tbody>
            {result.data?.rows.map((i) => (
              <tr key={i.symbol}>
                <td>
                  {i.name}
                  <small>{i.code}</small>
                </td>
                <td>
                  {itemLabels[i.state]}
                  {i.state === "matched" && (
                    <small>{i.ticketId ? "新增模拟" : "已有重叠信号"}</small>
                  )}
                </td>
                <td>
                  {i.error ||
                    (i.checks || [])
                      .filter((c) => i.state === "matched" || !c.pass)
                      .map((c) => c.label + " " + c.detail)
                      .join("；") ||
                    "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <PageNav result={result} onPage={setPage} />
    </section>
  );
}

export default function DailyArchive({ state, refresh }) {
  const [page, setPage] = useState(1),
    [selected, setSelected] = useState(null);
  const result = useViewRows(
    "daily",
    state.version,
    { type: "days", page },
    refresh,
  );
  const planName = (id) => state.plans.find((p) => p.id === id)?.name || id;
  return (
    <div className="research-card">
      <h3>每日复盘留档</h3>
      <p className="hint">
        每行是一套策略。点击“逐股结果”查看该日的入选、未通过、失败与待处理。完整账本导出包含所有留档和信号。
      </p>
      {!state.dayCount ? (
        <p className="empty">等待首次复盘。</p>
      ) : (
        <>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  {[
                    "日期／策略",
                    "行情覆盖",
                    "基础池／扫描",
                    "入选／新增",
                    "未通过",
                    "失败／待处理",
                    "明细",
                  ].map((x) => (
                    <th key={x}>{x}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {result.data?.rows.map((p) => (
                  <tr key={p.date + p.planId}>
                    <td>
                      {p.date}
                      <small>{planName(p.planId)}</small>
                    </td>
                    <td>{p.coverage}</td>
                    <td>
                      {p.baseCount}／{p.scanned}
                      <small>上限外{p.notScanned}</small>
                    </td>
                    <td>
                      {p.matched}／{p.added}
                    </td>
                    <td>{p.unmatched}</td>
                    <td>
                      {p.failed}／{p.pending}
                    </td>
                    <td>
                      <button
                        aria-label={
                          p.date + " " + planName(p.planId) + " 逐股结果"
                        }
                        onClick={() => setSelected(p)}
                      >
                        逐股结果
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <PageNav result={result} onPage={setPage} />
          {selected && (
            <DayItems
              key={selected.date + selected.planId}
              selection={selected}
              state={state}
              refresh={refresh}
              planName={planName}
            />
          )}
        </>
      )}
    </div>
  );
}
