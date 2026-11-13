import { defaults, validateConfig, validSymbol } from "../shared/rules.js";

export const PREF_KEY = "a-preferences-v1";
export const LEGACY_WATCH = "a-watch";
export const LEGACY_STRATEGIES = "a-strategies";
export const PREFERENCE_FORMAT = "ashare-screener-preferences";
export const MAX_PREFERENCE_BYTES = 4 * 1024 * 1024;
export const MAX_WATCH = 10000;
export const MAX_STRATEGIES = 20;
const configKeys = Object.keys(defaults);
const empty = () => ({ watch: [], strategies: [] });
const plain = (x) => x && Object.getPrototypeOf(x) === Object.prototype;

function shape(value, keys, label) {
  if (
    !plain(value) ||
    Object.keys(value).some((k) => !keys.includes(k)) ||
    keys.some((k) => !Object.hasOwn(value, k))
  )
    throw Error(label + "字段不正确");
}
function list(value, limit, label) {
  if (!Array.isArray(value)) throw Error(label + "必须为列表");
  if (value.length > limit) throw Error(label + "最多 " + limit + " 条");
}
function title(value, max, label) {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.trim().length > max ||
    /[\u0000-\u001f\u007f]/.test(value)
  )
    throw Error(label + "不正确");
  return value.trim();
}
function normalizeConfig(value, legacy) {
  if (!plain(value)) throw Error("策略参数必须为对象");
  if (!legacy) {
    shape(value, configKeys, "策略参数");
    if (configKeys.some((k) => typeof value[k] !== typeof defaults[k]))
      throw Error("策略参数类型不正确");
  }
  return validateConfig(value);
}
function unique(rows, field, label) {
  const seen = new Set();
  for (const row of rows) {
    if (seen.has(row[field])) throw Error(label + "重复：" + row[field]);
    seen.add(row[field]);
  }
  return rows;
}
export function normalizePreferences(data, { legacy = false } = {}) {
  shape(data, ["watch", "strategies"], "本机偏好");
  list(data.watch, MAX_WATCH, "自选股");
  list(data.strategies, MAX_STRATEGIES, "命名策略");
  const watch = data.watch.map((row, index) => {
    const label = "自选第 " + (index + 1) + " 条";
    shape(row, ["symbol", "code", "name"], label);
    if (
      typeof row.symbol !== "string" ||
      !validSymbol(row.symbol) ||
      row.code !== row.symbol.slice(2)
    )
      throw Error(label + "的股票代码不正确，须保留六位字符串");
    return {
      symbol: row.symbol,
      code: row.code,
      name: title(row.name, 100, label + "名称"),
    };
  });
  const strategies = data.strategies.map((row, index) => {
    const label = "策略第 " + (index + 1) + " 条";
    shape(row, ["name", "config"], label);
    const name = title(row.name, 30, label + "名称");
    try {
      return { name, config: normalizeConfig(row.config, legacy) };
    } catch (e) {
      throw Error("策略「" + name + "」：" + e.message);
    }
  });
  return {
    watch: unique(watch, "symbol", "自选股票"),
    strategies: unique(strategies, "name", "策略名称"),
  };
}
function parseJson(text) {
  if (new TextEncoder().encode(text).length > MAX_PREFERENCE_BYTES)
    throw Error("偏好文件超过 4 MiB");
  try {
    return JSON.parse(text.replace(/^\uFEFF/, ""));
  } catch {
    throw Error("文件不是有效的 JSON");
  }
}
export function createPreferenceBackup(
  data,
  exportedAt = new Date().toISOString(),
) {
  return (
    JSON.stringify(
      {
        format: PREFERENCE_FORMAT,
        version: 1,
        exportedAt,
        ...normalizePreferences(data),
      },
      null,
      2,
    ) + "\n"
  );
}
export function parsePreferenceBackup(text) {
  const value = parseJson(text);
  shape(
    value,
    ["format", "version", "exportedAt", "watch", "strategies"],
    "备份文件",
  );
  if (value.format !== PREFERENCE_FORMAT || value.version !== 1)
    throw Error("不支持此备份格式或版本");
  if (
    typeof value.exportedAt !== "string" ||
    !Number.isFinite(Date.parse(value.exportedAt))
  )
    throw Error("备份导出时间不正确");
  return {
    exportedAt: value.exportedAt,
    ...normalizePreferences({
      watch: value.watch,
      strategies: value.strategies,
    }),
  };
}
export function readPreferenceStore(storage) {
  const raw = storage.getItem(PREF_KEY);
  if (raw !== null) {
    const value = parseJson(raw);
    shape(value, ["version", "watch", "strategies"], "本机记录");
    if (value.version !== 1) throw Error("本机记录版本不受支持");
    return {
      source: [raw],
      data: normalizePreferences({
        watch: value.watch,
        strategies: value.strategies,
      }),
    };
  }
  const watch = storage.getItem(LEGACY_WATCH),
    strategies = storage.getItem(LEGACY_STRATEGIES);
  return {
    source: [null, watch, strategies],
    data: normalizePreferences(
      {
        watch: watch === null ? [] : parseJson(watch),
        strategies: strategies === null ? [] : parseJson(strategies),
      },
      { legacy: true },
    ),
  };
}
export function preferenceView(storage) {
  try {
    return { data: readPreferenceStore(storage).data, error: "" };
  } catch (e) {
    return {
      data: empty(),
      error: "本机偏好读取失败，原记录已保留：" + e.message,
    };
  }
}
function compareConfig(a, b) {
  return configKeys
    .filter((k) => a[k] !== b[k])
    .map((key) => ({ key, before: a[key], after: b[key] }));
}
function versionedName(name, index) {
  const suffix = index === 1 ? "（导入）" : "（导入 " + index + "）";
  // Trim only the prefix, leaving the distinguishing suffix intact.
  let prefix = name.slice(0, 30 - suffix.length);
  if (/[\uD800-\uDBFF]$/.test(prefix)) prefix = prefix.slice(0, -1);
  return prefix + suffix;
}
export function previewPreferences(current, incoming) {
  const next = {
    watch: [...current.watch],
    strategies: [...current.strategies],
  };
  const symbols = new Map(next.watch.map((x) => [x.symbol, x]));
  const names = new Map(next.strategies.map((x) => [x.name, x]));
  const incomingNames = new Set(incoming.strategies.map((x) => x.name));
  const watch = incoming.watch.map((row) => {
    const old = symbols.get(row.symbol);
    if (old) return { item: row, action: "skip", existingName: old.name };
    next.watch.push(row);
    return { item: row, action: "add" };
  });
  const strategies = incoming.strategies.map((row) => {
    const old = names.get(row.name);
    if (!old) {
      names.set(row.name, row);
      next.strategies.push(row);
      return { item: row, action: "add", name: row.name };
    }
    const differences = compareConfig(old.config, row.config);
    if (!differences.length)
      return { item: row, action: "skip", name: row.name };
    for (let i = 1; ; i++) {
      const name = versionedName(row.name, i);
      if (incomingNames.has(name)) continue;
      const existing = names.get(name);
      if (existing) {
        if (!compareConfig(existing.config, row.config).length)
          return { item: row, action: "skip", name };
        continue;
      }
      const copy = { ...row, name };
      names.set(name, copy);
      next.strategies.push(copy);
      return { item: row, action: "rename", name, differences };
    }
  });
  const changed =
    watch.some((x) => x.action !== "skip") ||
    strategies.some((x) => x.action !== "skip");
  const limitError =
    next.watch.length > MAX_WATCH
      ? "合并后的自选股超过 " + MAX_WATCH + " 条"
      : next.strategies.length > MAX_STRATEGIES
        ? "合并后的命名策略超过 " + MAX_STRATEGIES + " 套"
        : "";
  return { next, watch, strategies, changed, limitError };
}
export function preparePreferenceImport(storage, text) {
  const incoming = parsePreferenceBackup(text),
    current = readPreferenceStore(storage);
  return {
    incoming,
    source: current.source,
    preview: previewPreferences(current.data, incoming),
  };
}
export function writePreferences(storage, update, expected) {
  const current = readPreferenceStore(storage);
  if (
    expected &&
    (expected.length !== current.source.length ||
      expected.some((x, i) => x !== current.source[i]))
  )
    throw Error("本机记录已变更，请重新预览后确认");
  const data = normalizePreferences(update(current.data));
  const raw = JSON.stringify({ version: 1, ...data });
  if (new TextEncoder().encode(raw).length > MAX_PREFERENCE_BYTES)
    throw Error("合并后的本机偏好超过 4 MiB");
  // A single localStorage operation commits both lists. On quota failure the old
  // value is retained by the browser. Legacy keys are read-only.
  storage.setItem(PREF_KEY, raw);
  return data;
}
export function applyPreferenceImport(storage, draft) {
  return writePreferences(
    storage,
    (current) => {
      const preview = previewPreferences(current, draft.incoming);
      if (preview.limitError) throw Error(preview.limitError);
      if (!preview.changed) throw Error("没有需要恢复的记录");
      return preview.next;
    },
    draft.source,
  );
}
