import { chinaClock } from "../shared/time.js";
import { summarizeTrades } from "./backtest.js";

export const openStates = ["pending", "holding", "exit-wait"];
const tradable = (b) =>
  b && b.volume > 0 && b.high > b.low && b.open > 0 && b.close > 0;
export function registerSignal(
  tickets,
  plan,
  stock,
  date,
  registeredAt,
  checks,
  source,
) {
  const clock = chinaClock(registeredAt);
  if (clock.date !== date || !clock.weekday || clock.minutes < 910)
    throw Error("只能登记当天已观察到的信号");
  const id = `${plan.id}:${stock.symbol}:${date}`;
  if (
    tickets.some(
      (t) =>
        t.id === id ||
        (t.planId === plan.id &&
          t.symbol === stock.symbol &&
          openStates.includes(t.state)),
    )
  )
    return null;
  return {
    id,
    planId: plan.id,
    symbol: stock.symbol,
    code: stock.code,
    name: stock.name,
    signalDate: date,
    registeredAt,
    state: "pending",
    signalSource: source,
    checks,
    ruleHash: plan.ruleHash,
    hold: plan.hold,
    costBps: plan.costBps,
    slippageBps: plan.slippageBps,
  };
}
export function advanceTicket(ticket, history, asOf) {
  if (!openStates.includes(ticket.state)) return ticket;
  const bars = history.bars.filter((b) => b.date <= asOf);
  if (bars.at(-1)?.date !== asOf) throw Error("缺少模拟跟踪截止日线");
  if (ticket.source && history.source !== ticket.source)
    throw Error(
      "本次日线来源改变，保留原持仓并等待原来源恢复，避免混用复权基准",
    );
  if (!bars.some((b) => b.date === ticket.signalDate))
    throw Error("历史已不含信号日，不能重建模拟入场");
  const entry = bars.findIndex((b) => b.date > ticket.signalDate);
  if (entry < 0) return { ...ticket, asOf, error: null };
  if (bars[entry].date <= chinaClock(ticket.registeredAt).date)
    throw Error("入场早于信号实际登记，拒绝事后补买");
  if (!tradable(bars[entry]))
    return {
      ...ticket,
      state: "skipped",
      entryDate: bars[entry].date,
      asOf,
      reason: "次有效日线为一字或无有效成交，跳过入场",
      error: null,
    };
  const slip = ticket.slippageBps / 10000,
    cost = ticket.costBps / 10000;
  const entryPrice = bars[entry].open * (1 + slip);
  const planned = entry + ticket.hold - 1;
  let exit = planned;
  while (exit < bars.length && !tradable(bars[exit])) exit++;
  const complete = exit < bars.length;
  const mark = complete ? bars[exit] : bars.at(-1);
  const exitPrice = mark.close * (1 - slip);
  const net = (((exitPrice / entryPrice) * (1 - cost)) / (1 + cost) - 1) * 100;
  return {
    ...ticket,
    state: complete
      ? "closed"
      : planned < bars.length
        ? "exit-wait"
        : "holding",
    source: history.source,
    asOf,
    entryDate: bars[entry].date,
    entryPrice,
    holdBars: (complete ? exit : bars.length - 1) - entry + 1,
    plannedExitDate: bars[planned]?.date || null,
    exitDate: complete ? mark.date : null,
    exitPrice: complete ? exitPrice : null,
    net: complete ? net : null,
    gross: complete ? (mark.close / bars[entry].open - 1) * 100 : null,
    markNet: complete ? null : net,
    markDate: mark.date,
    delayed: complete ? exit - planned : null,
    error: null,
  };
}
export function paperStats(tickets, plans) {
  return plans.map((p) => {
    const list = tickets.filter((t) => t.planId === p.id),
      closed = list.filter((t) => t.state === "closed");
    const summary = summarizeTrades(closed);
    const uniqueStocks = new Set(closed.map((t) => t.symbol)).size;
    return {
      planId: p.id,
      ...summary,
      uniqueStocks,
      pending: list.filter((t) => t.state === "pending").length,
      holding: list.filter((t) => ["holding", "exit-wait"].includes(t.state))
        .length,
      skipped: list.filter((t) => t.state === "skipped").length,
      errors: list.filter((t) => t.error).length,
      assessment: !closed.length
        ? "等待前瞻交易完成，暂无收益结论"
        : closed.length < 30 || uniqueStocks < 20 || summary.months.length < 3
          ? "前瞻样本仍少，继续观察；不判定稳定"
          : summary.median > 0 && summary.months.every((m) => m.average > 0)
            ? "当前已完成样本各月为正，仍需跨市场阶段验证"
            : "已完成样本存在负中位数或负月份，尚未表现出持续一致性",
    };
  });
}
