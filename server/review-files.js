import {
  readFile,
  writeFile,
  lstat,
  mkdir,
  rename,
  open,
  statfs,
} from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { dataDir, resourceCheck } from "./cache.js";
import { reviewDir, backupRoot } from "./paths.js";

export { reviewDir } from "./paths.js";
export const hash = (value) =>
  createHash("sha256")
    .update(typeof value === "string" ? value : JSON.stringify(value))
    .digest("hex");
// All callers supply fixed paths, never a path from an HTTP request or report metadata.
async function safeDirectory(dir) {
  const resolved = path.resolve(dir);
  if (/^e:/i.test(resolved)) throw Error("E盘冻结");
  const base = path.parse(resolved).root;
  let current = base;
  for (const part of resolved
    .slice(base.length)
    .split(path.sep)
    .filter(Boolean)) {
    current = path.join(current, part);
    try {
      if ((await lstat(current)).isSymbolicLink())
        throw Error("报告路径不能使用目录链接");
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
      await mkdir(current);
    }
  }
}
async function boundedRead(file, limit) {
  await safeDirectory(path.dirname(file));
  try {
    const st = await lstat(file);
    if (!st.isFile() || st.isSymbolicLink() || st.size > limit)
      throw Error("报告文件类型或大小异常");
    return await readFile(file, "utf8");
  } catch (e) {
    if (e.code === "ENOENT") return null;
    throw e;
  }
}
async function atomicWrite(file, text) {
  await resourceCheck();
  await safeDirectory(path.dirname(file));
  const disk = await statfs(path.dirname(file));
  if (disk.bavail * disk.bsize < 1024 ** 3)
    throw Error("报告或备份磁盘空间不足1GiB");
  try {
    if ((await lstat(file)).isSymbolicLink())
      throw Error("报告文件不能使用链接");
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
  const temp = file + `.${randomUUID()}.tmp`;
  const handle = await open(temp, "wx");
  try {
    await handle.writeFile(text, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temp, file);
  if ((await readFile(file, "utf8")) !== text) throw Error("报告写入复验失败");
}
function unwrap(text) {
  if (!text) return null;
  const value = JSON.parse(text);
  if (!value.data || value.sha256 !== hash(value.data))
    throw Error("报告登记校验失败");
  return value.data;
}
export class ReviewFiles {
  constructor({
    dir = reviewDir,
    stateFile = path.join(dataDir, "review-reports.json"),
    backupFile = path.join(backupRoot, "reports/latest.json"),
  } = {}) {
    Object.assign(this, { dir, stateFile, backupFile });
  }
  async readState() {
    const a = await boundedRead(this.stateFile, 256 * 1024),
      b = await boundedRead(this.backupFile, 256 * 1024);
    if (a !== b && (a || b))
      throw Error(
        "报告登记与F盘备份不一致或缺失，已停止自动报告／通知；保留两份文件供核验",
      );
    return unwrap(a);
  }
  async writeState(data) {
    const text = JSON.stringify({ data, sha256: hash(data) });
    await atomicWrite(this.backupFile, text);
    await atomicWrite(this.stateFile, text);
  }
  async readPlan() {
    return JSON.parse(
      await boundedRead(path.join(this.dir, "plan.json"), 2 * 1024 ** 2),
    );
  }
  async initializePlan(plan) {
    await safeDirectory(this.dir);
    const file = await open(path.join(this.dir, "plan.json"), "wx");
    try {
      await file.writeFile(JSON.stringify(plan), "utf8");
      await file.sync();
    } finally {
      await file.close();
    }
  }
  async readComparison() {
    return JSON.parse(
      await boundedRead(
        path.join(this.dir, "first-batch-comparison.json"),
        2 * 1024 ** 2,
      ),
    );
  }
  async legacy(day) {
    const file = path.join(this.dir, `day-${day}.md`);
    const text = await boundedRead(file, 2 * 1024 ** 2);
    if (!text) throw Error(`原第${day}天报告缺失，不能标为已准备`);
    return { text, file, sha256: hash(text) };
  }
  async readBundle(day) {
    const text = await boundedRead(
      path.join(this.dir, `day-${day}.bundle.json`),
      14 * 1024 ** 2,
    );
    return unwrap(text);
  }
  async bundle(day, data) {
    const existing = await this.readBundle(day);
    if (existing) return existing;
    const text = JSON.stringify({ data, sha256: hash(data) });
    if (Buffer.byteLength(text) > 14 * 1024 ** 2)
      throw Error("阶段快照超过14MiB，未登记报告");
    await atomicWrite(path.join(this.dir, `day-${day}.bundle.json`), text);
    return data;
  }
  async markdown(day, md) {
    const file = path.join(this.dir, `day-${day}.md`);
    const old = await boundedRead(file, 2 * 1024 ** 2);
    if (old !== null && old !== md)
      throw Error(`第${day}天已有不同报告，保留原文件并停止覆盖`);
    if (old === null) await atomicWrite(file, md);
    return file;
  }
}
