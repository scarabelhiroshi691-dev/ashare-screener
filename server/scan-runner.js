export function summarizeJob(job) {
  if (!job?.items) return job;
  const terminal = job.items.filter((i) =>
    ["matched", "unmatched", "failed"].includes(i.state),
  );
  job.done = terminal.length;
  job.failed = job.items.filter((i) => i.state === "failed").length;
  job.unmatched = job.items.filter((i) => i.state === "unmatched").length;
  job.cacheHits = job.items.filter(
    (i) => ["matched", "unmatched"].includes(i.state) && i.fromCache,
  ).length;
  job.results = job.items
    .filter((i) => i.state === "matched")
    .map((i) => i.result)
    .sort((a, b) => b.amount - a.amount);
  job.errors = job.items
    .filter((i) => i.state === "failed")
    .map((i) => ({
      symbol: i.stock.symbol,
      name: i.stock.name,
      ...i.error,
      attempts: i.attempts,
    }));
  job.pending = job.target - job.done;
  job.nearMiss = job.items
    .filter(
      (i) =>
        i.state === "unmatched" &&
        i.evidence?.checks.filter((c) => !c.pass).length === 1,
    )
    .slice(0, 20)
    .map((i) => i.evidence);
  return job;
}

export async function runItems(
  job,
  indices,
  { signal, load, evaluate, save, onResourceError, beforeItem },
) {
  let transientStreak = 0;
  job.fatal = null;
  job.waiting = null;
  job.status = "running";
  try {
    for (let position = 0; position < indices.length; position++) {
      if (signal.aborted) break;
      if (await beforeItem?.(indices.slice(position))) {
        job.status = "paused";
        break;
      }
      const index = indices[position];
      const item = job.items[index],
        previous = item.state;
      item.state = "running";
      item.attempts++;
      job.current = { symbol: item.stock.symbol, name: item.stock.name };
      try {
        const history = await load(item.stock, signal, (event) => {
          if (event.type === "request") {
            job.networkRequests++;
            if (event.attempt > 1) job.networkRetries++;
            job.waiting = null;
          }
          if (["retry", "waiting"].includes(event.type))
            job.waiting = { ...event, name: item.stock.name };
        });
        signal.throwIfAborted();
        const result = evaluate(item.stock, history, item);
        item.state = result ? "matched" : "unmatched";
        item.result = result;
        item.error = null;
        item.fromCache = history.fromCache;
        item.source = history.source;
        transientStreak = 0;
      } catch (error) {
        if (signal.aborted) {
          item.state = previous === "failed" ? "failed" : "pending";
          break;
        }
        item.state = "failed";
        item.result = null;
        item.error = {
          message: error.message,
          kind: error.kind || "data",
          retryAt: error.retryAt || null,
        };
        transientStreak = error.kind === "transient" ? transientStreak + 1 : 0;
        if (["ENOSPC", "EACCES", "EIO", "EPERM", "EROFS"].includes(error.code))
          throw error;
        if (
          ["blocked", "cooldown"].includes(error.kind) ||
          transientStreak >= 3
        ) {
          job.fatal =
            error.kind === "transient"
              ? "数据源连续不可用，进度已保存，可稍后重试与续跑。"
              : error.message;
          job.status = "paused";
        }
      }
      summarizeJob(job);
      job.waiting = null;
      await save(job);
      if (job.status === "paused") break;
    }
    if (signal.aborted) job.status = "stopped";
    else if (job.status !== "paused")
      job.status = job.pending
        ? "paused"
        : job.failed
          ? "partial"
          : "completed";
  } catch (error) {
    job.status = "paused";
    job.fatal = error.message;
    onResourceError?.(error);
  } finally {
    job.current = null;
    job.waiting = null;
    job.finishedAt = new Date().toISOString();
    summarizeJob(job);
    try {
      await save(job);
    } catch (error) {
      job.status = "paused";
      job.fatal = `无法保存进度：${error.message}`;
    }
  }
}

export function selectWork(job, mode, symbols) {
  if (!job?.items)
    throw new Error("旧版任务未保存逐股进度，请先开始一次新筛选。");
  if (
    symbols !== undefined &&
    (!Array.isArray(symbols) ||
      !symbols.length ||
      symbols.some((s) => typeof s !== "string"))
  )
    throw new Error("请选择有效失败股票。");
  const wanted = mode === "retry" ? "failed" : "pending";
  if (
    symbols?.some(
      (s) => !job.items.some((i) => i.stock.symbol === s && i.state === wanted),
    )
  )
    throw new Error("请求包含不在本任务待处理列表中的股票。");
  return job.items
    .map((i, index) => ({ i, index }))
    .filter(
      ({ i }) =>
        i.state === wanted && (!symbols || symbols.includes(i.stock.symbol)),
    )
    .map((x) => x.index);
}

export function recoverJob(job) {
  if (!job?.items) return job;
  for (const item of job.items)
    if (item.state === "running") item.state = "pending";
  if (["running", "stopping"].includes(job.status)) {
    job.status = "paused";
    job.fatal = "上次运行中断，已恢复保存的进度。";
  }
  job.waiting = null;
  job.current = null;
  return summarizeJob(job);
}
