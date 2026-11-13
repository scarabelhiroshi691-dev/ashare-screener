import { spawn } from "node:child_process";
import { realpath, access } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { root } from "./cache.js";
import { createHistoryClient, DataError } from "./history-client.js";

let worker = null,
  active = null,
  idle = null;
export function closeBaoStock() {
  clearTimeout(idle);
  worker?.kill();
  worker = null;
}
async function ensureWorker() {
  if (worker) return worker;
  const python =
    process.env.SCREENER_PYTHON ||
    (process.platform === "win32"
      ? path.join(
          process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData/Local"),
          "Programs/Python/Python312/python.exe",
        )
      : "python3");
  if (/^e:/i.test(python))
    throw new DataError("Python 不能位于冻结的 E 盘。", "permanent");
  try {
    if (/^e:/i.test(await realpath(python)))
      throw new Error("Python 路径指向 E 盘");
    await access(path.join(root, ".runtime/python-deps/baostock/__init__.py"));
  } catch {
    throw new DataError("BaoStock 本地依赖不可用。", "permanent");
  }
  const child = spawn(
    python,
    ["-S", "-u", path.join(root, "server/baostock-worker.py")],
    {
      cwd: root,
      windowsHide: true,
      stdio: ["pipe", "pipe", "ignore"],
      env: {
        ...process.env,
        PATH: (process.env.PATH || "")
          .split(";")
          .filter((p) => !/^e:/i.test(p))
          .join(";"),
        PYTHONPATH: "",
        PYTHONDONTWRITEBYTECODE: "1",
        PYTHONIOENCODING: "utf-8",
        TEMP: path.join(root, ".runtime/tmp"),
        TMP: path.join(root, ".runtime/tmp"),
      },
    },
  );
  worker = child;
  let buffer = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    if (buffer.length > 5 * 1024 * 1024) {
      active?.reject(new DataError("BaoStock 响应过大", "data"));
      child.kill();
      return;
    }
    const end = buffer.indexOf("\n");
    if (end >= 0) {
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      try {
        const payload = JSON.parse(line);
        if (payload.error)
          active?.reject(new DataError(payload.error, "transient"));
        else active?.resolve(payload);
      } catch {
        active?.reject(new DataError("BaoStock 返回格式异常", "data"));
      }
    }
  });
  child.on("error", (error) =>
    active?.reject(new DataError(error.message, "transient")),
  );
  child.stdin.on("error", (error) =>
    active?.reject(new DataError(error.message, "transient")),
  );
  child.on("exit", () => {
    if (worker === child) worker = null;
    if (active?.child === child)
      active.reject(new DataError("BaoStock 数据连接已关闭", "transient"));
  });
  return child;
}
async function request(input, signal) {
  clearTimeout(idle);
  const child = await ensureWorker();
  signal?.throwIfAborted();
  try {
    return await new Promise((resolve, reject) => {
      const abort = () => {
        child.kill();
        reject(signal.reason);
      };
      const finish = (fn, value) => {
        signal?.removeEventListener("abort", abort);
        fn(value);
      };
      active = {
        child,
        resolve: (value) => finish(resolve, value),
        reject: (error) => finish(reject, error),
      };
      signal?.addEventListener("abort", abort, { once: true });
      child.stdin.write(JSON.stringify(input) + "\n", (error) => {
        if (error) active?.reject(error);
      });
    });
  } finally {
    active = null;
    idle = setTimeout(closeBaoStock, 60000);
    idle.unref();
  }
}
// Reuse the same tested pacing / bounded retries / cancellation policy as HTTP.
export const baoClient = createHistoryClient({
  fetchImpl: async (input, { signal }) =>
    new Response(JSON.stringify(await request(input, signal))),
});

export function parseBaoStock(payload, symbol, parseBars) {
  const code = symbol.slice(0, 2) + "." + symbol.slice(2);
  if (
    payload.code !== code ||
    !payload.rows?.length ||
    payload.rows.some(
      (r) => r[1] !== code || r[7] !== "2" || !["0", "1"].includes(r[8]),
    )
  )
    throw new DataError("BaoStock 缺少有效前复权日线。", "data");
  // BaoStock already reports shares; preserve the original integer exactly.
  return parseBars(
    {
      code: 0,
      data: {
        [symbol]: {
          qfqday: payload.rows
            .filter((r) => r[8] === "1")
            .map((r) => [r[0], r[2], r[3], r[4], r[5], r[6]]),
        },
      },
    },
    symbol,
    1,
  );
}
