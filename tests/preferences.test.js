import test from "node:test";
import assert from "node:assert/strict";
import { defaults } from "../shared/rules.js";
import {
  PREF_KEY,
  LEGACY_WATCH,
  LEGACY_STRATEGIES,
  MAX_STRATEGIES,
  MAX_PREFERENCE_BYTES,
  createPreferenceBackup,
  parsePreferenceBackup,
  readPreferenceStore,
  preferenceView,
  preparePreferenceImport,
  applyPreferenceImport,
  writePreferences,
  previewPreferences,
} from "../src/preferences.js";

const watch = (n, name = "股票" + n) => {
  const code = String(n).padStart(6, "0");
  return { symbol: "sz" + code, code, name };
};
const strategy = (name, minPrice = 3) => ({
  name,
  config: { ...defaults, minPrice },
});
const data = (watch = [], strategies = []) => ({ watch, strategies });
const storage = (initial) => {
  const map = new Map(Object.entries(initial || {})),
    writes = [];
  return {
    map,
    writes,
    getItem: (k) => map.get(k) ?? null,
    setItem(k, v) {
      writes.push(k);
      map.set(k, v);
    },
  };
};
const backup = (payload) =>
  createPreferenceBackup(payload, "2026-11-08T01:00:00Z");

test("完整导出、空库恢复和再次导出保持前导零与全部参数", () => {
  const payload = data(
    [watch(1, "平安银行"), watch(2)],
    [strategy("本地:甲"), strategy("波段", 15)],
  );
  const s = storage(),
    text = backup(payload),
    draft = preparePreferenceImport(s, text);
  assert.equal(draft.preview.changed, true);
  assert.deepEqual(s.writes, []);
  applyPreferenceImport(s, draft);
  assert.deepEqual(s.writes, [PREF_KEY]);
  const restored = readPreferenceStore(s).data;
  assert.equal(restored.watch[0].code, "000001");
  assert.deepEqual(restored, payload);
  assert.equal(backup(restored), text);
  const other = storage();
  applyPreferenceImport(
    other,
    preparePreferenceImport(other, backup(restored)),
  );
  assert.deepEqual(readPreferenceStore(other).data, payload);
});
test("旧键可读，旧参数补默认值，提交后两个旧键逐字保留", () => {
  const w = JSON.stringify([watch(1)]),
    l = JSON.stringify([
      { name: "旧策略", config: { strategy: "short", minPrice: "4" } },
    ]);
  const s = storage({ [LEGACY_WATCH]: w, [LEGACY_STRATEGIES]: l });
  const old = readPreferenceStore(s).data;
  assert.equal(old.strategies[0].config.minPrice, 4);
  assert.equal(old.strategies[0].config.strategy, "short");
  assert.deepEqual(s.writes, []);
  const imported = preparePreferenceImport(
    s,
    backup(data([watch(2)], [strategy("新策略")])),
  );
  applyPreferenceImport(s, imported);
  assert.deepEqual(s.writes, [PREF_KEY]);
  assert.equal(s.getItem(LEGACY_WATCH), w);
  assert.equal(s.getItem(LEGACY_STRATEGIES), l);
  assert.deepEqual(readPreferenceStore(s).data.watch, [watch(1), watch(2)]);
});
test("保留原自选名称，重名策略列出差异并另存，重复导入不再增加", () => {
  const before = data([watch(1, "原名称")], [strategy("甲", 3)]);
  const s = storage();
  writePreferences(s, () => before);
  const file = backup(
    data([watch(1, "其他名称"), watch(2)], [strategy("甲", 9)]),
  );
  const plan = preparePreferenceImport(s, file);
  assert.deepEqual(
    plan.preview.watch.map((x) => x.action),
    ["skip", "add"],
  );
  assert.equal(plan.preview.strategies[0].name, "甲（导入）");
  assert.deepEqual(plan.preview.strategies[0].differences, [
    { key: "minPrice", before: 3, after: 9 },
  ]);
  applyPreferenceImport(s, plan);
  assert.deepEqual(
    readPreferenceStore(s).data,
    data(
      [watch(1, "原名称"), watch(2)],
      [strategy("甲", 3), strategy("甲（导入）", 9)],
    ),
  );
  const repeated = preparePreferenceImport(s, file);
  assert.equal(repeated.preview.changed, false);
  assert.throws(() => applyPreferenceImport(s, repeated), /没有需要/);
  assert.equal(s.writes.length, 2);
});
test("重名副本名称避开原库和备份自身名称，超长名称限制在30字符", () => {
  const a = "策略".repeat(15),
    reserved = a.slice(0, 26) + "（导入）";
  const p = previewPreferences(
    data([], [strategy(a)]),
    data([], [strategy(a, 7), strategy(reserved, 8)]),
  );
  assert.notEqual(p.strategies[0].name, reserved);
  assert.equal(p.strategies[1].name, reserved);
  assert.ok(p.strategies[0].name.length <= 30);
});
test("已预览后本机发生修改，提交失败且不会覆盖", () => {
  const s = storage(),
    file = backup(data([watch(1)]));
  const draft = preparePreferenceImport(s, file);
  writePreferences(s, () => data([watch(2)]));
  assert.throws(() => applyPreferenceImport(s, draft), /重新预览/);
  assert.deepEqual(readPreferenceStore(s).data.watch, [watch(2)]);
  assert.equal(s.writes.length, 1);
  applyPreferenceImport(s, preparePreferenceImport(s, file));
  assert.deepEqual(readPreferenceStore(s).data.watch, [watch(2), watch(1)]);
});
test("空库和坏格式、错误版本、伪造固定计划均有明确结果", () => {
  assert.equal(parsePreferenceBackup(backup(data())).watch.length, 0);
  assert.equal(
    parsePreferenceBackup("\uFEFF" + backup(data())).strategies.length,
    0,
  );
  assert.throws(() => parsePreferenceBackup("bad JSON"), /JSON/);
  assert.throws(
    () => parsePreferenceBackup(" ".repeat(MAX_PREFERENCE_BYTES + 1)),
    /4 MiB/,
  );
  const valid = JSON.parse(backup(data([watch(1)], [strategy("短线")])));
  for (const [make, reason] of [
    [
      (x) => {
        x.version = 2;
      },
      /版本/,
    ],
    [
      (x) => {
        x.plans = [{ id: "daily-short-v1", hold: 2 }];
      },
      /字段/,
    ],
    [
      (x) => {
        x.strategies[0].config.hold = 2;
      },
      /参数.*字段/,
    ],
    [
      (x) => {
        x.strategies[0].config.ruleHash = "new";
      },
      /字段/,
    ],
    [
      (x) => {
        x.strategies[0].config.minPrice = true;
      },
      /类型/,
    ],
    [
      (x) => {
        delete x.strategies[0].config.maxScan;
      },
      /字段/,
    ],
    [
      (x) => {
        x.watch[0].code = 1;
      },
      /六位字符串/,
    ],
    [
      (x) => {
        x.watch.push(x.watch[0]);
      },
      /重复/,
    ],
    [
      (x) => {
        x.strategies.push(x.strategies[0]);
      },
      /重复/,
    ],
  ]) {
    const x = structuredClone(valid);
    make(x);
    assert.throws(() => parsePreferenceBackup(JSON.stringify(x)), reason);
  }
});
test("超过容量时预览明确，合并拒绝且不部分写入", () => {
  const s = storage();
  writePreferences(s, () =>
    data(
      [],
      Array.from({ length: MAX_STRATEGIES }, (_, i) => strategy("旧" + i)),
    ),
  );
  const draft = preparePreferenceImport(
    s,
    backup(data([watch(1)], [strategy("新")])),
  );
  assert.match(draft.preview.limitError, /20/);
  assert.throws(() => applyPreferenceImport(s, draft), /20/);
  assert.equal(readPreferenceStore(s).data.watch.length, 0);
  assert.equal(s.writes.length, 1);
});
test("损坏本机存储保持原字节，配额失败不部分提交", () => {
  const s = storage({
    [PREF_KEY]: "broken",
    [LEGACY_WATCH]: JSON.stringify([watch(1)]),
  });
  assert.match(preferenceView(s).error, /原记录已保留/);
  assert.throws(() => preparePreferenceImport(s, backup(data())), /JSON/);
  assert.equal(s.getItem(PREF_KEY), "broken");
  assert.deepEqual(s.writes, []);
  const a = storage({ [LEGACY_WATCH]: JSON.stringify([watch(1)]) });
  const draft = preparePreferenceImport(
    a,
    backup(data([watch(2)], [strategy("新增")])),
  );
  a.setItem = () => {
    throw Error("QuotaExceededError");
  };
  assert.throws(() => applyPreferenceImport(a, draft), /Quota/);
  assert.deepEqual(readPreferenceStore(a).data, data([watch(1)]));
});
