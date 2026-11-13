import React, { useRef, useState } from "react";
import {
  createPreferenceBackup,
  MAX_PREFERENCE_BYTES,
  MAX_STRATEGIES,
  MAX_WATCH,
  preparePreferenceImport,
  previewPreferences,
  readPreferenceStore,
} from "./preferences.js";
import { time } from "./api";
import { chinaClock } from "../shared/time.js";

const titles = {
  strategy: "策略类型",
  board: "股票范围",
  minAmountYi: "最低成交额",
  minPrice: "最低股价",
  maxScan: "扫描上限",
  excludeST: "排除 ST",
  excludeInactive: "排除停牌",
  priceAboveMa20: "收盘价高于 MA20",
  ma5AboveMa20: "MA5 高于 MA20",
  ma20AboveMa60: "MA20 高于 MA60",
  breakout20: "突破前20日高点",
  minChange: "涨幅下限",
  maxChange: "涨幅上限",
  minTurnover: "换手下限",
  maxTurnover: "换手上限",
  minVolumeRatio: "量比下限",
  useRsi: "启用 RSI",
  minRsi: "RSI 下限",
  maxRsi: "RSI 上限",
  useBias: "启用偏离限制",
  maxBias: "MA20 偏离上限",
  useVolume: "启用量能条件",
};
const display = (x) =>
  typeof x === "boolean"
    ? x
      ? "开启"
      : "关闭"
    : ({
        swing: "波段",
        short: "短线",
        all: "沪深 A 股",
        main: "主板",
        growth: "创业板",
        star: "科创板",
      }[x] ?? String(x));
const count = (rows, action) => rows.filter((x) => x.action === action).length;

