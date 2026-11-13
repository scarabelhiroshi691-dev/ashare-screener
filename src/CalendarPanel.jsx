import React from "react";
import { time } from "./api";

const labels = {
  complete: "已处理",
  issues: "已处理，有失败",
  incomplete: "留档未完成",
  missed: "漏跑，未留档",
  closed: "休市",
  unverified: "日期待核验",
  awaiting: "等待盘后",
  due: "今日待运行",
  running: "今日运行中",
};
const checkpointLabels = {
  reported: "已有报告",
  due: "已到节点，待报告",
  pending: "尚未到节点",
  unverified: "计日待核验",
};
export default function CalendarPanel({ calendar: c, disabled, onRefresh }) {
  if (!c) return null;
  return (
    <div className="research-card calendar-card">
      <div className="split">
        <h3>交易日核验与复盘缺口</h3>
        <button disabled={disabled || !c.canRefresh} onClick={onRefresh}>
          {c.active ? "正在核验交易日…" : "核验交易日"}
        </button>
      </div>
      <p>
        {c.baseline ? (
          <>
            基准日 {c.baseline}（第0天） · 截至 {c.asOf || "待核验"}，
            {c.exact
              ? `已确认${c.count}个后续交易日`
              : `已找到${c.count}个开市日期，阶段计数待核验`}
            。{!c.baselineCovered && " 基准日缺少完成行情证据。"}
          </>
        ) : (
          "启用固定策略后开始核验日期。"
        )}
      </p>
      <div className="calendar-summary">
        <span>
          漏跑未留档 <strong>{c.missed.length}日</strong>
        </span>
        <span>
          留档未完成 <strong>{c.incomplete.length}日</strong>
        </span>
        <span>
          留档有失败 <strong>{c.issues.length}日</strong>
        </span>
        <span>
          日期待核验 <strong>{c.unverified.length}日</strong>
        </span>
      </div>
      {!!c.missed.length && (
        <p className="notice">
          已确认开市但没有每日记录：{c.missed.join("、")}
          。保留缺口，不补记过去的新信号。
        </p>
      )}
      {!!c.incomplete.length && (
        <p className="notice">
          留档尚有待处理：{c.incomplete.join("、")}。查看下方逐日记录。
        </p>
      )}
      {!!c.issues.length && (
        <p>
          已处理但含失败项：{c.issues.join("、")}
          。失败原因与是否可重试请看下方复盘明细。
        </p>
      )}
      {!!c.unverified.length && (
        <p className="notice">
          缺少完成行情或证据冲突：{c.unverified.join("、")}
          。不能把这些日期直接算作交易日或漏跑。
        </p>
      )}
      {(c.lastError || c.cacheError || c.planError) && (
        <p className="notice error" role="alert">
          {c.cacheError ||
            c.planError ||
            `最近一次请求提示（保留记录）：${c.lastError.message}。当前核验结果以上方计数和逐日依据为准。`}
        </p>
      )}
      <p className="hint">
        {c.source} · 最近成功核验 {time(c.checkedAt)}。
        {c.refreshReason || "核验仅更新日期证据，不刷新选股池或登记信号。"}
      </p>
      {!!c.checkpoints.length && (
        <p>
          {c.checkpoints
            .map(
              (p) =>
                `第${p.day}天：${checkpointLabels[p.status]}${p.dueDate ? `（${p.dueDate}）` : ""}`,
            )
            .join("；")}
          。原报告状态保留。
        </p>
      )}
      <details>
        <summary>逐日依据与休市来源</summary>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>日期</th>
                <th>复盘状态</th>
                <th>判定依据</th>
              </tr>
            </thead>
            <tbody>
              {c.dates.map((d) => (
                <tr key={d.date}>
                  <td>{d.date}</td>
                  <td>{labels[d.review]}</td>
                  <td>
                    {d.reason ||
                      d.evidence
                        .map(
                          (e) =>
                            `${e.kind === "index" ? "新浪指数完成日线" : `${e.source}完成快照`} · ${time(e.fetchedAt)}`,
                        )
                        .join("；")}
                    {d.pending > 0 && `；待处理${d.pending}只`}
                    {d.failed > 0 && `；失败${d.failed}只`}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="hint">
          周末不按调休工作日算开市。2026年节假日依据
          {c.holidaySources.map((s) => (
            <React.Fragment key={s.url}>
              {" "}
              ·{" "}
              <a href={s.url} target="_blank" rel="noreferrer">
                {s.name}
              </a>
            </React.Fragment>
          ))}
          。 未覆盖年份的工作日等待行情证据，不猜节假日。
        </p>
      </details>
    </div>
  );
}
