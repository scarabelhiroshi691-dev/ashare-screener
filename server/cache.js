import {
  mkdir,
  readFile,
  writeFile,
  rename,
  readdir,
  stat,
  unlink,
  realpath,
  statfs,
  lstat,
} from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { root, dataDir } from "./paths.js";
export { root, dataDir } from "./paths.js";
const historyDir = path.join(dataDir, "history");
const LIMIT = 160 * 1024 * 1024;

export async function prepareStorage() {
  if (/^e:/i.test(await realpath(root)))
    throw new Error("E 盘处于冻结状态，不能启动本项目。");
  for (const dir of [dataDir, historyDir]) {
    await mkdir(dir, { recursive: true });
    if (/^e:/i.test(await realpath(dir)) || (await lstat(dir)).isSymbolicLink())
      throw new Error("数据目录不能链接到其他位置。");
  }
  await pruneHistory();
}

export async function resourceCheck() {
  const disk = await statfs(root);
  if (disk.bavail * disk.bsize < 1024 ** 3)
    throw new Error("项目所在磁盘剩余空间低于 1 GB，已停止数据写入。");
  if (process.memoryUsage().rss > 1024 ** 3)
    throw new Error("进程内存超过 1 GB，已停止当前扫描。");
}

function cachePath(key) {
  if (
    !/^(market|eod|last-scan|last-trend|research|last-research|daily|daily-schedule|trading-calendar|history\/[a-z0-9-]+)$/.test(
      key,
    )
  )
    throw new Error("无效缓存名称");
  return path.join(dataDir, `${key}.json`);
}

export async function readCache(key) {
  try {
    const file = cachePath(key);
    if ((await stat(file)).size > 15 * 1024 * 1024) return null;
    return JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if (
      ["ENOENT", "ENOTDIR"].includes(error.code) ||
      error instanceof SyntaxError
    )
      return null;
    throw error;
  }
}

export async function writeCache(key, value) {
  await resourceCheck();
  const file = cachePath(key);
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(value), "utf8");
  await rename(temporary, file);
}

export async function pruneHistory() {
  const entries = await readdir(historyDir, { withFileTypes: true });
  const files = await Promise.all(
    entries
      .filter((e) => e.isFile() && /^[a-z0-9-]+\.json$/.test(e.name))
      .map(async (e) => {
        const file = path.join(historyDir, e.name);
        const info = await stat(file);
        return { file, ...info };
      }),
  );
  let total = files.reduce((s, f) => s + f.size, 0);
  for (const file of files.sort((a, b) => a.mtimeMs - b.mtimeMs)) {
    if (total <= LIMIT && Date.now() - file.mtimeMs < 7 * 86400000) continue;
    await unlink(file.file);
    total -= file.size;
  }
}
