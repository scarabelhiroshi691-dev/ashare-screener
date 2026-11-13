import test from "node:test";
import assert from "node:assert/strict";
import {
  defaults,
  validateConfig,
  baseReason,
  numberOrNull,
  validSymbol,
} from "../shared/rules.js";
import {
  chinaClock,
  isCompletedDate,
  isFreshQuote,
  quoteTimestamp,
} from "../shared/time.js";
import { analyzeBars, chartBars } from "../server/indicators.js";
import {
  parseEastmoney,
  parseTencent,
  parseHistory,
  assertCoverage,
} from "../server/providers.js";

const bars = Array.from({ length: 21 }, (_, i) => ({
  date: `2026-10-${String(i + 1).padStart(2, "0")}`,
  open: i + 1,
  close: i + 1,
  high: i + 1,
  low: i + 1,
  volume: i === 20 ? 200 : 100,
}));
test("均线使用当前及过去数据，成交量分母不包括当天", () => {
  const result = analyzeBars(bars, "2026-10-21", defaults);
  assert.equal(result.metrics.ma5, 19);
  assert.equal(result.metrics.ma20, 11.5);
  assert.equal(result.metrics.volumeRatio, 2);
  assert.equal(result.passed, true);
});
test("未来 K 线不能进入信号或图表", () => {
  const contaminated = [
    ...bars,
    { ...bars[0], date: "2026-10-22", close: 100000 },
  ];
  assert.deepEqual(
    analyzeBars(contaminated, "2026-10-21", defaults),
    analyzeBars(bars, "2026-10-21", defaults),
  );
  assert.equal(chartBars(contaminated, "2026-10-21").at(-1).date, "2026-10-21");
});
test("不足 20 日或缺少指定交易日不生成信号", () => {
  assert.throws(
    () => analyzeBars(bars.slice(0, 19), "2026-10-19", defaults),
    /不足/,
  );
  assert.throws(() => analyzeBars(bars, "2026-10-22", defaults), /缺少/);
});
test("零历史成交量不能伪造放量信号", () => {
  const data = bars.map((b) => ({ ...b, volume: 0 }));
  const result = analyzeBars(data, "2026-10-21", {
    ...defaults,
    strategy: "short",
  });
  assert.equal(result.metrics.volumeRatio, null);
  assert.equal(result.passed, false);
});
test("上海时区与完成日线边界", () => {
  assert.equal(chinaClock("2026-10-29T19:03:00Z").date, "2026-10-30");
  assert.equal(isCompletedDate("2026-10-30", "2026-10-30T06:59:00Z"), false);
  assert.equal(isCompletedDate("2026-10-30", "2026-10-30T07:10:00Z"), true);
  assert.equal(isCompletedDate("2026-10-29", "2026-10-30T01:00:00Z"), true);
  assert.equal(isCompletedDate("2026-10-31", "2026-10-30T10:00:00Z"), false);
});
test("盘中提醒拒绝旧报价，午休不触发", () => {
  const now = "2026-10-30T02:00:00Z";
  assert.equal(isFreshQuote({ quoteAt: "2026-10-30T01:59:00Z" }, now), true);
  assert.equal(isFreshQuote({ quoteAt: "2026-10-29T07:00:00Z" }, now), false);
  assert.equal(
    isFreshQuote({ quoteAt: "2026-10-30T04:00:00Z" }, "2026-10-30T04:00:00Z"),
    false,
  );
  assert.equal(quoteTimestamp("20261029161458"), "2026-10-29T16:14:58+08:00");
});
test("输入范围与缺失值", () => {
  assert.equal(numberOrNull("-"), null);
  assert.equal(numberOrNull(""), null);
  assert.equal(numberOrNull(0), 0);
  assert.throws(() => validateConfig({ ...defaults, maxScan: 0 }));
  assert.throws(() =>
    validateConfig({ ...defaults, minChange: 8, maxChange: 2 }),
  );
  assert.throws(() => validateConfig({ ...defaults, excludeST: "false" }));
  assert.equal(validateConfig({ ...defaults, minPrice: "3.5" }).minPrice, 3.5);
});
test("关键行情缺失与旧日期不会混进候选池", () => {
  const stock = {
    name: "测试",
    board: "main",
    quoteDate: "2026-10-29",
    price: 10,
    amount: 5e8,
    volume: 100,
  };
  assert.equal(baseReason(stock, defaults, "2026-10-29"), null);
  assert.match(
    baseReason({ ...stock, amount: null }, defaults, "2026-10-29"),
    /缺失/,
  );
  assert.match(
    baseReason({ ...stock, name: "*ST测试" }, defaults, "2026-10-29"),
    /风险/,
  );
  assert.match(baseReason(stock, defaults, "2026-10-30"), /日期/);
  assert.match(
    baseReason({ ...stock, volume: 0 }, defaults, "2026-10-29"),
    /无有效/,
  );
});
test("东方财富成交量手转股，未知值保持 null", () => {
  const s = parseEastmoney({
    f12: "000001",
    f13: 0,
    f14: "平安银行",
    f2: 11.54,
    f5: 1993504,
    f6: 2283899682.66,
    f8: "-",
    f124: 1793259255,
  });
  assert.equal(s.volume, 199350400);
  assert.equal(s.amount, 2283899682.66);
  assert.equal(s.turnover, null);
  assert.equal(s.quoteDate, "2026-10-29");
});
test("腾讯报价成交量与成交额换算", () => {
  const a = Array(50).fill("");
  Object.assign(a, {
    1: "浦发银行",
    2: "600000",
    3: "9.99",
    6: "753949",
    30: "20261029161458",
    32: "1.42",
    37: "74854",
    38: "0.23",
  });
  const [s] = parseTencent(`v_sh600000="${a.join("~")}";`);
  assert.equal(s.volume, 75394900);
  assert.equal(s.amount, 748540000);
  assert.equal(s.changePct, 1.42);
});
test("历史数据单位统一，拒绝无复权标记和异常 OHLC", () => {
  const payload = {
    code: 0,
    data: {
      sh600000: {
        qfqday: [["2026-10-29", "9.85", "9.99", "10.01", "9.84", "753949"]],
      },
    },
  };
  assert.equal(parseHistory(payload, "sh600000")[0].volume, 75394900);
  assert.throws(
    () =>
      parseHistory(
        { code: 0, data: { sh600000: { day: payload.data.sh600000.qfqday } } },
        "sh600000",
      ),
    /前复权/,
  );
  payload.data.sh600000.qfqday[0][3] = "1";
  assert.throws(() => parseHistory(payload, "sh600000"), /异常/);
});
test("完整性校验拒绝分页丢失或重复", () => {
  const rows = Array.from({ length: 1000 }, (_, i) => ({ symbol: String(i) }));
  assert.doesNotThrow(() => assertCoverage(rows, 1000));
  assert.throws(() => assertCoverage(rows.slice(1), 1000), /不完整/);
  assert.throws(
    () => assertCoverage([...rows.slice(1), rows[1]], 1000),
    /不完整/,
  );
});
test("拒绝指数、北交所和任意路径作为股票参数", () => {
  assert.equal(validSymbol("sh600000"), true);
  assert.equal(validSymbol("sz300308"), true);
  assert.equal(validSymbol("sh000001"), false);
  assert.equal(validSymbol("bj920001"), false);
  assert.equal(validSymbol("../x"), false);
});
