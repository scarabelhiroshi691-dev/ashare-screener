import { isDeepStrictEqual } from "node:util";

export const reviewLimitations =
  "仅统计已退出且净收益完整的信号，已含每边10bp成本及5bp滑点；未成熟收益不计0。两套持有期和股票构成不同，同批股票相关，信号平均不等于资金账户收益，10个交易日不能证明长期稳定盈利。漏跑日不补记新信号。";
const states = ["pending", "holding", "exit-wait", "closed", "skipped"];
const finite = (x) => typeof x === "number" && Number.isFinite(x);

export function checkReviewIdentity(ledger, plan, comparison) {
  if (!plan || !isDeepStrictEqual(ledger.plans, plan.frozenPlans))
    throw Error("固定策略与原计划不一致，停止报告生成");
  const ids = plan.initialTicketIds;
  if (!Array.isArray(ids) || !ids.length || new Set(ids).size !== ids.length)
    throw Error("首批身份清单缺失或重复");
  if (new Set(ledger.tickets.map((t) => t.id)).size !== ledger.tickets.length)
    throw Error("账本存在重复信号身份");
  for (const t of ledger.tickets) {
    const p = plan.frozenPlans.find((p) => p.id === t.planId);
    if (
      !p ||
      !["ruleHash", "hold", "costBps", "slippageBps"].every(
        (k) => t[k] === p[k],
      )
    )
      throw Error(`信号规则不一致：${t.id}`);
  }
  if (comparison) {
    const original = [...comparison.shortIds, ...comparison.swingIds].sort();
    if (!isDeepStrictEqual(original, [...ids].sort()))
      throw Error("首批对比身份不一致");
    for (const frozen of comparison.shortFrozenResults) {
      const t = ledger.tickets.find((t) => t.id === frozen.id);
      if (
        t &&
        (!isDeepStrictEqual(
          {
            id: t.id,
            net: t.net,
            entryDate: t.entryDate,
            exitDate: t.exitDate,
          },
          frozen,
        ) ||
          t.state !== "closed")
      )
        throw Error(`已冻结短线结果变化：${frozen.id}`);
    }
  }
}
export function ticketView(t, asOf) {
  const complete =
    t.state === "closed" &&
    finite(t.net) &&
    !!t.exitDate &&
    t.exitDate <= asOf &&
    !t.error;
  const stale =
    ["pending", "holding", "exit-wait"].includes(t.state) &&
    t.signalDate < asOf &&
    (!t.asOf || t.asOf < asOf);
  const missing =
    t.state === "missing" ||
    !!t.error ||
    stale ||
    (t.state === "closed" && !complete);
  return {
    id: t.id,
    planId: t.planId,
    name: t.name || "原信号缺失",
    code: t.code || t.symbol,
    symbol: t.symbol,
    signalDate: t.signalDate,
    state: t.state,
    complete,
    missing,
    entryDate: t.entryDate || null,
    exitDate: t.exitDate || null,
    net: complete ? t.net : null,
    asOf: t.asOf || null,
    hold: t.hold,
    holdBars: t.holdBars ?? null,
    delayed: t.state === "exit-wait" || t.delayed > 0,
    delayedBars: t.delayed ?? null,
    source: t.source || null,
    reason:
      t.error ||
      t.reason ||
      (stale
        ? "尚未推进至本次核验截止日，需按原规则补采日线；不强制退出"
        : missing
          ? "已退出结果不完整或晚于核验截止日"
          : t.state === "exit-wait"
            ? "等待可退出的有效日线"
            : ""),
  };
}
export function summarizeRows(rows) {
  const nets = rows
    .filter((t) => t.complete)
    .map((t) => t.net)
    .sort((a, b) => a - b);
  const n = nets.length;
  return {
    total: rows.length,
    completed: n,
    average: n ? nets.reduce((a, b) => a + b, 0) / n : null,
    median: n
      ? (nets[Math.floor((n - 1) / 2)] + nets[Math.floor(n / 2)]) / 2
      : null,
    winRate: n ? (nets.filter((v) => v > 0).length / n) * 100 : null,
    worst: n ? nets[0] : null,
    best: n ? nets[n - 1] : null,
    uniqueStocks: new Set(rows.filter((t) => t.complete).map((t) => t.symbol))
      .size,
    states: Object.fromEntries(
      states.map((s) => [s, rows.filter((t) => t.state === s).length]),
    ),
    unfinished: rows.filter((t) =>
      ["pending", "holding", "exit-wait"].includes(t.state),
    ).length,
    missing: rows.filter((t) => t.missing).length,
    delayed: rows.filter((t) => t.delayed).length,
  };
}
export function compareGroups(groups) {
  if (
    groups.length !== 2 ||
    groups.some((g) => !g.total || g.completed !== g.total || g.missing)
  )
    return "完整比较暂不成立：仍有未完成、跳过或缺数信号；不混入浮动收益。";
  const metrics = [
    ["average", "平均"],
    ["median", "中位数"],
    ["winRate", "盈利比例"],
    ["worst", "最差单笔"],
  ];
  const wins = metrics.map(([k]) => Math.sign(groups[0][k] - groups[1][k]));
  const winner =
    wins.every((w) => w >= 0) && wins.some((w) => w > 0)
      ? 0
      : wins.every((w) => w <= 0) && wins.some((w) => w < 0)
        ? 1
        : null;
  if (winner !== null)
    return `本批已完成信号中，${groups[winner].name}在平均、中位数、盈利比例、最差单笔四项均不逊于另一套，综合表现较好；仅限本批模拟比较。`;
  return (
    "指标有分歧或持平：" +
    metrics
      .map(
        ([k, label], i) =>
          `${label}${wins[i] === 0 ? "持平" : groups[wins[i] > 0 ? 0 : 1].name + "较好"}`,
      )
      .join("；") +
    "。"
  );
}
function weekOf(date) {
  const d = new Date(date + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
}
export function buildReviewAnalysis(ledger, plan, calendar, comparison) {
  checkReviewIdentity(ledger, plan, comparison);
  const asOf = calendar.asOf || plan.baselineSignalDate;
  const initialIds = new Set(plan.initialTicketIds);
  const first = plan.initialTicketIds.map(
    (id) =>
      ledger.tickets.find((t) => t.id === id) || {
        id,
        planId: id.split(":")[0],
        symbol: id.split(":")[1],
        signalDate: plan.baselineSignalDate,
        state: "missing",
        error: "原首批ID未在账本中找到，请检查账本；不能当作0收益",
      },
  );
  const later = ledger.tickets.filter((t) => !initialIds.has(t.id));
  const group = (list, p) => {
    const rows = list
      .filter((t) => t.planId === p.id)
      .map((t) => ticketView(t, asOf));
    return {
      planId: p.id,
      name: p.name,
      hold: p.hold,
      ...summarizeRows(rows),
      rows,
    };
  };
  const cohort = (key, date, label, list) => {
    const groups = plan.frozenPlans.map((p) => group(list, p));
    return { key, date, label, groups, conclusion: compareGroups(groups) };
  };
  const cohorts = [
    cohort("first", plan.baselineSignalDate, "首批（原ID）", first),
    ...[...new Set(later.map((t) => t.signalDate))].sort().map((date) =>
      cohort(
        date,
        date,
        "后续批次",
        later.filter((t) => t.signalDate === date),
      ),
    ),
  ];
  const all = [...first, ...later];
  const weeks = [
    ...new Set(
      all
        .filter((t) => t.entryDate && t.entryDate <= asOf)
        .map((t) => weekOf(t.entryDate)),
    ),
  ]
    .sort()
    .map((date) =>
      cohort(
        date,
        date,
        "入场周（周一）",
        all.filter(
          (t) =>
            t.entryDate && t.entryDate <= asOf && weekOf(t.entryDate) === date,
        ),
      ),
    );
  const dailyIssues = ledger.days
    .filter((d) => d.date <= asOf)
    .flatMap((d) =>
      d.plans.flatMap((p) =>
        p.items
          .filter((i) => !["matched", "unmatched"].includes(i.state))
          .map((i) => ({
            date: d.date,
            planId: p.planId,
            name: i.stock.name,
            code: i.stock.code,
            state: i.state,
            reason: i.error || "尚未处理",
            retry: /不足|不含信号日/.test(i.error || "")
              ? "历史不足，不反复重试"
              : /拒绝|限流|冷却|403|429/i.test(i.error || "")
                ? "遵守冷却，勿绕过拒绝保护"
                : "待原限次和冷却规则允许后重试",
          })),
      ),
    );
  return {
    baseline: plan.baselineSignalDate,
    asOf,
    cohorts,
    weeks,
    totals: plan.frozenPlans.map((p) => group(all, p)),
    dailyIssues,
    limitations: reviewLimitations,
  };
}

const pct = (v) => (finite(v) ? `${v.toFixed(4)}%` : "—");
const escape = (s) =>
  String(s ?? "—")
    .replaceAll("|", "／")
    .replace(/[\r\n]/g, " ");
export function renderStageReport({
  day,
  dueDate,
  preparedAt,
  analysis,
  calendar,
}) {
  const out = [
    `# 第${day}个后续交易日复盘`,
    "",
    `应到节点：${dueDate}；实际准备：${preparedAt}；真实行情截至：${analysis.asOf}。`,
    `基准：${analysis.baseline}（第0天）。已核验${calendar.count}个后续交易日。${analysis.asOf > dueDate ? "本报告为恢复后补报，按实际截至日汇总，不冒充节点当时快照。" : ""}`,
    "",
    analysis.limitations,
    "",
    `漏跑：${calendar.missed.join("、") || "无"}；未完成日：${calendar.incomplete.join("、") || "无"}；日期待核验：${calendar.unverified.join("、") || "无"}。`,
    "",
  ];
  const groups = (title, list) => {
    out.push(
      `## ${title}`,
      "",
      "|策略|总数|完成|平均净收益|中位数|盈利比例|最差|最好|未成熟|缺数|延期|",
      "|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
    );
    for (const g of list)
      out.push(
        `|${escape(g.name)}|${g.total}|${g.completed}|${pct(g.average)}|${pct(g.median)}|${pct(g.winRate)}|${pct(g.worst)}|${pct(g.best)}|${g.unfinished}|${g.missing}|${g.delayed}|`,
      );
    out.push("");
  };
  for (const c of analysis.cohorts) {
    groups(`${c.label} ${c.date}`, c.groups);
    out.push(c.conclusion, "");
  }
  groups("累计已完成（含各批次，不代表独立样本）", analysis.totals);
  for (const w of analysis.weeks) groups(`${w.label} ${w.date}`, w.groups);
  out.push(
    "## 逐股依据",
    "",
    "|批次|策略|股票|状态|入场|退出|有效日线|净收益|数据截至|延期|问题|",
    "|---|---|---|---|---|---|---|---:|---|---|---|",
  );
  for (const c of analysis.cohorts)
    for (const g of c.groups)
      for (const t of g.rows)
        out.push(
          `|${c.date}|${escape(g.name)}|${escape(t.name)} ${escape(t.code)}|${t.state}|${t.entryDate || "—"}|${t.exitDate || "—"}|${t.holdBars ?? "—"}/${t.hold ?? g.hold}|${pct(t.net)}|${t.asOf || "—"}|${t.delayed ? "是" : "否"}|${escape(t.reason)}|`,
        );
  out.push("", "## 每日筛选失败／待处理（与模拟持仓失败分开）", "");
  for (const i of analysis.dailyIssues)
    out.push(
      `- ${i.date} ${i.planId} ${escape(i.name)} ${i.code}：${escape(i.reason)}；${i.retry}。`,
    );
  if (!analysis.dailyIssues.length) out.push("无。");
  out.push("", "## 交易日依据", "");
  for (const d of calendar.dates.filter((d) => d.market === "open"))
    out.push(
      `- ${d.date}：${d.review}；${d.evidence.map((e) => `${e.kind} ${escape(e.source)}（采集${e.fetchedAt}）`).join("；")}`,
    );
  if (day === 10)
    out.push(
      "",
      "本轮10日节点结束；不足以判定稳定盈利。保留原每日模拟和未成熟持仓，是否开启下一轮由用户决定，不自动延长周期或调参。",
    );
  return out.join("\n") + "\n";
}