function PreviewList({ rows, kind }) {
  const [page, setPage] = useState(0);
  const pages = Math.max(1, Math.ceil(rows.length / 20)),
    current = Math.min(page, pages - 1);
  return (
    <details>
      <summary>
        {kind === "watch" ? "自选明细" : "策略明细"}（{rows.length} 条）
      </summary>
      {rows
        .slice(current * 20, (current + 1) * 20)
        .map(({ item, action, name, existingName, differences }) => (
          <div key={item.symbol || item.name}>
            <p>
              {item.code && <strong>{item.code} </strong>}
              {item.name} ·{" "}
              {action === "add"
                ? "新增"
                : action === "rename"
                  ? "保留本机策略，导入为「" + name + "」"
                  : kind === "watch"
                    ? "已存在，保留「" + existingName + "」"
                    : "已存在「" + name + "」，跳过"}
            </p>
            {differences?.length > 0 && (
              <ul>
                {differences.map((d) => (
                  <li key={d.key}>
                    {titles[d.key]} {display(d.before)} → {display(d.after)}
                  </li>
                ))}
              </ul>
            )}
            {item.config && action !== "skip" && (
              <details>
                <summary>查看导入参数</summary>
                <ul>
                  {Object.entries(item.config).map(([key, value]) => (
                    <li key={key}>
                      {titles[key]} {display(value)}
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </div>
        ))}
      {pages > 1 && (
        <div className="daily-buttons">
          <span>
            第 {current + 1}／{pages} 页
          </span>
          <button disabled={current === 0} onClick={() => setPage(current - 1)}>
            上一页
          </button>
          <button
            disabled={current === pages - 1}
            onClick={() => setPage(current + 1)}
          >
            下一页
          </button>
        </div>
      )}
    </details>
  );
}

export default function SettingsPanel({ preferences }) {
  const { data, error: storeError, restore } = preferences;
  const [draft, setDraft] = useState(null),
    [error, setError] = useState(""),
    [message, setMessage] = useState("");
  const [reading, setReading] = useState(false),
    [applying, setApplying] = useState(false);
  const request = useRef(0),
    draftKey = useRef(0);
  async function choose(file) {
    if (!file) return;
    const id = ++request.current;
    setDraft(null);
    setError("");
    setMessage("");
    setReading(true);
    try {
      if (file.size > MAX_PREFERENCE_BYTES) throw Error("偏好文件超过 4 MiB");
      const text = await file.text();
      if (id !== request.current) return;
      const prepared = preparePreferenceImport(localStorage, text);
      setDraft({ ...prepared, fileName: file.name, key: ++draftKey.current });
    } catch (e) {
      if (id === request.current) setError(e.message);
    } finally {
      if (id === request.current) setReading(false);
    }
  }
  function repreview() {
    setError("");
    try {
      const current = readPreferenceStore(localStorage);
      setDraft({
        ...draft,
        source: current.source,
        preview: previewPreferences(current.data, draft.incoming),
        key: ++draftKey.current,
      });
    } catch (e) {
      setError(e.message);
    }
  }
  function exportFile() {
    setError("");
    try {
      const current = readPreferenceStore(localStorage).data;
      const text = createPreferenceBackup(current);
      const blob = new Blob([text], { type: "application/json;charset=utf-8" });
      if (blob.size > MAX_PREFERENCE_BYTES) throw Error("偏好文件超过 4 MiB");
      const url = URL.createObjectURL(blob),
        a = document.createElement("a");
      a.href = url;
      a.download = "ashare-preferences-" + chinaClock().date + ".json";
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) {
      setError(e.message);
    }
  }
  async function apply() {
    setApplying(true);
    setError("");
    try {
      await restore(draft);
      const p = draft.preview;
      setMessage(
        "恢复完成。新增自选 " +
          count(p.watch, "add") +
          " 条，导入策略 " +
          (count(p.strategies, "add") + count(p.strategies, "rename")) +
          " 套。",
      );
      setDraft(null);
    } catch (e) {
      setError(e.message);
    } finally {
      setApplying(false);
    }
  }
  const p = draft?.preview;
  return (
    <section className="daily-panel">
      <div className="research-card">
        <h2>自选与命名策略备份</h2>
        <p>
          导出 JSON
          文件可在另一浏览器恢复自选和命名策略。导入只合并本机偏好，盘后固定策略由独立账本管理。
        </p>
        <p>
          本机自选 {data.watch.length}／{MAX_WATCH} 条 · 命名策略{" "}
          {data.strategies.length}／{MAX_STRATEGIES} 套
        </p>
        <div className="daily-buttons">
          <button disabled={!!storeError || applying} onClick={exportFile}>
            导出本机偏好
          </button>
          <label>
            选择备份文件{" "}
            <input
              type="file"
              accept=".json,application/json"
              aria-label="选择偏好备份文件"
              disabled={!!storeError || applying}
              onChange={(e) => {
                const f = e.target.files?.[0];
                e.target.value = "";
                choose(f);
              }}
            />
          </label>
        </div>
        {(error || storeError) && (
          <p className="notice error" role="alert">
            {error || storeError}
          </p>
        )}
        {reading && <p role="status">正在验证文件…</p>}
        {message && <p role="status">{message}</p>}
      </div>
      {p && (
        <div className="research-card" key={draft.key}>
          <h3>导入预览</h3>
          <p>
            {draft.fileName} · 导出时间 {time(draft.incoming.exportedAt)}
          </p>
          <p>
            自选新增 {count(p.watch, "add")}，跳过 {count(p.watch, "skip")}
            。合并后 {p.next.watch.length} 条。
          </p>
          <p>
            策略新增 {count(p.strategies, "add")}，重名另存{" "}
            {count(p.strategies, "rename")}，跳过 {count(p.strategies, "skip")}
            。合并后 {p.next.strategies.length} 套。
          </p>
          {p.limitError && (
            <p role="alert" className="notice error">
              {p.limitError}，无法提交本次合并。
            </p>
          )}
          {!p.changed && <p>这些记录已存在，无需恢复。</p>}
          <PreviewList rows={p.watch} kind="watch" />
          <PreviewList rows={p.strategies} kind="strategies" />
          <div className="daily-buttons">
            <button
              className="primary"
              disabled={
                applying || !!storeError || !!p.limitError || !p.changed
              }
              onClick={apply}
            >
              {applying ? "正在恢复…" : "确认合并恢复"}
            </button>
            <button disabled={applying} onClick={repreview}>
              重新预览
            </button>
            <button
              disabled={applying}
              onClick={() => {
                setDraft(null);
                setError("");
              }}
            >
              取消导入
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
