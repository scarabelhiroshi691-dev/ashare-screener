import test from "node:test";
import assert from "node:assert/strict";
import {
  createHistoryClient,
  DataError,
  retryAfterMs,
} from "../server/history-client.js";
import {
  runItems,
  summarizeJob,
  selectWork,
  recoverJob,
} from "../server/scan-runner.js";
import { parseEastmoneyHistory } from "../server/providers.js";
import { parseBaoStock } from "../server/baostock.js";
import { parseHistory } from "../server/providers.js";

test("BaoStock adapter preserves share volume and rejects wrong adjustment", () => {
  const p = {
    code: "sz.300285",
    rows: [
      [
        "2026-10-29",
        "sz.300285",
        "41.90",
        "39.44",
        "41.99",
        "39.40",
        "52731892",
        "2",
        "1",
      ],
    ],
  };
  const bars = parseBaoStock(p, "sz300285", parseHistory);
  assert.equal(bars[0].volume, 52731892);
  assert.equal(bars[0].close, 39.44);
  p.rows.push([
    "2026-10-28",
    "sz.300285",
    "41",
    "41",
    "41",
    "41",
    "",
    "2",
    "0",
  ]);
  assert.equal(parseBaoStock(p, "sz300285", parseHistory).length, 1);
  p.rows[1][8] = "1";
  assert.throws(() => parseBaoStock(p, "sz300285", parseHistory));
  p.rows.pop();
  p.rows[0][7] = "3";
  assert.throws(() => parseBaoStock(p, "sz300285", parseHistory));
});

function client(responses) {
  let now = 0,
    calls = 0,
    waits = [];
  const c = createHistoryClient({
    now: () => now,
    sleep: async (ms) => {
      waits.push(ms);
      now += ms;
    },
    fetchImpl: async () => {
      const r = responses[calls++];
      if (r instanceof Error) throw r;
      return r;
    },
  });
  return {
    c,
    get calls() {
      return calls;
    },
    waits,
  };
}
const response = (status = 200, body = '{"ok":true}', headers = {}) =>
  new Response(body, { status, headers });
test("temporary failures back off, honor Retry-After and serialize requests", async () => {
  const t = client([
    response(429, "busy", { "Retry-After": "12" }),
    response(503),
    response(),
    response(),
  ]);
  const events = [];
  await Promise.all([
    t.c.request("https://example.test", { onEvent: (e) => events.push(e) }),
    t.c.request("https://example.test"),
  ]);
  assert.deepEqual(t.waits, [12000, 15000, 2000]);
  assert.equal(t.calls, 4);
  assert.equal(events.filter((e) => e.type === "retry").length, 2);
  assert.equal(
    retryAfterMs(
      "Wed, 21 Oct 2015 07:28:00 GMT",
      Date.parse("2015-10-21T07:27:00Z"),
    ),
    60000,
  );
});
test("max three attempts; cooldown survives exhausted stock", async () => {
  const t = client([
    new Error("timeout"),
    response(502),
    response(503),
    response(),
  ]);
  await assert.rejects(
    t.c.request("https://example.test"),
    (e) => e.kind === "transient",
  );
  assert.equal(t.calls, 3);
  await t.c.request("https://example.test");
  assert.deepEqual(t.waits, [5000, 15000, 45000]);
});
test("access denial opens circuit without retrying blocked source", async () => {
  const t = client([
    response(501, "<html>https://waf.tencent.com/501page.html</html>"),
  ]);
  await assert.rejects(
    t.c.request("https://example.test"),
    (e) => e.kind === "blocked",
  );
  await assert.rejects(
    t.c.request("https://example.test"),
    (e) => e.kind === "blocked",
  );
  assert.equal(t.calls, 1);
  assert.deepEqual(t.waits, []);
});
test("long server cooldown pauses subsequent calls and malformed data is not retried", async () => {
  const t = client([response(429, "busy", { "Retry-After": "600" })]);
  await assert.rejects(
    t.c.request("https://example.test"),
    (e) => e.kind === "cooldown",
  );
  await assert.rejects(
    t.c.request("https://example.test"),
    (e) => e.kind === "cooldown",
  );
  assert.equal(t.calls, 1);
  const invalid = client([response(200, "oops")]);
  await assert.rejects(
    invalid.c.request("https://example.test"),
    (e) => e.kind === "data",
  );
  assert.equal(invalid.calls, 1);
});
test("cancelling backoff does not send next request", async () => {
  const controller = new AbortController();
  let calls = 0;
  const c = createHistoryClient({
    fetchImpl: async () => {
      calls++;
      return response(503);
    },
    sleep: async (_ms, _value, { signal }) => {
      controller.abort();
      signal.throwIfAborted();
    },
  });
  await assert.rejects(
    c.request("https://example.test", { signal: controller.signal }),
    (e) => e.name === "AbortError",
  );
  assert.equal(calls, 1);
});

test("queued request stops promptly and never reaches provider", async () => {
  let release,
    calls = 0;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const c = createHistoryClient({
    interval: 0,
    fetchImpl: async () => {
      calls++;
      await gate;
      return response();
    },
  });
  const first = c.request("https://example.test");
  const controller = new AbortController(),
    second = c.request("https://example.test", { signal: controller.signal });
  controller.abort();
  await assert.rejects(second, (e) => e.name === "AbortError");
  release();
  await first;
  assert.equal(calls, 1);
});

