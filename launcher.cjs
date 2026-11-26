const fs = require("node:fs");
const path = require("node:path");
const net = require("node:net");
const { randomUUID } = require("node:crypto");
const { spawn } = require("node:child_process");

const root = fs.existsSync(path.join(__dirname, "server/index.js"))
  ? __dirname
  : path.dirname(__dirname);
const runtime = path.join(root, ".runtime");
const stateFile = path.join(runtime, "portable-server.json");

async function health(port) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/health`, {
      signal: AbortSignal.timeout(1500),
    });
    return response.ok ? await response.json() : null;
  } catch {
    return null;
  }
}
async function available(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => server.close(() => resolve(true)));
  });
}
async function run() {
  if (fs.existsSync(path.join(root, "reports/ten-day-review-2026-10-30/plan.json")))
    throw Error("该目录已有原验证计划，请使用原启动入口；便携版应在独立解压目录运行。");
  if (/^e:/i.test(root) || /^e:/i.test(fs.realpathSync(root)))
    throw Error("E 盘处于冻结状态，请放在其他可写目录。");
  const disk = fs.statfsSync(root);
  if (disk.bavail * disk.bsize < 1024 ** 3)
    throw Error("解压目录所在磁盘不足 1 GB。");
  fs.mkdirSync(path.join(runtime, "tmp"), { recursive: true });
  const lockFile = path.join(runtime, "launcher.lock");
  let lock;
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      lock = fs.openSync(lockFile, "wx");
      fs.writeFileSync(lock, String(process.pid));
      break;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      const owner = Number(fs.readFileSync(lockFile, "utf8"));
      if (!Number.isInteger(owner) || owner <= 0)
        throw Error("启动锁异常，请保留文件后核对。");
      try {
        process.kill(owner, 0);
      } catch (probe) {
        if (probe.code === "ESRCH") {
          fs.unlinkSync(lockFile);
          continue;
        }
        throw probe;
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  if (lock === undefined) throw Error("另一启动检查尚未完成，请稍后重开。");
  try {
    let saved = null;
    try {
      saved = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    } catch (error) {
      if (error.code !== "ENOENT")
        throw Error(
          "启动记录损坏，请保留 .runtime/portable-server.json 后核对。",
        );
    }
    if (
      saved &&
      (!Number.isInteger(saved.port) ||
        saved.port < 1024 ||
        saved.port > 65535 ||
        typeof saved.instanceId !== "string" ||
        !/^[a-f0-9-]{36}$/.test(saved.instanceId))
    )
      throw Error("启动记录格式异常，请保留文件后核对。");
    let current = saved ? await health(saved.port) : null;
    const ours =
      current?.app === "ashare-screener" &&
      current.instanceId === saved?.instanceId;
    if (process.argv.includes("--stop")) {
      if (!ours) {
        console.log("本目录的软件当前未运行。");
        return;
      }
      const response = await fetch(
        `http://127.0.0.1:${saved.port}/api/state?summary=1`,
        {
          signal: AbortSignal.timeout(3000),
        },
      );
      if (!response.ok) throw Error("无法核对任务状态，保留正在运行的服务。");
      const state = await response.json();
      const dailyResponse = await fetch(
        `http://127.0.0.1:${saved.port}/api/view/daily/status`,
        { signal: AbortSignal.timeout(3000) },
      );
      if (!dailyResponse.ok)
        throw Error("无法核对交易日任务，保留正在运行的服务。");
      const daily = await dailyResponse.json();
      if (
        state.dailyActive ||
        daily.calendar?.active ||
        state.trendActive ||
        state.researchActive ||
        state.dpoActive ||
        state.refresh?.running ||
        ["running", "stopping"].includes(state.job?.status)
      )
        throw Error(
          "有任务运行，请先在页面停止任务并等待保存完成，再关闭软件。",
        );
      if (!Number.isInteger(current.pid) || current.pid <= 0)
        throw Error("服务进程身份无效。");
      process.kill(current.pid);
      console.log("本目录的软件已关闭。");
      return;
    }
    let port = saved?.port;
    if (!ours) {
      port = null;
      for (let candidate = 8765; candidate < 8785; candidate++) {
        if (await available(candidate)) {
          port = candidate;
          break;
        }
      }
      if (!port)
        throw Error("8765–8784 端口均已占用，请关闭不用的软件后重试。");
      const instanceId = randomUUID();
      const log = fs.openSync(path.join(runtime, "app.log"), "a");
      const child = spawn(
        process.execPath,
        ["--max-old-space-size=768", path.join(root, "server/index.js")],
        {
          cwd: root,
          detached: true,
          windowsHide: true,
          stdio: ["ignore", log, log],
          env: {
            ...process.env,
            PATH: (process.env.PATH || "")
              .split(";")
              .filter((p) => !/^\s*"?e:/i.test(p))
              .join(";"),
            SCREENER_PORTABLE: "1",
            SCREENER_PORT: String(port),
            SCREENER_INSTANCE_ID: instanceId,
            TEMP: path.join(runtime, "tmp"),
            TMP: path.join(runtime, "tmp"),
          },
        },
      );
      fs.closeSync(log);
      let spawnError = null;
      child.once("error", (error) => {
        spawnError = error;
      });
      child.unref();
      for (let attempt = 0; attempt < 40; attempt++) {
        if (spawnError) throw spawnError;
        current = await health(port);
        if (current?.instanceId === instanceId) break;
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      if (current?.instanceId !== instanceId)
        throw Error("启动未完成，请查看 .runtime/app.log。");
      const temporary = stateFile + ".tmp";
      fs.writeFileSync(temporary, JSON.stringify({ port, instanceId }));
      fs.renameSync(temporary, stateFile);
    }
    const url = `http://127.0.0.1:${port}/`;
    console.log("A股选股台已启动：" + url);
    if (!process.argv.includes("--no-browser")) {
      const shell = path.join(
        process.env.SystemRoot || "C:\\Windows",
        "System32/cmd.exe",
      );
      if (/^e:/i.test(shell)) throw Error("浏览器启动工具位于冻结盘。");
      const browser = spawn(shell, ["/c", "start", "", url], {
        detached: true,
        windowsHide: true,
        stdio: "ignore",
      });
      browser.on("error", () => console.log("请在浏览器打开上方地址。"));
      browser.unref();
    }
  } finally {
    fs.closeSync(lock);
    fs.unlinkSync(lockFile);
  }
}
run().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
