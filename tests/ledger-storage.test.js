import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { LedgerStorage } from "../server/ledger-storage.js";
import {
  validateLedger,
  assertForward,
  digest,
  MAX_LEDGER_BYTES,
} from "../server/ledger-validation.js";
import { dailyPlans } from "../shared/daily-plans.js";
import { registerSignal, advanceTicket } from "../server/paper-ledger.js";
import { Daily } from "../server/daily.js";

test("oversized and invalid UTF-8 ledgers stay protected; oversized original is preserved on restore", async (t) => {
  const h = await harness(t);
  await h.storage.load();
  await fs.writeFile(
    h.file,
    Buffer.from([0x7b, 0x22, 0xff, 0x22, 0x3a, 0x31, 0x7d]),
  );
  const invalid = new LedgerStorage(h.options);
  await assert.rejects(invalid.load());
  assert.equal(invalid.status().blocked, true);
  const large = Buffer.alloc(MAX_LEDGER_BYTES + 1, 32);
  await fs.writeFile(h.file, large);
  const oversized = new LedgerStorage(h.options);
  await assert.rejects(oversized.load(), /10MiB/);
  assert.equal(oversized.status().canRestore, true);
  await oversized.restore(oversized.status().restoreToken);
  assert.equal(
    (await fs.stat(oversized.status().quarantinedFile)).size,
    large.length,
  );
  assert.equal(
    digest(await fs.readFile(oversized.status().quarantinedFile)),
    digest(large),
  );
  assert.deepEqual(JSON.parse(await fs.readFile(h.file)), fixture());
});

function fixture() {
  const activatedAt = "2026-10-30T05:08:12.562Z";
  const plans = dailyPlans.map((p) => ({
    ...structuredClone(p),
    activatedAt,
    ruleHash: digest(JSON.stringify(p)),
  }));
  const stock = { symbol: "sh600036", code: "600036", name: "测试股票" };
  const ticket = registerSignal(
    [],
    plans[0],
    stock,
    "2026-10-30",
    "2026-10-30T08:30:00.000Z",
    [],
    "test-source",
  );
  const bars = ["2026-10-30", "2026-11-02", "2026-11-03", "2026-11-04"].map(
    (date, i) => ({
      date,
      open: 10 + i,
      close: 10.5 + i,
      high: 11 + i,
      low: 9 + i,
      volume: 100,
    }),
  );
  const closed = advanceTicket(
    ticket,
    { source: "test-source", bars },
    "2026-11-04",
  );
  return {
    schema: 1,
    activatedAt,
    plans,
    days: [],
    tickets: [closed],
    job: null,
    autoAttempt: null,
  };
}
function addSignal(data) {
  const next = structuredClone(data);
  next.tickets.push(
    registerSignal(
      next.tickets,
      next.plans[0],
      { symbol: "sh600036", code: "600036", name: "测试股票" },
      "2026-11-06",
      "2026-11-06T08:30:00.000Z",
      [],
      "test-source",
    ),
  );
  return next;
}
async function harness(t, data = fixture(), extra = {}) {
  const base = path.resolve(os.tmpdir(), "ashare-ledger-tests");
  assert(!/^e:/i.test(base));
  await fs.mkdir(base, { recursive: true });
  const dir = await fs.mkdtemp(path.join(base, "case-"));
  t.after(async () => {
    const target = path.resolve(dir);
    assert(target.startsWith(base + path.sep) && target !== base);
    await fs.rm(target, { recursive: true, force: true });
  });
  const file = path.join(dir, "data/daily.json"),
    backupDir = path.join(dir, "backups");
  await fs.mkdir(path.dirname(file), { recursive: true });
  if (data !== null) await fs.writeFile(file, JSON.stringify(data, null, 2));
  const options = {
    file,
    backupDir,
    references: [],
    checkResources: async () => {},
    ...extra,
  };
  return { dir, file, backupDir, options, storage: new LedgerStorage(options) };
}

test("strict ledger reader distinguishes first use from corrupt/null/oversized/schema-invalid files", async (t) => {
  const fresh = await harness(t, null);
  assert.equal(await fresh.storage.load(), null);
  assert.equal(fresh.storage.status().state, "new");
  for (const raw of [
    "{bad",
    "null",
    "",
    '{"schema":2,"plans":[],"days":[],"tickets":[]}',
    " ".repeat(MAX_LEDGER_BYTES + 1),
  ]) {
    const h = await harness(t);
    await fs.writeFile(h.file, raw);
    await assert.rejects(h.storage.load());
    assert.equal(h.storage.status().blocked, true);
    assert.equal(await fs.readFile(h.file, "utf8"), raw);
    await assert.rejects(h.storage.write(fixture()), /保护/);
  }
});

