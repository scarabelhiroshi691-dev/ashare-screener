import React, { useState } from "react";
import { api, pct, time } from "./api";
import { useViewStatus, useViewRows, PageNav } from "./paged-view";

const labels = {
  pending: "待入场",
  holding: "持有",
  "exit-wait": "待退出",
  closed: "已退出",
  skipped: "跳过",
  missing: "记录缺失",
};
const deliveryLabels = {
  none: "尚未准备",
  "legacy-recorded": "历史已报告（沿用旧记录）",
  pending: "已准备，待聊天通知",
  claimed: "已领取，待交付确认；中断需核对聊天",
  delivered: "已确认聊天交付",
};
function Metrics({ groups }) {
  return (
    <div className="table-scroll">
      <table className="data-table" style={{ minWidth: 800 }}>
        <thead>
          <tr>
            {[
              "策略／持有期",
              "总数／完成",
              "平均净收益",
              "中位数",
              "盈利比例",
              "最差／最好",
              "未成熟",
              "缺数／延期",
            ].map((x) => (
              <th key={x}>{x}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {groups.map((g) => (
            <tr key={g.planId}>
              <td>
                {g.name}
                <br />
                {g.hold}根有效日线
              </td>
              <td>
                {g.total}／{g.completed}
              </td>
              <td>{pct(g.average)}</td>
              <td>{pct(g.median)}</td>
              <td>{pct(g.winRate)}</td>
              <td>
                {pct(g.worst)}／{pct(g.best)}
              </td>
              <td>{g.unfinished}</td>
              <td>
                {g.missing}／{g.delayed}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
function TicketDetails({ cohort, version, refresh }) {
  const [filter, setFilter] = useState("all"),
    [page, setPage] = useState(1),
    [open, setOpen] = useState(false);
  const count = cohort.groups.reduce((sum, g) => sum + g.total, 0);
  const result = useViewRows(
    "reports",
    open && version,
    { cohort: cohort.key, filter, page },
    refresh,
  );
  const shown = result.data?.rows || [];
  return (
    <details onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary>逐股入退日期、收益和未完成原因（{count}条）</summary>
      {open && (
        <>
          <label>
            明细范围{" "}
            <select
              aria-label="批次明细范围"
              value={filter}
              onChange={(e) => {
                setFilter(e.target.value);
                setPage(1);
              }}
            >
              <option value="all">全部</option>
              <option value="open">未成熟</option>
              <option value="issues">缺数／延期／跳过</option>
            </select>
          </label>
          <p>
            显示{shown.length}
            条；缺数和延期可与持仓状态重叠。净收益“—”表示未纳入已完成统计。
          </p>
          <div className="table-scroll">
            <table className="data-table" style={{ minWidth: 880 }}>
              <thead>
                <tr>
                  {[
                    "股票／策略",
                    "状态",
                    "入场／退出",
                    "有效日线",
                    "净收益",
                    "数据截至",
                    "问题",
                  ].map((x) => (
                    <th key={x}>{x}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {shown.map((t) => (
                  <tr key={t.id}>
                    <td>
                      {t.name} {t.code}
                      <br />
                      {t.planName}
                    </td>
                    <td>
                      {labels[t.state] || t.state}
                      {t.delayed ? " · 延期" : ""}
                    </td>
                    <td>
                      {t.entryDate || "—"}
                      <br />
                      {t.exitDate || "—"}
                    </td>
                    <td>
                      {t.holdBars ?? "—"}／{t.hold}
                    </td>
                    <td>{pct(t.net)}</td>
                    <td>
                      {t.asOf || "—"}
                      <br />
                      {t.source || ""}
                    </td>
                    <td>{t.reason || "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <PageNav result={result} onPage={setPage} />
        </>
      )}
    </details>
  );
}
export default function ReportsPanel({ disabled }) {
  const { state, error: pollError, refresh } = useViewStatus("reports");
  const [error, setError] = useState(""),
    [pending, setPending] = useState(false),
    [issuesOpen, setIssuesOpen] = useState(false),
    [issuePage, setIssuePage] = useState(1);
  const issues = useViewRows(
    "reports",
    issuesOpen && state?.version,
    { type: "issues", page: issuePage },
    refresh,
  );
  async function prepare() {
    setPending(true);
    try {
      await api("daily/reports/prepare", {});
      await refresh();
      setError("");
    } catch (e) {
      setError(e.message);
    } finally {
      setPending(false);
    }
  }
  const a = state?.analysis;
  return (
    <div className="research-card reports-card" style={{ minWidth: 0 }}>
      <div className="split">
        <h3>批次对比与阶段报告</h3>
        <button disabled={disabled || pending || state?.busy} onClick={prepare}>
          {pending ? "正在核对…" : "检查阶段报告"}
        </button>
      </div>
      {(error || pollError || state?.error) && (
        <p role="alert" className="notice error">
          {error || pollError || state.error}
        </p>
      )}
      {!state && !error && <p>正在读取批次与阶段状态…</p>}
      {state?.notice && <p className="notice">{state.notice}</p>}
      {state && (
        <>
          <p>
            截至 {state.calendar.asOf || "待核验"} ·{" "}
            {state.calendar.exact
              ? `已核验${state.calendar.count}个后续交易日`
              : "交易日计数待核验"}
            。检查仅准备已到期报告，不运行选股或改写模拟信号。
          </p>
          <div className="table-scroll">
            <table className="data-table" style={{ minWidth: 660 }}>
              <thead>
                <tr>
                  <th>节点</th>
                  <th>应到日期／实际截至</th>
                  <th>报告与通知</th>
                  <th>文件</th>
                </tr>
              </thead>
              <tbody>
                {state.stages.map((s) => (
                  <tr key={s.day}>
                    <td>第{s.day}交易日</td>
                    <td>
                      {s.dueDate || "待行情确认"}
                      <br />
                      {s.asOf || "—"}
                    </td>
                    <td>
                      {s.status === "pending"
                        ? s.due
                          ? "已到节点，待复盘结束后准备"
                          : "尚未到节点"
                        : deliveryLabels[s.delivery.status]}
                      {s.preparedAt && (
                        <>
                          <br />
                          准备：{time(s.preparedAt)}
                        </>
                      )}
                      {s.delivery.deliveredAt && (
                        <>
                          <br />
                          确认交付：{time(s.delivery.deliveredAt)}
                        </>
                      )}
                    </td>
                    <td>
                      {s.url ? (
                        <a href={s.url} target="_blank" rel="noreferrer">
                          查看第{s.day}天报告
                        </a>
                      ) : (
                        "—"
                      )}
                      {s.snapshotUrl && (
                        <>
                          <br />
                          <a
                            href={s.snapshotUrl}
                            target="_blank"
                            rel="noreferrer"
                          >
                            查看账本与证据快照
                          </a>
                        </>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="hint">
            {state.notificationRule}{" "}
            本机服务负责准备报告；Codex未运行时不能保证聊天通知。
          </p>
        </>
      )}
      {a && (
        <>
          <p className="notice">{a.limitations}</p>
          {a.cohorts.map((c) => (
            <section key={c.key} style={{ marginTop: 20 }}>
              <h4>
                {c.label} · 信号日 {c.date}
              </h4>
              <Metrics groups={c.groups} />
              <p>{c.conclusion}</p>
              <TicketDetails
                cohort={c}
                version={state.version}
                refresh={refresh}
              />
            </section>
          ))}
          <details style={{ marginTop: 20 }}>
            <summary>累计完成与按入场周统计</summary>
            <Metrics groups={a.totals} />
            {a.weeks.map((w) => (
              <section key={w.key}>
                <h4>入场周（周一）：{w.date}</h4>
                <Metrics groups={w.groups} />
              </section>
            ))}
          </details>
          <details
            style={{ marginTop: 16 }}
            onToggle={(e) => setIssuesOpen(e.currentTarget.open)}
          >
            <summary>
              每日筛选失败／待处理（{a.issueCount}项，含历史留档）
            </summary>
            <p>
              筛选失败与已登记模拟持仓的缺数分开；同一股票不同策略／日期可分别出现。
            </p>
            <ul>
              {issues.data?.rows.map((i, n) => (
                <li key={n}>
                  {i.date} ·{" "}
                  {a.totals.find((g) => g.planId === i.planId)?.name ||
                    i.planId}{" "}
                  · {i.name} {i.code}：{i.reason}。{i.retry}。
                </li>
              ))}
            </ul>
            {issuesOpen && <PageNav result={issues} onPage={setIssuePage} />}
          </details>
        </>
      )}
    </div>
  );
}
