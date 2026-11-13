import http from "node:http";
import path from "node:path";
import { readFile, stat, writeFile, mkdir } from "node:fs/promises";
import { Store } from "./store.js";
import { root, prepareStorage } from "./cache.js";
import { closeBaoStock } from "./baostock.js";
import { StatusViews } from "./status-view.js";
import { TrendArchive } from "./trend-archive.js";

await prepareStorage();
const store = new Store();
await store.init();
const views = new StatusViews(store);
const trendArchive = new TrendArchive();
store.trend.archive = trendArchive;
await trendArchive.init();
await store.trend.archiveCurrent().catch(() => {});
const port = Number(process.env.SCREENER_PORT || 8765);
if (!Number.isInteger(port) || port < 1024 || port > 65535)
  throw new Error("端口应在 1024–65535 之间");
const dev = process.argv.includes("--dev");
const vite = dev
  ? await (
      await import("vite")
    ).createServer({ root, server: { middlewareMode: true }, appType: "spa" })
  : null;
const dist = path.join(root, "dist");
const types = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".webmanifest": "application/manifest+json; charset=utf-8",
};
function send(res, status, value) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(value));
}
async function body(req) {
  if (!req.headers["content-type"]?.startsWith("application/json"))
    throw new Error("请求必须使用 JSON。");
  let text = "";
  for await (const data of req) {
    text += data;
    if (Buffer.byteLength(text) > 32768) throw new Error("请求内容过大。");
  }
  return JSON.parse(text || "{}");
}
const server = http.createServer(async (req, res) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  const host = req.headers.host;
  if (![`127.0.0.1:${port}`, `localhost:${port}`].includes(host)) {
    send(res, 403, { error: "仅允许本机访问。" });
    return;
  }
  const url = new URL(req.url, `http://127.0.0.1:${port}`);
  try {
    if (url.pathname.startsWith("/api/")) {
      if (req.method === "POST") {
        const origin = req.headers.origin;
        if (
          origin &&
          ![`http://127.0.0.1:${port}`, `http://localhost:${port}`].includes(
            origin,
          )
        ) {
          send(res, 403, { error: "不允许跨站请求。" });
          return;
        }
      }
      if (req.method === "GET" && url.pathname === "/api/health")
        return send(res, 200, {
          app: "ashare-screener",
          version: "1.0.0",
          pid: process.pid,
          instanceId: process.env.SCREENER_INSTANCE_ID || undefined,
        });
      if (req.method === "GET" && url.pathname === "/api/state") {
        const state = store.state();
        if (url.searchParams.get("summary") === "1" && state.job) {
          const { results, nearMiss, errors, ...job } = state.job;
          state.job = job;
        }
        return send(res, 200, state);
      }
      const view =
        /^\/api\/view\/(trend|daily|reports|archive)\/(status|rows|export)$/.exec(
          url.pathname,
        );
      if (req.method === "GET" && view) {
        const [, kind, operation] = view;
        if (operation === "status")
          return send(
            res,
            200,
            kind === "archive" ? trendArchive.state() : views.status(kind),
          );
        if (operation === "rows")
          return send(
            res,
            200,
            kind === "archive"
              ? await trendArchive.rows(url.searchParams)
              : views.rows(kind, url.searchParams),
          );
        const output =
          kind === "archive"
            ? await trendArchive.export(url.searchParams)
            : views.export(kind, url.searchParams);
        res.writeHead(200, {
          "Content-Type":
            output.format === "csv"
              ? "text/csv; charset=utf-8"
              : "application/json; charset=utf-8",
          "Content-Disposition": `attachment; filename="${output.name}"`,
          "Cache-Control": "no-store",
          "X-Record-Count": String(output.count),
        });
        return res.end(output.body);
      }
      if (req.method === "GET" && url.pathname === "/api/daily")
        return send(res, 200, store.daily.state());
      if (req.method === "GET" && url.pathname === "/api/daily/reports")
        return send(res, 200, store.daily.reports.state());
      if (
        req.method === "POST" &&
        url.pathname === "/api/daily/reports/prepare"
      ) {
        await body(req);
        await store.daily.reports.refresh();
        return send(res, 200, store.daily.reports.state());
      }
      if (req.method === "GET" && url.pathname === "/api/daily/reports/file") {
        const day = Number(url.searchParams.get("day")),
          format = url.searchParams.get("format") || "md";
        const text = await store.daily.reports.document(day, format);
        res.writeHead(200, {
          "Content-Type":
            format === "json"
              ? "application/json; charset=utf-8"
              : "text/plain; charset=utf-8",
          "Cache-Control": "no-store",
          "Content-Disposition": `inline; filename="day-${day}.${format === "json" ? "json" : "md"}"`,
        });
        return res.end(text);
      }
      if (
        req.method === "POST" &&
        /^\/api\/daily\/reports\/notifications\/(claim|ack|release)$/.test(
          url.pathname,
        )
      )
        return send(
          res,
          200,
          await store.daily.reports.notification(
            url.pathname.split("/").at(-1),
            await body(req),
          ),
        );
      if (
        req.method === "POST" &&
        url.pathname === "/api/daily/calendar/refresh"
      ) {
        await body(req);
        return send(res, 202, await store.daily.refreshCalendar());
      }
      if (
        req.method === "POST" &&
        ["/api/daily/storage/check", "/api/daily/storage/restore"].includes(
          url.pathname,
        )
      ) {
        const input = await body(req);
        const restore = url.pathname.endsWith("restore");
        if (restore && !/^[a-f0-9]{64}$/.test(input?.token || ""))
          throw Error("请先查看最近验证备份的恢复预览");
        return send(
          res,
          200,
          await store.daily.storageAction(
            restore ? "restore" : "check",
            input.token,
          ),
        );
      }
      if (req.method === "GET" && url.pathname === "/api/trend")
        return send(res, 200, store.trend.state());
      if (req.method === "POST" && url.pathname === "/api/trend/start")
        return send(res, 202, await store.trend.start(await body(req)));
      if (
        req.method === "POST" &&
        ["/api/trend/resume", "/api/trend/retry"].includes(url.pathname)
      ) {
        const input = await body(req);
        return send(
          res,
          202,
          await store.trend.continue(
            url.pathname.endsWith("retry") ? "retry" : "resume",
            input.symbols,
          ),
        );
      }
      if (req.method === "POST" && url.pathname === "/api/trend/stop") {
        await body(req);
        await store.trend.stop();
        return send(res, 200, { stopped: true });
      }
      if (req.method === "GET" && url.pathname === "/api/trend/history") {
        const controller = new AbortController();
        res.on("close", () => controller.abort());
        return send(
          res,
          200,
          await store.trend.detail(
            url.searchParams.get("symbol"),
            url.searchParams.get("asOf"),
            controller.signal,
          ),
        );
      }
      if (req.method === "POST" && url.pathname === "/api/daily/activate") {
        await body(req);
        return send(res, 200, await store.daily.activate());
      }
      if (req.method === "POST" && url.pathname === "/api/daily/run") {
        await body(req);
        return send(res, 202, await store.daily.start());
      }
      if (req.method === "POST" && url.pathname === "/api/daily/advance") {
        const input = await body(req);
        if (typeof input?.asOf !== "string")
          throw Error("请选择模拟推进截止日期");
        return send(res, 202, await store.daily.start(false, input.asOf));
      }
      if (req.method === "POST" && url.pathname === "/api/daily/stop") {
        await body(req);
        store.daily.stop();
        return send(res, 200, { stopped: true });
      }
      if (req.method === "GET" && url.pathname === "/api/research")
        return send(res, 200, {
          records: store.research.list(),
          job: store.research.job,
          active: store.research.active,
        });
      if (req.method === "GET" && url.pathname === "/api/research/record")
        return send(
          res,
          200,
          store.research.record(url.searchParams.get("id")),
        );
      if (req.method === "POST" && url.pathname === "/api/research/start")
        return send(res, 202, await store.research.start(await body(req)));
      if (req.method === "POST" && url.pathname === "/api/research/stop") {
        await body(req);
        store.research.stop();
        return send(res, 200, { stopped: true });
      }
      if (req.method === "GET" && url.pathname === "/api/market")
        return send(res, 200, {
          meta: store.marketMeta(),
          stocks: store.market?.stocks || [],
        });
      if (req.method === "GET" && url.pathname === "/api/history") {
        const controller = new AbortController();
        res.on("close", () => controller.abort());
        return send(
          res,
          200,
          await store.detail(
            url.searchParams.get("symbol"),
            url.searchParams.get("asOf"),
            controller.signal,
          ),
        );
      }
      if (req.method === "POST" && url.pathname === "/api/market/refresh") {
        await body(req);
        await store.startRefresh();
        return send(res, 202, { started: true });
      }
      if (req.method === "POST" && url.pathname === "/api/market/stop") {
        await body(req);
        store.stopRefresh();
        return send(res, 200, { stopped: true });
      }
      if (req.method === "POST" && url.pathname === "/api/scan")
        return send(res, 202, await store.startScan(await body(req)));
      if (
        req.method === "POST" &&
        ["/api/scan/retry", "/api/scan/resume"].includes(url.pathname)
      ) {
        const input = await body(req);
        return send(
          res,
          202,
          await store.continueScan(
            url.pathname.endsWith("retry") ? "retry" : "resume",
            input.symbols,
          ),
        );
      }
      if (req.method === "POST" && url.pathname === "/api/scan/stop") {
        await body(req);
        store.stopScan();
        return send(res, 200, { stopped: true });
      }
      if (req.method === "POST" && url.pathname === "/api/quotes") {
        const input = await body(req);
        if (!Array.isArray(input.symbols)) throw new Error("缺少股票列表。");
        return send(res, 200, await store.quotes(input.symbols));
      }
      return send(res, 404, { error: "接口不存在。" });
    }
    if (req.method !== "GET" && req.method !== "HEAD")
      return send(res, 405, { error: "不支持该请求方法。" });
    if (vite)
      return vite.middlewares(req, res, () =>
        send(res, 404, { error: "页面不存在" }),
      );
    const pathname = decodeURIComponent(url.pathname);
    const file = path.resolve(
      dist,
      `.${pathname === "/" ? "/index.html" : pathname}`,
    );
    if (!file.startsWith(dist + path.sep))
      return send(res, 403, { error: "无效路径。" });
    const extension = path.extname(file);
    if (!types[extension]) return send(res, 404, { error: "文件不存在。" });
    const info = await stat(file);
    if (!info.isFile()) return send(res, 404, { error: "文件不存在。" });
    res.writeHead(200, {
      "Content-Type": types[extension],
      "Cache-Control":
        extension === ".html" ? "no-cache" : "public, max-age=3600",
    });
    res.end(req.method === "HEAD" ? undefined : await readFile(file));
  } catch (error) {
    send(
      res,
      error.status === 409 ? 409 : error.code === "ENOENT" ? 404 : 400,
      {
        error:
          error.code === "ENOENT"
            ? "尚未构建界面，请先运行 npm run build。"
            : error.message,
      },
    );
  }
});
server.requestTimeout = 30000;
server.listen(port, "127.0.0.1", async () => {
  await mkdir(path.join(root, ".runtime"), { recursive: true });
  await writeFile(
    path.join(root, ".runtime", "server.json"),
    JSON.stringify({
      pid: process.pid,
      port,
      root,
      startedAt: new Date().toISOString(),
    }),
  );
  console.log(`A股选股台：http://127.0.0.1:${port}`);
});
server.on("error", (error) => {
  console.error(
    error.code === "EADDRINUSE"
      ? `端口 ${port} 已被占用，未终止其他程序。`
      : error.message,
  );
  process.exitCode = 1;
});
function shutdown() {
  clearInterval(store.dailyTimer);
  store.daily.stop("shutdown");
  store.research.stop();
  store.trend.stop();
  closeBaoStock();
  store.stopScan();
  store.stopRefresh();
  clearInterval(store.monitor);
  server.close();
  vite?.close();
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
