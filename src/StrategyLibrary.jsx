import React, { useState } from "react";
import { validateConfig, defaults } from "../shared/rules";
import { MAX_STRATEGIES } from "./preferences.js";
const examples = [
  {
    name: "趋势跟随",
    config: {
      ...defaults,
      strategy: "swing",
      ma20AboveMa60: true,
      useBias: true,
      maxBias: 12,
    },
  },
  {
    name: "放量突破",
    config: {
      ...defaults,
      strategy: "swing",
      breakout20: true,
      useVolume: true,
      minVolumeRatio: 1.5,
    },
  },
  {
    name: "短线不过热",
    config: {
      ...defaults,
      strategy: "short",
      useRsi: true,
      minRsi: 40,
      maxRsi: 75,
      useBias: true,
      maxBias: 12,
    },
  },
];
export default function StrategyLibrary({
  config,
  setConfig,
  disabled,
  strategies,
  updateStrategies,
}) {
  const [name, setName] = useState(""),
    [error, setError] = useState(""),
    [chosen, setChosen] = useState(""),
    [saving, setSaving] = useState(false);
  const find = (value) =>
    value.startsWith("sample:")
      ? examples[Number(value.slice(7))]
      : strategies.find((x) => x.name === value.slice(6));
  const selected = chosen ? find(chosen) : null;
  async function save() {
    setSaving(true);
    setError("");
    try {
      const title = name.trim();
      if (!title || title.length > 30) throw Error("名称需为 1–30 个字");
      const validated = validateConfig(config);
      await updateStrategies((list) => {
        if (list.some((x) => x.name === title))
          throw Error("名称已存在，请换一个名称保存新版本");
        if (list.length >= MAX_STRATEGIES)
          throw Error("最多保存 20 套，请先移除不用的策略");
        return [...list, { name: title, config: validated }];
      });
      setName("");
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  }
  async function remove() {
    setSaving(true);
    setError("");
    try {
      await updateStrategies((list) => {
        const stored = list.find((x) => x.name === selected.name);
        if (
          !stored ||
          JSON.stringify(stored.config) !== JSON.stringify(selected.config)
        )
          throw Error("所选策略已变更，请重新选择");
        return list.filter((x) => x.name !== selected.name);
      });
      setChosen("");
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  }
  return (
    <div className="strategy-library">
      <h3>我的策略</h3>
      <p className="hint">
        示例用于组合条件，未经收益验证。保存当前条件可留作一个版本。
      </p>
      <select
        aria-label="选择保存的策略"
        disabled={disabled}
        value={selected ? chosen : ""}
        onChange={(e) => {
          setChosen(e.target.value);
          const next = e.target.value && find(e.target.value);
          if (next) setConfig({ ...next.config });
        }}
      >
        <option value="">选择策略以加载</option>
        <optgroup label="规则示例">
          {examples.map((s, i) => (
            <option key={s.name} value={"sample:" + i}>
              {s.name}
            </option>
          ))}
        </optgroup>
        <optgroup label="本机已保存">
          {strategies.map((s) => (
            <option key={s.name} value={"saved:" + s.name}>
              {s.name}
            </option>
          ))}
        </optgroup>
      </select>
      {selected && (
        <button
          disabled={disabled}
          onClick={() => setConfig({ ...selected.config })}
        >
          重新加载所选策略
        </button>
      )}
      <input
        aria-label="策略名称"
        placeholder="策略名称 / 版本"
        maxLength={30}
        value={name}
        disabled={disabled}
        onChange={(e) => setName(e.target.value)}
      />
      <button disabled={disabled || saving} onClick={save}>
        保存当前策略
      </button>
      {selected && chosen.startsWith("saved:") && (
        <button disabled={disabled || saving} onClick={remove}>
          移除所选保存项
        </button>
      )}
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
    </div>
  );
}
