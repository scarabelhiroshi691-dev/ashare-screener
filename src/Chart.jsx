import React from "react";
import { fmt } from "./api";
export default function Chart({ bars = [], trend = false }) {
  if (!bars.length) return <div className="empty">暂无完成日线</div>;
  const w = 400,
    h = 250,
    p = 20,
    lo = Math.min(
      ...bars.map((b) =>
        Math.min(
          b.low,
          b.ma20 ?? b.low,
          ...(trend ? [b.ma60 ?? b.low, b.ma120 ?? b.low] : []),
        ),
      ),
    ),
    hi = Math.max(
      ...bars.map((b) =>
        Math.max(
          b.high,
          b.ma20 ?? b.high,
          ...(trend ? [b.ma60 ?? b.high, b.ma120 ?? b.high] : []),
        ),
      ),
    ),
    span = hi - lo || 1;
  const y = (v) => p + ((hi - v) / span) * 175,
    x = (i) => p + ((i + 0.5) * (w - 2 * p)) / bars.length,
    bw = Math.max(1, ((w - 2 * p) / bars.length) * 0.65),
    vol = Math.max(...bars.map((b) => b.volume), 1);
  return (
    <svg
      viewBox={`0 0 ${w} ${h + 30}`}
      role="img"
      aria-label={
        trend
          ? "前复权日K线与MA20、MA60、MA120，红涨绿跌"
          : "前复权日 K 线，红涨绿跌，蓝色 MA5，橙色 MA20"
      }
    >
      {[0, 0.5, 1].map((t) => (
        <g key={t}>
          <line
            x1={p}
            x2={w - p}
            y1={p + 175 * t}
            y2={p + 175 * t}
            stroke="#e9edf2"
          />
          <text x={p} y={p + 175 * t - 4} className="axis">
            {fmt(hi - span * t)}
          </text>
        </g>
      ))}
      {bars.map((b, i) => (
        <g
          key={b.date}
          fill={b.close >= b.open ? "#d75454" : "#27866a"}
          stroke={b.close >= b.open ? "#d75454" : "#27866a"}
        >
          <title>
            {b.date} 开 {b.open} 收 {b.close} 高 {b.high} 低 {b.low} 成交量{" "}
            {b.volume} 股
          </title>
          <line x1={x(i)} x2={x(i)} y1={y(b.high)} y2={y(b.low)} />
          <rect
            x={x(i) - bw / 2}
            y={Math.min(y(b.open), y(b.close))}
            width={bw}
            height={Math.max(1, Math.abs(y(b.open) - y(b.close)))}
          />
          <rect
            x={x(i) - bw / 2}
            y={h - (b.volume / vol) * 35}
            width={bw}
            height={(b.volume / vol) * 35}
          />
        </g>
      ))}
      {(trend ? ["ma20", "ma60", "ma120"] : ["ma5", "ma20"]).map((key, j) => (
        <polyline
          key={key}
          fill="none"
          stroke={
            trend
              ? ["#9a641a", "#7656b8", "#546575"][j]
              : j
                ? "#ed9b34"
                : "#2d64e3"
          }
          strokeWidth="1.5"
          points={bars
            .map((b, i) =>
              !Number.isFinite(b[key]) ? null : `${x(i)},${y(b[key])}`,
            )
            .filter(Boolean)
            .join(" ")}
        />
      ))}
      <text x={p} y={h + 20} className="axis">
        {bars[0].date}
      </text>
      <text x={w - p} y={h + 20} textAnchor="end" className="axis">
        {bars.at(-1).date}
      </text>
    </svg>
  );
}