test("valid ledger is backed up byte-for-byte; damaged file is quarantined and restored idempotently", async (t) => {
  const h = await harness(t),
    original = await fs.readFile(h.file, "utf8");
  assert.deepEqual(await h.storage.load(), fixture());
  assert.equal(await fs.readFile(h.file, "utf8"), original);
  assert.equal((await h.storage.snapshot("baseline")).raw, original);
  await fs.writeFile(h.file, "{truncated");
  const restarted = new LedgerStorage(h.options);
  await assert.rejects(restarted.load());
  const preview = restarted.status();
  assert.equal(preview.canRestore, true);
  assert.equal(preview.backup.tickets, 1);
  const restored = await restarted.restore(preview.restoreToken);
  assert.deepEqual(restored, fixture());
  assert.equal(await fs.readFile(h.file, "utf8"), original);
  assert.equal(
    await fs.readFile(restarted.status().quarantinedFile, "utf8"),
    "{truncated",
  );
  assert.deepEqual(await restarted.restore(preview.restoreToken), restored);
  assert.equal(restarted.status().blocked, false);
});

test("missing ledger after registration cannot become first use, but exact latest backup can restore it", async (t) => {
  const h = await harness(t);
  await h.storage.load();
  await fs.unlink(h.file);
  const restarted = new LedgerStorage(h.options);
  await assert.rejects(restarted.load(), /缺失/);
  assert.equal(restarted.status().canRestore, true);
  const d = await restarted.restore(restarted.status().restoreToken);
  assert.equal(d.tickets.length, 1);
});

test("reference identities prevent initializing missing ledger even without backup", async (t) => {
  const h = await harness(t, null);
  const file = path.join(h.dir, "reference.json");
  await fs.writeFile(
    file,
    JSON.stringify({ initialTicketIds: [fixture().tickets[0].id] }),
  );
  const s = new LedgerStorage({ ...h.options, references: [file] });
  await assert.rejects(s.load(), /登记依据/);
  assert.equal(s.status().canRestore, false);
});

test("rules, identities, closed results and frozen references cannot change", () => {
  const data = fixture();
  validateLedger(data);
  for (const mutate of [
    (d) => {
      d.plans[0].hold = 4;
    },
    (d) => {
      d.tickets[0].hold = 4;
    },
    (d) => {
      d.tickets.push(structuredClone(d.tickets[0]));
    },
    (d) => {
      d.tickets[0].net += 1;
    },
    (d) => {
      d.tickets[0].id = "changed";
    },
  ]) {
    const next = structuredClone(data);
    mutate(next);
    assert.throws(() => validateLedger(next), /校验失败/);
  }
  const next = addSignal(data);
  assertForward(next, data);
  assert.throws(() => assertForward(data, next), /丢失信号/);
  const altered = structuredClone(data);
  altered.tickets[0].asOf = "2026-11-06";
  assert.throws(() => assertForward(altered, data), /已完成结果/);
  assert.throws(
    () => validateLedger(data, { initialTicketIds: ["missing"] }),
    /首批/,
  );
  assert.throws(
    () =>
      validateLedger(data, {
        shortFrozenResults: [{ id: data.tickets[0].id, net: 0 }],
      }),
    /短线/,
  );
});

test("two-slot backup advances, baseline stays immutable; rollback loses no later IDs", async (t) => {
  const h = await harness(t),
    initial = fixture();
  await h.storage.load();
  const first = await h.storage.snapshot("latest");
  const next = addSignal(initial);
  await h.storage.write(next);
  assert.deepEqual((await h.storage.snapshot("latest")).data, next);
  assert.equal((await h.storage.snapshot("previous")).sha256, first.sha256);
  assert.equal((await h.storage.snapshot("baseline")).sha256, first.sha256);
  // Simulate someone replacing latest with an older, valid backup.
  await fs.copyFile(
    h.storage.snapshotPath("previous"),
    h.storage.snapshotPath("latest"),
  );
  const restarted = new LedgerStorage(h.options);
  await assert.rejects(restarted.load(), /不一致/);
  assert.equal(restarted.status().canRestore, false);
  assert.match(restarted.status().recoveryError, /缺少|回退/);
  assert.deepEqual(JSON.parse(await fs.readFile(h.file)), next);
});

