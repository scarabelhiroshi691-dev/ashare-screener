import * as fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { resourceCheck } from "./cache.js";
import { dataDir, backupRoot, reviewDir } from "./paths.js";
import {
  validateLedger,
  assertForward,
  digest,
  MAX_LEDGER_BYTES,
} from "./ledger-validation.js";

const referenceFiles = [
  path.join(reviewDir, "plan.json"),
  path.join(reviewDir, "first-batch-comparison.json"),
];
const hashFile = async (file) => {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
};

export class LedgerStorage {
  constructor({
    file = path.join(dataDir, "daily.json"),
    backupDir = path.join(backupRoot, "ledger"),
    references = referenceFiles,
    io = fs,
    checkResources = resourceCheck,
  } = {}) {
    Object.assign(this, {
      file: path.resolve(file),
      backupDir: path.resolve(backupDir),
      references,
      io,
      checkResources,
    });
    this.info = { state: "checking", blocked: true, backupDir: this.backupDir };
    this.tail = Promise.resolve();
    this.reference = {};
    this.current = null;
    this.currentHash = "missing";
  }
  serial(work) {
    const task = this.tail.then(work);
    this.tail = task.catch(() => {});
    return task;
  }
  status() {
    return structuredClone(this.info);
  }
  snapshotPath(name) {
    return path.join(this.backupDir, `${name}.json`);
  }

