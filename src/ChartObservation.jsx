import React from "react";
import { fmt, pct } from "./api";

export default function ChartObservation({ observation, asOf }) {
  return (
    <section className="chart-observation" aria-label="20 日线与回踩观察">
      <h4>20 日线与回踩观察</h4>
      {observation ? (
        <>
          <p className="hint">截至 {observation.date} · 完成日线 · 形态观察</p>
          <dl>
            <dt>收盘距 MA20</dt>
            <dd>{pct(observation.closeDistance)}</dd>
            <dt>MA5 距 MA20</dt>
            <dd>{pct(observation.ma5Distance)}</dd>
            <dt>MA20 较前 5 根</dt>
            <dd>{pct(observation.ma20Change)}</dd>
            <dt>最低价距 MA20</dt>
            <dd>{pct(observation.lowDistance)}</dd>
            <dt>当日量 / 前 5 日均量</dt>
            <dd>
              {observation.volumeRatio === null
                ? "—"
                : fmt(observation.volumeRatio) + " 倍"}
            </dd>
            <dt>前 5 根内最近上穿</dt>
            <dd>
              {observation.hasCrossHistory
                ? observation.crossDate || "未观察到"
                : "历史不足"}
            </dd>
            {observation.crossDate && (
              <>
                <dt>上穿后最低价</dt>
                <dd>
                  {observation.held === null
                    ? "数据不足"
                    : observation.held
                      ? "始终未破 MA20"
                      : "曾跌破 MA20"}
                </dd>
              </>
            )}
          </dl>
          {observation.retest && (
            <p className="chart-observation-match">符合缩量回踩观察条件</p>
          )}
          <details>
            <summary>查看观察口径</summary>
            <p className="hint">
              前 5 根内收盘从 MA20 下方或线上上穿。此后各日最低价守住 MA20，
              截止日最低价距线 0%–2%，成交量低于前 5 日均量，且 MA20 较前 5
              根持平或抬升。
            </p>
          </details>
        </>
      ) : (
        <p className="hint">缺少 {asOf} 的完成日线或 20 日均线，暂无法判断。</p>
      )}
    </section>
  );
}
