import test from "node:test";
import assert from "node:assert/strict";
import { bollingerBands, observeDailyChart } from "../src/chart-observation.js";

test("BOLL uses the prior 20 closes including the bar, with population deviation", () => {
  const bars = Array.from({ length: 21 }, (_, i) => ({ close: i + 1 }));
  const result = bollingerBands(bars);
  assert.equal(result[18], null);
  assert.deepEqual(result[19], {
    upper: 10.5 + 2 * Math.sqrt(33.25),
    middle: 10.5,
    lower: 10.5 - 2 * Math.sqrt(33.25),
  });
  assert.equal(result[20].middle, 11.5);
  assert.equal(bollingerBands(bars.slice(0, 20))[19].upper, result[19].upper);
  assert.deepEqual(bollingerBands(bars.map(() => ({ close: 10 })))[20], {
    upper: 10,
    middle: 10,
    lower: 10,
  });
  bars[0].close = null;
  assert.equal(bollingerBands(bars)[19], null);
  assert.equal(bollingerBands(bars)[20].middle, 11.5);
});

function barsForRetest() {
  return Array.from({ length: 7 }, (_, index) => ({
    date: "2026-11-0" + (index + 1),
    ma5: 10.3,
    ma20: 10,
    close: index === 0 ? 9.9 : 10.3,
    low: index === 0 ? 9.8 : 10.1,
    volume: index === 6 ? 60 : 100,
  }));
}

test("MA20 observation uses the exact completed date and the prior five bars", () => {
  const bars = barsForRetest();
  const asOf = bars.at(-1).date;
  const result = observeDailyChart(bars, asOf);
  assert.equal(result.crossDate, bars[1].date);
  assert.equal(result.ma20Change, 0);
  assert.equal(result.volumeRatio, 0.6);
  assert.equal(result.retest, true);
  assert.ok(Math.abs(result.lowDistance - 1) < 1e-10);
  const later = { ...bars[6], date: "2026-11-08", low: 5, volume: 0 };
  assert.deepEqual(observeDailyChart([...bars, later], asOf), result);
  assert.equal(observeDailyChart(bars, later.date), null);
  assert.equal(observeDailyChart(bars, undefined), null);
  assert.equal(
    observeDailyChart([...bars.slice(0, -1), { ...bars[6], ma20: null }], asOf),
    null,
  );
});

test("retest fails on an intervening break, no shrinkage, insufficient data, or a fresh crossover", () => {
  const cases = [
    (bars) => {
      bars[2].low = 9.9;
    },
    (bars) => {
      bars[6].volume = 100;
    },
    (bars) => {
      bars[4].volume = 0;
    },
    (bars) => {
      bars[6].low = 10.4;
    },
    (bars) => {
      bars[1].ma20 = 10.01;
    },
    (bars) => {
      for (const bar of bars.slice(0, -1)) bar.close = 9.9;
    },
  ];
  for (const change of cases) {
    const bars = barsForRetest();
    change(bars);
    assert.equal(observeDailyChart(bars, bars.at(-1).date).retest, false);
  }
});
