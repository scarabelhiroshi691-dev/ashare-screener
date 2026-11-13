import React from "react";
import { time } from "./api";
const labels = {
  disabled: "尚未启用",
  protected: "自动调度保护中",
  running: "执行中",
  "waiting-job": "已预约，等待让行",
  ready: "等待自动检查启动",
  cooldown: "等待冷却",
  "attempt-limit": "达到自动补跑上限",
  "needs-attention": "需要检查",
  "user-paused": "本次已手动停止",
  complete: "已完成",
  issues: "已处理，存在数据问题",
  closed: "休市观察中",
  "waiting-window": "等待盘后窗口",
  partial: "完成，存在失败",
  stopped: "已停止",
  interrupted: "中断后恢复",
  waiting: "等待数据",
};
export default function ExecutionPanel({ execution: e }) {
  if (!e) return null;
  return (
    <div className="research-card">
      <div className="split">
        <h3>每日执行与恢复状态</h3>
        <strong>{labels[e.status] || e.status}</strong>
      </div>
      <p role="status">{e.reason}</p>
      <p>
        最近已核验应执行日：{e.lastDueDate || "待核验"} · 最近检查：
        {time(e.lastCheckedAt)}
      </p>
      <p>
        下一次计划检查：{time(e.nextCheckAt)}（以开市行情为准）。
        {e.nextRetryAt && <>下一次允许补跑：{time(e.nextRetryAt)}。</>}
      </p>
      {e.actualJob && (
        <p>
          最近任务：{time(e.actualJob.startedAt)} 启动 ·{" "}
          {e.actualJob.recoveredAt
            ? `终止时间未知，${time(e.actualJob.recoveredAt)}发现上次中断`
            : e.actualJob.finishedAt
              ? `${time(e.actualJob.finishedAt)}结束`
              : "尚未结束"}
          。{e.actualJob.note}
        </p>
      )}
      {e.trendYield && (
        <p className="notice">
          趋势让行：{e.trendYield.reason}。
          {e.trendYield.pausedAt
            ? `已于${time(e.trendYield.pausedAt)}保存暂停`
            : "正在等待当前股票保存，不强行中断请求"}
          。
        </p>
      )}
      {e.error && (
        <p className="notice error" role="alert">
          {e.error}
        </p>
      )}
      <details>
        <summary>执行记录与恢复依据</summary>
        <p className="hint">
          本次服务启动：{time(e.serviceStartedAt)}
          。运行前保存执行身份，重启核对终态；未确认结束的执行不冒充完成。盘前或跨日恢复只推进已有信号。
        </p>
        {e.attempts.length ? (
          e.attempts
            .slice()
            .reverse()
            .map((a) => (
              <p key={a.id}>
                {a.target} · {a.kind === "daily" ? "盘后复盘" : "仅推进旧信号"}{" "}
                · {labels[a.status] || a.status} ·{time(a.startedAt)} 预约 ·{" "}
                {a.actualStartedAt
                  ? `${time(a.actualStartedAt)}启动`
                  : "尚未确认实际启动"}{" "}
                ·{" "}
                {a.finishedAt ? `${time(a.finishedAt)}结束` : "结束时间未确认"}
                {a.reason ? `；${a.reason}` : ""}
              </p>
            ))
        ) : (
          <p>尚无新版调度执行；上方显示原任务实际记录。</p>
        )}
        {e.events
          .slice()
          .reverse()
          .map((x, i) => (
            <p className="hint" key={`${x.at}-${i}`}>
              {time(x.at)} · {x.reason}
            </p>
          ))}
      </details>
      <p className="hint">
        16:20后每日复盘优先。长趋势在当前股票保存后让行，正常完成后续跑原队列；手动停止、进程重启或保护状态下保留人工续跑。关机或未登录仍可能漏跑，过去信号不补记。
      </p>
    </div>
  );
}