  // Reject links before traversing them, including project and backup ancestors.
  async safe(file) {
    const resolved = path.resolve(file);
    if (/^e:/i.test(resolved)) throw Error("E盘冻结，不能访问账本路径");
    const base = path.parse(resolved).root;
    let current = base;
    for (const part of resolved
      .slice(base.length)
      .split(path.sep)
      .filter(Boolean)) {
      current = path.join(current, part);
      try {
        if ((await this.io.lstat(current)).isSymbolicLink())
          throw Error("账本或备份路径不能经过链接");
      } catch (e) {
        if (e.code === "ENOENT") break;
        throw e;
      }
    }
  }
  async image(file, limit = MAX_LEDGER_BYTES) {
    await this.safe(file);
    let stat;
    try {
      stat = await this.io.stat(file);
    } catch (e) {
      if (e.code === "ENOENT") return { hash: "missing", exists: false };
      throw e;
    }
    if (!stat.isFile()) throw Error("账本路径不是普通文件");
    if (stat.size > limit)
      return {
        exists: true,
        oversized: true,
        size: stat.size,
        hash: `oversize:${stat.size}:${stat.mtimeMs}`,
      };
    const bytes = await this.io.readFile(file);
    if (bytes.length > limit) throw Error("读取期间账本超过容量上限");
    return {
      exists: true,
      raw: new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
        bytes,
      ),
      hash: digest(bytes),
      size: bytes.length,
    };
  }
  async snapshot(name) {
    const image = await this.image(
      this.snapshotPath(name),
      MAX_LEDGER_BYTES * 3,
    );
    if (!image.exists) return null;
    if (image.oversized) throw Error(`${name}备份超过容量上限`);
    const envelope = JSON.parse(image.raw);
    if (
      envelope.schema !== 1 ||
      typeof envelope.raw !== "string" ||
      Buffer.byteLength(envelope.raw) > MAX_LEDGER_BYTES ||
      envelope.sha256 !== digest(envelope.raw) ||
      !Number.isFinite(Date.parse(envelope.savedAt))
    )
      throw Error(`${name}备份校验和无效`);
    const data = validateLedger(JSON.parse(envelope.raw), this.reference);
    return { ...envelope, data };
  }
  async resources(extra = 0) {
    await this.checkResources();
    await this.safe(this.backupDir);
    let existing = this.backupDir;
    while (true) {
      try {
        await this.io.stat(existing);
        break;
      } catch (e) {
        if (e.code !== "ENOENT" || path.dirname(existing) === existing) throw e;
        existing = path.dirname(existing);
      }
    }
    const disk = await this.io.statfs(existing);
    if (disk.bavail * disk.bsize < 1024 ** 3 + extra)
      throw Error("备份所在磁盘空间不足，停止账本写入");
    await this.io.mkdir(this.backupDir, { recursive: true });
  }
  async atomic(file, raw) {
    await this.safe(file);
    await this.io.mkdir(path.dirname(file), { recursive: true });
    const temporary = `${file}.${randomUUID()}.tmp`;
    let handle;
    try {
      handle = await this.io.open(temporary, "wx");
      await handle.writeFile(raw, "utf8");
      await handle.sync();
      await handle.close();
      handle = null;
      await this.io.rename(temporary, file);
    } catch (e) {
      await handle?.close().catch(() => {});
      await this.io.unlink(temporary).catch(() => {});
      throw e;
    }
  }
  async readReferences() {
    this.reference = {};
    for (const file of this.references) {
      const image = await this.image(file);
      if (!image.exists) continue;
      if (image.oversized) throw Error("冻结依据超过容量上限");
      const value = JSON.parse(image.raw);
      for (const key of [
        "frozenPlans",
        "initialTicketIds",
        "shortFrozenResults",
      ]) {
        if (value[key] !== undefined) {
          if (!Array.isArray(value[key])) throw Error("冻结依据格式无效");
          this.reference[key] = value[key];
        }
      }
    }
  }
  async candidate(image) {
    const latest = await this.snapshot("latest");
    if (!latest) return null;
    const anchor = await this.snapshot("baseline");
    if (!anchor) throw Error("首次验证备份缺失，需核对后恢复");
    assertForward(latest.data, anchor.data);
    if (this.current) assertForward(latest.data, this.current);
    // Even an invalid on-disk record must not cause unnoticed loss of extra IDs.
    if (image?.raw) {
      let observed;
      try {
        observed = JSON.parse(image.raw);
      } catch {}
      if (Array.isArray(observed?.tickets)) {
        const ids = new Set(latest.data.tickets.map((t) => t.id));
        if (
          observed.tickets.some(
            (t) => typeof t?.id === "string" && !ids.has(t.id),
          )
        )
          throw Error("备份缺少主文件中登记的信号，禁止回退，请保留文件核对");
        try {
          validateLedger(observed, this.reference);
        } catch {
          observed = null;
        }
        if (observed) assertForward(latest.data, observed);
      }
    }
    return latest;
  }
  summary(snapshot) {
    return snapshot
      ? {
          savedAt: snapshot.savedAt,
          sha256: snapshot.sha256,
          tickets: snapshot.data.tickets.length,
          days: snapshot.data.days.length,
          closed: snapshot.data.tickets.filter((t) => t.state === "closed")
            .length,
        }
      : null;
  }
  async block(error) {
    const message =
      error instanceof SyntaxError
        ? "账本或备份文件格式损坏，已保留原文件"
        : error.code === "ERR_ENCODING_INVALID_ENCODED_DATA"
          ? "账本或备份文件编码损坏，已保留原文件"
          : error.message;
    this.info = {
      state: "blocked",
      blocked: true,
      message,
      backupDir: this.backupDir,
      canRestore: false,
      backup: null,
      quarantinedFile: this.info.quarantinedFile || null,
    };
    try {
      const image = await this.image(this.file);
      const latest = await this.candidate(image);
      if (latest) {
        this.info.backup = this.summary(latest);
        this.info.restoreToken = digest(image.hash + ":" + latest.sha256);
        this.info.canRestore = true;
      }
    } catch (e) {
      this.info.recoveryError = e.message;
    }
  }
  async capture(raw) {
    await this.resources(Buffer.byteLength(raw) * 4);
    const next = {
      schema: 1,
      savedAt: new Date().toISOString(),
      sha256: digest(raw),
      raw,
    };
    const previous = await this.snapshot("latest");
    const anchor = await this.snapshot("baseline");
    const data = validateLedger(JSON.parse(raw), this.reference);
    if (anchor) assertForward(data, anchor.data);
    if (previous) assertForward(data, previous.data);
    if (!anchor)
      await this.atomic(this.snapshotPath("baseline"), JSON.stringify(next));
    if (previous?.sha256 === next.sha256) return previous;
    if (previous) {
      const { data: ignored, ...envelope } = previous;
      await this.atomic(
        this.snapshotPath("previous"),
        JSON.stringify(envelope),
      );
    }
    await this.atomic(this.snapshotPath("latest"), JSON.stringify(next));
    const verified = await this.snapshot("latest");
    if (verified.sha256 !== next.sha256) throw Error("备份写入后校验不一致");
    return verified;
  }
  load() {
    return this.serial(async () => {
      try {
        await this.readReferences();
        const image = await this.image(this.file);
        const latest = await this.snapshot("latest");
        const anchor = await this.snapshot("baseline");
        if (!image.exists) {
          if (
            latest ||
            anchor ||
            this.current ||
            this.reference.initialTicketIds?.length
          )
            throw Error("已存在登记依据，但主账本缺失；已禁止重新启用");
          this.info = {
            state: "new",
            blocked: false,
            backupDir: this.backupDir,
            backup: null,
          };
          return null;
        }
        if (image.oversized)
          throw Error("主账本超过10MiB上限，保留原文件并停止写入");
        const data = validateLedger(JSON.parse(image.raw), this.reference);
        if (anchor) assertForward(data, anchor.data);
        if (this.current) assertForward(data, this.current);
        if ((anchor && !latest) || (latest && latest.sha256 !== image.hash))
          throw Error("主账本与最近验证备份不一致，已停止自动写入");
        const backup = await this.capture(image.raw);
        this.current = structuredClone(data);
        this.currentHash = image.hash;
        this.info = {
          state: "ready",
          blocked: false,
          backupDir: this.backupDir,
          backup: this.summary(backup),
          quarantinedFile: this.info.quarantinedFile || null,
        };
        return structuredClone(data);
      } catch (e) {
        await this.block(e);
        throw e;
      }
    });
  }
  write(data) {
    // Clone at enqueue time; no caller mutation can change an in-flight commit.
    const next = structuredClone(data);
    return this.serial(async () => {
      try {
        if (this.info.blocked)
          throw Error("账本保护中，禁止写入；请先核对并恢复");
        validateLedger(next, this.reference);
        if (this.current) assertForward(next, this.current);
        const image = await this.image(this.file);
        if (image.hash !== this.currentHash)
          throw Error("主账本在运行期间被更改，已停止写入");
        const raw = JSON.stringify(next);
        // A verified backup is durable BEFORE replacing the main file.
        const backup = await this.capture(raw);
        if ((await this.image(this.file)).hash !== this.currentHash)
          throw Error("保存期间主账本改变，禁止覆盖");
        await this.atomic(this.file, raw);
        if ((await this.image(this.file)).hash !== digest(raw))
          throw Error("主账本保存后校验失败");
        this.current = next;
        this.currentHash = digest(raw);
        this.info = {
          state: "ready",
          blocked: false,
          backupDir: this.backupDir,
          backup: this.summary(backup),
          quarantinedFile: this.info.quarantinedFile || null,
        };
      } catch (e) {
        await this.block(e);
        throw e;
      }
    });
  }
  restore(token) {
    return this.serial(async () => {
      try {
        if (!this.info.blocked) return structuredClone(this.current);
        await this.readReferences();
        const image = await this.image(this.file);
        const latest = await this.candidate(image);
        if (!latest || token !== digest(image.hash + ":" + latest.sha256))
          throw Error("恢复依据已变化，请重新检查后查看最新预览");
        await this.resources(
          (image.size || 0) + Buffer.byteLength(latest.raw) * 3,
        );
        let quarantinedFile = this.info.quarantinedFile || null;
        if (image.exists) {
          quarantinedFile = path.join(
            this.backupDir,
            "quarantine",
            `${Date.now()}-${randomUUID()}.json`,
          );
          await this.safe(quarantinedFile);
          await this.io.mkdir(path.dirname(quarantinedFile), {
            recursive: true,
          });
          await this.io.copyFile(this.file, quarantinedFile, 1); // COPYFILE_EXCL
          if ((await hashFile(this.file)) !== (await hashFile(quarantinedFile)))
            throw Error("原文件留存校验失败，未执行恢复");
          this.info.quarantinedFile = quarantinedFile;
        }
        if ((await this.image(this.file)).hash !== image.hash)
          throw Error("恢复前主账本发生变化，禁止覆盖");
        await this.atomic(this.file, latest.raw);
        if ((await this.image(this.file)).hash !== latest.sha256)
          throw Error("恢复后主文件校验失败");
        this.current = structuredClone(latest.data);
        this.currentHash = latest.sha256;
        this.info = {
          state: "ready",
          blocked: false,
          backupDir: this.backupDir,
          backup: this.summary(latest),
          quarantinedFile,
        };
        return structuredClone(latest.data);
      } catch (e) {
        await this.block(e);
        throw e;
      }
    });
  }
}