test("saved provider cooldown survives process recreation", async () => {
  const t = client([response(403)]);
  await assert.rejects(t.c.request("https://example.test"));
  const restored = client([]);
  restored.c.restore(t.c.status());
  await assert.rejects(
    restored.c.request("https://example.test"),
    (e) => e.kind === "blocked",
  );
  assert.equal(restored.calls, 0);
});

function job(count = 100) {
  return summarizeJob({
    schema: 2,
    status: "running",
    target: count,
    networkRequests: 0,
    networkRetries: 0,
    items: Array.from({ length: count }, (_, i) => ({
      stock: { symbol: `s${i}`, amount: i },
      state: "pending",
      attempts: 0,
    })),
  });
}
function options(overrides = {}) {
  return {
    signal: new AbortController().signal,
    load: async () => ({ fromCache: false, source: "test" }),
    evaluate: (stock) => (stock.amount % 2 === 0 ? stock : null),
    save: async () => {},
    ...overrides,
  };
}
test("100-stock job continues past missing data; retry only failures without duplicates", async () => {
  const j = job();
  let saves = 0;
  await runItems(
    j,
    selectWork(j, "resume"),
    options({
      load: async (s) => {
        if (["s3", "s7"].includes(s.symbol)) throw new DataError("missing");
        return { fromCache: false };
      },
      save: async () => {
        saves++;
      },
    }),
  );
  assert.equal(j.status, "partial");
  assert.equal(j.done, 100);
  assert.equal(j.failed, 2);
  assert.equal(j.results.length, 50);
  assert.equal(saves, 101);
  const visited = [];
  await runItems(
    j,
    selectWork(j, "retry", ["s3"]),
    options({
      load: async (s) => {
        visited.push(s.symbol);
        return {};
      },
    }),
  );
  assert.deepEqual(visited, ["s3"]);
  assert.equal(j.failed, 1);
  assert.equal(j.done, 100);
  await runItems(j, selectWork(j, "retry"), options());
  assert.equal(j.status, "completed");
  assert.equal(j.failed, 0);
  assert.equal(j.unmatched, 50);
  assert.equal(j.results.length, 50);
  assert.equal(j.items[0].attempts, 1);
  assert.equal(j.items[3].attempts, 2);
});
test("stop, persist, restart and resume keep precise counters and original successes", async () => {
  const j = job(100),
    controller = new AbortController();
  let saved;
  await runItems(
    j,
    selectWork(j, "resume"),
    options({
      signal: controller.signal,
      load: async (stock) => {
        if (stock.symbol === "s8") {
          controller.abort();
          controller.signal.throwIfAborted();
        }
        return {};
      },
      save: async (v) => {
        saved = structuredClone(v);
      },
    }),
  );
  assert.equal(j.status, "stopped");
  assert.equal(j.done, 8);
  assert.equal(j.pending, 92);
  assert.equal(j.failed, 0);
  saved.status = "running";
  saved.items[8].state = "running";
  const recovered = recoverJob(saved);
  assert.equal(recovered.status, "paused");
  assert.equal(recovered.items[8].state, "pending");
  const visited = [];
  await runItems(
    recovered,
    selectWork(recovered, "resume"),
    options({
      load: async (stock) => {
        visited.push(stock.symbol);
        return {};
      },
    }),
  );
  assert.equal(recovered.done, 100);
  assert.equal(recovered.status, "completed");
  assert.equal(visited.length, 92);
  assert.ok(!visited.includes("s0"));
});
test("source outage pauses with retained pending work; retry subset cannot mark unfinished job completed", async () => {
  const j = job();
  await runItems(
    j,
    selectWork(j, "resume"),
    options({
      load: async () => {
        throw new DataError("down", "transient");
      },
    }),
  );
  assert.equal(j.status, "paused");
  assert.equal(j.failed, 3);
  assert.equal(j.pending, 97);
  await runItems(j, selectWork(j, "retry"), options());
  assert.equal(j.status, "paused");
  assert.equal(j.failed, 0);
  assert.equal(j.pending, 97);
  await runItems(j, selectWork(j, "resume"), options());
  assert.equal(j.status, "completed");
});
test("checkpoint write failure stops job; invalid retry selection is rejected", async () => {
  const j = job();
  let reads = 0;
  await runItems(
    j,
    selectWork(j, "resume"),
    options({
      load: async () => {
        reads++;
        return {};
      },
      save: async () => {
        throw new Error("disk full");
      },
    }),
  );
  assert.equal(reads, 1);
  assert.equal(j.status, "paused");
  assert.match(j.fatal, /disk full/);
  assert.throws(() => selectWork(j, "retry", ["s0"]));
  assert.throws(() => selectWork({}, "resume"));
  assert.throws(() => selectWork(j, "retry", "s1"));
});
test("Eastmoney adjusted adapter validates identity, OHLC, dates and volume units", () => {
  const p = {
    rc: 0,
    data: {
      code: "600825",
      klines: ["2026-10-29,14.60,14.84,15.48,14.45,1435142,2151832052"],
    },
  };
  const bars = parseEastmoneyHistory(p, "sh600825");
  assert.equal(bars[0].volume, 143514200);
  assert.equal(bars[0].close, 14.84);
  assert.throws(() => parseEastmoneyHistory(p, "sh600000"));
  assert.throws(() =>
    parseEastmoneyHistory(
      {
        ...p,
        data: { ...p.data, klines: [...p.data.klines, ...p.data.klines] },
      },
      "sh600825",
    ),
  );
  assert.throws(() =>
    parseEastmoneyHistory(
      { ...p, data: { ...p.data, klines: ["2026-10-29,14,15,13,14,100"] } },
      "sh600825",
    ),
  );
});
