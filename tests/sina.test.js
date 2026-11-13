import test from "node:test";
import assert from "node:assert/strict";
import {
  parseSinaJSONP,
  parseSinaHistory,
  createSinaHistoryProvider,
} from "../server/sina-history.js";
import { parseHistory } from "../server/providers.js";
import { createHistoryClient } from "../server/history-client.js";

const symbol = "sz002428";
const rows = [
  {
    day: "2026-07-02",
    open: "20",
    high: "22",
    low: "18",
    close: "21",
    volume: "123456",
  },
  {
    day: "2026-07-03",
    open: "10",
    high: "11",
    low: "9",
    close: "10.5",
    volume: "234567",
  },
  {
    day: "2026-07-06",
    open: "11",
    high: "12",
    low: "10",
    close: "11.5",
    volume: "345678",
  },
];
const factors = {
  symbol,
  total: 3,
  data: [
    { d: "2026-07-03", f: "1" },
    { d: "2026-01-01", f: "2" },
    { d: "1900-01-01", f: "3" },
  ],
};
const parse = (r = rows, f = factors, date = "2026-07-06") =>
  parseSinaHistory(r, f, symbol, date, parseHistory);

test("Sina JSONP accepts only known JSON wrappers without executing scripts", () => {
  assert.deepEqual(
    parseSinaJSONP(
      "/*<script>ignore</script>*/\n=(" + JSON.stringify(rows) + ");",
    ),
    rows,
  );
  assert.deepEqual(
    parseSinaJSONP(
      "var sz002428qfq=" +
        JSON.stringify({ total: 3, data: factors.data }) +
        "\n/* comment */",
    ),
    factors,
  );
  for (const bad of [
    "=([1]);globalThis.pwned=true;",
    "var sz002428qfq={data:[]};",
    "<html>captcha</html>",
    "=((()=>[])());",
  ])
    assert.throws(() => parseSinaJSONP(bad));
});
test("Sina applies factors at exact date boundaries and preserves volume in shares", () => {
  const b = parse();
  assert.deepEqual(b[0], {
    date: "2026-07-02",
    open: 10,
    close: 10.5,
    high: 11,
    low: 9,
    volume: 123456,
  });
  assert.equal(b[1].close, 10.5);
  assert.equal(b[2].volume, 345678);
});
test("Sina normalizes to requested date and excludes future bars/factor events", () => {
  const f = {
    ...factors,
    total: 4,
    data: [...factors.data, { d: "2026-08-01", f: "0.5" }],
  };
  assert.equal(parse(rows, f, "2026-07-02")[0].close, 21);
  assert.equal(parse(rows, f, "2026-07-02").length, 1);
  assert.equal(parse(rows, f).at(-1).close, 11.5);
});
test("Sina rejects missing, mismatched, duplicate or invalid adjustment factors", () => {
  for (const f of [
    null,
    { ...factors, symbol: "sh600000" },
    { ...factors, data: [] },
    { ...factors, total: 2 },
    { ...factors, data: factors.data.map((x) => ({ ...x, f: "0" })) },
    { ...factors, data: factors.data.map((x) => ({ ...x, d: "2026-01-01" })) },
    { ...factors, total: 1, data: [{ d: "2026-07-06", f: "1" }] },
  ])
    assert.throws(() => parse(rows, f));
});
test("Sina validates raw OHLC/date/volume and requires current completed effective bar", () => {
  for (const patch of [
    { high: "1" },
    { volume: null },
    { day: "bad" },
    { close: "0" },
  ])
    assert.throws(() => parse([{ ...rows[0], ...patch }, ...rows.slice(1)]));
  assert.throws(() => parse([...rows, rows[2]]));
  assert.throws(() => parse(rows.slice(0, 2)));
  const zero = rows.map((r, i) => (i === 1 ? { ...r, volume: "0" } : r));
  assert.equal(parse(zero).length, 2);
  assert.throws(() => parse(rows.map((r) => ({ ...r, volume: "0" }))));
});
test("Sina transport shares pacing, parses JSONP, persists denial and honors cancellation", async () => {
  let now = 0,
    calls = 0;
  const waits = [];
  const replies = [
    "=(" + JSON.stringify(rows) + ");",
    "var sz002428qfq=" + JSON.stringify({ total: 3, data: factors.data }),
  ];
  const client = createHistoryClient({
    decode: parseSinaJSONP,
    referer: "https://finance.sina.com.cn/",
    now: () => now,
    sleep: async (ms) => {
      waits.push(ms);
      now += ms;
    },
    fetchImpl: async (_url, opts) => {
      assert.equal(opts.headers.Referer, "https://finance.sina.com.cn/");
      return new Response(replies[calls++]);
    },
  });
  const p = createSinaHistoryProvider(parseHistory, { client });
  const h = await p.fetchHistory(symbol, undefined, "2026-07-06");
  assert.equal(h.source, "新浪财经");
  assert.equal(h.bars.length, 3);
  assert.equal(calls, 2);
  assert.deepEqual(waits, [2000]);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(p.fetchHistory(symbol, controller.signal, "2026-07-06"));
  assert.equal(calls, 2);
  p.restore({ blockedUntil: 99999, blockedReason: "source denied" });
  assert.equal(p.status().blockedUntil, 99999);
  await assert.rejects(
    p.fetchHistory(symbol, undefined, "2026-07-06"),
    (e) => e.kind === "blocked",
  );
  assert.equal(calls, 2);
});
