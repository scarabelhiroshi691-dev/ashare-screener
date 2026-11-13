import React, { useState } from "react";
import { fmt, time } from "./api";
import {
  downloadView,
  PageNav,
  useViewRows,
  useViewStatus,
} from "./paged-view";

const labels = {
  matched: "符合",
  unmatched: "未通过",
  failed: "数据失败",
  pending: "待处理",
  outside: "未扫描",
};
const transitions = {
  added: "新增",
  retained: "保留",
  removed: "跌出",
  unknown: "无法判定",
};
const sameRules = (a, b) =>
  a?.ruleVersion === b?.ruleVersion &&
  JSON.stringify(a?.config) === JSON.stringify(b?.config);
const optionLabel = (e) => `${e.date} · ${e.target}只 · ${time(e.finishedAt)}`;
function Evidence({ item }) {
  return (
    <>
      {labels[item.state] || item.state}
      {item.source && <small>{item.source}</small>}
      {item.error && <small className="error">{item.error}</small>}
      {item.checks?.length > 0 && (
        <details>
          <summary>条件依据（{item.checks.length}项）</summary>
          {item.checks.map((c, i) => (
            <p key={i}>
              {c.pass ? "✓ " : "未过："}
              {c.label}
              <small>{c.detail}</small>
              {Number.isFinite(c.value) && Number.isFinite(c.threshold) && (
                <small>实测－阈值 {fmt(c.value - c.threshold)}</small>
              )}
            </p>
          ))}
        </details>
      )}
    </>
  );
}
function ArchiveRows({ version, refresh, entry, older }) {
  const comparing = !!older;
  const choices = comparing ? transitions : labels;
  const [type, setType] = useState(comparing ? "retained" : "matched"),
    [page, setPage] = useState(1),
    [q, setQ] = useState("");
  const params = comparing
    ? { older: older.id, newer: entry.id, type, page, q }
    : { id: entry.id, type, page, q };
  const result = useViewRows("archive", version, params, refresh);
  const summary = result.data?.summary;
  return (
    <>
      {summary && (
        <>
          <p>
            较早 {summary.olderDate} → 较晚 {summary.newerDate}。共同扫描{" "}
            {summary.common} 只，早期独有 {summary.olderOnly} 只，晚期独有{" "}
            {summary.newerOnly} 只。
          </p>
          {summary.poolChanged && (
            <p className="notice">
              两期实际扫描池不同。共同股票有两次有效判定时才比较；单期入选但另一期未扫描的股票列入“无法判定”。
            </p>
          )}
          {!!summary.gaps.length && (
            <p className="notice">
              两期之间有缺档或日期待核验：
              {summary.gaps
                .map((g) =>
                  g.count === null ? "间隔超过一年" : g.dates.join("、"),
                )
                .join("；")}
              。仍可对照两期，连续符合次数在缺口处中断。
            </p>
          )}
        </>
      )}
      <div className="daily-buttons">
        <select
          aria-label={comparing ? "趋势比较分类" : "趋势档案分类"}
          value={type}
          onChange={(e) => {
            setType(e.target.value);
            setPage(1);
          }}
        >
          {Object.entries(choices)
            .filter(([k]) => k !== "outside")
            .map(([k, v]) => (
              <option key={k} value={k}>
                {v} {comparing ? (summary?.counts[k] ?? "") : entry.counts[k]}
              </option>
            ))}
        </select>
        <input
          aria-label="搜索档案股票"
          placeholder="搜索名称或代码"
          maxLength={80}
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setPage(1);
          }}
        />
      </div>
      {result.data?.rows.length > 0 && (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>股票</th>
                {comparing ? (
                  <>
                    <th>较早判定</th>
                    <th>较晚判定</th>
                    <th>连续符合次数</th>
                  </>
                ) : (
                  <>
                    <th>判定及依据</th>
                    <th>趋势评分</th>
                  </>
                )}
              </tr>
            </thead>
            <tbody>
              {result.data.rows.map((row) => (
                <tr key={row.symbol}>
                  <td>
                    {row.name}
                    <small>{row.code}</small>
                  </td>
                  {comparing ? (
                    <>
                      <td>
                        <Evidence item={row.before} />
                      </td>
                      <td>
                        <Evidence item={row.after} />
                      </td>
                      <td>{row.streak || "—"}</td>
                    </>
                  ) : (
                    <>
                      <td>
                        <Evidence item={row} />
                      </td>
                      <td>{fmt(row.score, 1)}</td>
                    </>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {result.data?.total === 0 && <p>该分类无记录。</p>}
      <PageNav result={result} onPage={setPage} />
    </>
  );
}
function ArchiveContent() {
  const { state, error, refresh } = useViewStatus("archive");
  const [id, setId] = useState(""),
    [olderId, setOlderId] = useState(""),
    [exportError, setExportError] = useState("");
  const entries = state?.entries || [];
  const entry = entries.find((e) => e.id === id) || entries[0];
  const prior = entries.filter(
    (e) =>
      entry?.comparable &&
      e.comparable &&
      e.date < entry.date &&
      sameRules(e, entry),
  );
  const older = prior.find((e) => e.id === olderId);
  async function exportArchive() {
    setExportError("");
    try {
      await downloadView("archive", state.version, "json", { id: entry.id });
    } catch (e) {
      setExportError(e.message);
      if (e.status === 409) refresh();
    }
  }
  return (
    <div>
      {(error || state?.error || exportError) && (
        <p className="notice error" role="alert">
          {error || state?.error || exportError}
        </p>
      )}
      {!state && <p>正在读取趋势档案…</p>}
      {state && (
        <p>
          已保存 {entries.length}／{state.maxFiles} 份 ·{" "}
          {fmt(state.bytes / 1024 ** 2, 1)}／{state.maxBytes / 1024 ** 2}{" "}
          MiB。达到容量上限时保留原档。
        </p>
      )}
      {entry && (
        <>
          <div className="daily-buttons">
            <label>
              查看档案{" "}
              <select
                aria-label="较晚趋势档案"
                value={entry.id}
                onChange={(e) => {
                  setId(e.target.value);
                  setOlderId("");
                }}
              >
                {entries.map((e) => (
                  <option key={e.id} value={e.id}>
                    {optionLabel(e)}
                  </option>
                ))}
              </select>
            </label>
            <button onClick={exportArchive}>导出该期完整档案</button>
          </div>
          <p>
            数据截至 {entry.date} · 基础池 {entry.baseCount} · 扫描{" "}
            {entry.target} · 快照采集 {time(entry.snapshotFetchedAt)}
          </p>
          <details>
            <summary>原参数与分类数量</summary>
            <p>
              {Object.entries(entry.counts)
                .map(([k, n]) => labels[k] + " " + n)
                .join(" · ")}
            </p>
            <pre style={{ whiteSpace: "pre-wrap" }}>
              {JSON.stringify(entry.config, null, 2)}
            </pre>
          </details>
          <label>
            比较较早档案{" "}
            <select
              aria-label="较早趋势档案"
              value={older?.id || ""}
              onChange={(e) => setOlderId(e.target.value)}
              disabled={!prior.length}
            >
              <option value="">只查看本期</option>
              {prior.map((e) => (
                <option key={e.id} value={e.id}>
                  {optionLabel(e)}
                </option>
              ))}
            </select>
          </label>
          {!prior.length && (
            <p>
              暂无较早的同条件完整档案。需要另一期符合相同规则和范围参数的扫描才能比较。
            </p>
          )}
          {older && (
            <p className="hint">
              连续符合按不同日期的可比归档计数，遇缺档、未扫描、失败或不符合即中断。
            </p>
          )}
          <ArchiveRows
            key={entry.id + ":" + older?.id}
            version={state.version}
            refresh={refresh}
            entry={entry}
            older={older}
          />
        </>
      )}
      {state && !entry && <p>暂未保存趋势档案。</p>}
    </div>
  );
}
export default function TrendArchivePanel() {
  const [open, setOpen] = useState(false);
  return (
    <details
      className="trend-method"
      onToggle={(e) => setOpen(e.currentTarget.open)}
    >
      <summary>趋势档案与连续性比较</summary>
      {open && <ArchiveContent />}
    </details>
  );
}