test("invalid backup checksum and concurrent on-disk edits block writes and restoration", async (t) => {
  const h = await harness(t);
  await h.storage.load();
  await fs.writeFile(h.file, "broken");
  const s = new LedgerStorage(h.options);
  await assert.rejects(s.load());
  const token = s.status().restoreToken;
  await fs.writeFile(h.file, "changed-again");
  await assert.rejects(s.restore(token), /依据已变化/);
  assert.equal(await fs.readFile(h.file, "utf8"), "changed-again");
  const backup = JSON.parse(await fs.readFile(s.snapshotPath("latest")));
  backup.raw += " ";
  await fs.writeFile(s.snapshotPath("latest"), JSON.stringify(backup));
  await assert.rejects(s.load(), /校验和/);
  assert.equal(s.status().canRestore, false);
});

test("backup failure or low space stops before replacing main; main commit failure is recoverable", async (t) => {
  for (const failure of ["backup", "main", "space"]) {
    let enabled = false;
    const io = {
      ...fs,
      rename: async (from, to) => {
        if (
          enabled &&
          ((failure === "backup" && to.endsWith("latest.json")) ||
            (failure === "main" && to.endsWith("daily.json")))
        )
          throw Object.assign(Error("injected EIO"), { code: "EIO" });
        return fs.rename(from, to);
      },
      statfs: async (file) =>
        enabled && failure === "space"
          ? { bavail: 0, bsize: 4096 }
          : fs.statfs(file),
    };
    const h = await harness(t, fixture(), { io });
    await h.storage.load();
    const before = await fs.readFile(h.file, "utf8");
    enabled = true;
    await assert.rejects(h.storage.write(addSignal(fixture())));
    assert.equal(await fs.readFile(h.file, "utf8"), before);
    assert.equal(h.storage.status().blocked, true);
    enabled = false;
    if (failure === "main") {
      const restored = await h.storage.restore(h.storage.status().restoreToken);
      assert.equal(restored.tickets.length, 2);
      assert.deepEqual(restored.tickets[0], fixture().tickets[0]);
    } else {
      await h.storage.load();
      assert.equal(h.storage.status().blocked, false);
    }
  }
});

test("daily integration stays available read-only when damaged, and recovery never enrolls signals", async (t) => {
  const h = await harness(t);
  await h.storage.load();
  await fs.writeFile(h.file, "damaged");
  const store = {
    running: () => false,
    refresh: { running: false },
    research: { active: false },
  };
  const daily = new Daily(store, {
    storage: new LedgerStorage(h.options),
    now: () => new Date("2026-11-06T09:30:00Z"),
  });
  await daily.init();
  assert.equal(daily.state().ledgerStorage.blocked, true);
  await assert.rejects(daily.activate(), /账本已保护/);
  await assert.rejects(daily.start(), /账本已保护/);
  await daily.tick();
  assert.equal(daily.active, false);
  const result = await daily.storageAction(
    "restore",
    daily.state().ledgerStorage.restoreToken,
  );
  assert.equal(result.tickets.length, 1);
  assert.equal(result.ledgerStorage.blocked, false);
  assert.deepEqual(result.tickets[0], fixture().tickets[0]);
  assert.equal(result.days.length, 0);
});

test("out-of-band modifications and E-drive targets are rejected before writes/access", async (t) => {
  const h = await harness(t);
  await h.storage.load();
  await fs.writeFile(h.file, JSON.stringify(addSignal(fixture())));
  await assert.rejects(h.storage.write(fixture()), /运行期间被更改/);
  assert.equal(h.storage.status().canRestore, false);
  let calls = 0;
  const s = new LedgerStorage({
    ...h.options,
    io: {
      ...fs,
      lstat: async () => {
        calls++;
        throw Error("unexpected access");
      },
    },
  });
  await assert.rejects(s.safe("E:/frozen/daily.json"), /E盘冻结/);
  assert.equal(calls, 0);
});

test("first activation and serialized saves preserve all new registrations", async (t) => {
  const h = await harness(t, null);
  await h.storage.load();
  const initial = fixture(),
    next = addSignal(initial);
  await Promise.all([h.storage.write(initial), h.storage.write(next)]);
  assert.deepEqual(JSON.parse(await fs.readFile(h.file)), next);
  assert.equal((await h.storage.snapshot("latest")).data.tickets.length, 2);
});
