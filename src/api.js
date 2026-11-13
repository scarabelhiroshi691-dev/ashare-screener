export async function api(path, body, { timeout = 30000, signal } = {}) {
  const res = await fetch("/api/" + path, {
    ...(body === undefined
      ? {}
      : {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }),
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(timeout)])
      : AbortSignal.timeout(timeout),
  });
  const data = await res.json();
  if (!res.ok)
    throw Object.assign(Error(data.error || "请求失败"), {
      status: res.status,
    });
  return data;
}
export const fmt = (n, d = 2) => (Number.isFinite(n) ? n.toFixed(d) : "—");
export const pct = (n) =>
  Number.isFinite(n) ? `${n > 0 ? "+" : ""}${n.toFixed(2)}%` : "—";
export const time = (s) =>
  s
    ? new Date(s).toLocaleString("zh-CN", {
        timeZone: "Asia/Shanghai",
        hour12: false,
      })
    : "—";
export function csvText(rows) {
  const cell = (v) =>
    '"' +
    (typeof v === "number"
      ? String(v)
      : String(v ?? "").replace(/^[\s]*[=+@-]/, "'$&")
    ).replaceAll('"', '""') +
    '"';
  const data = [
    [
      "股票代码",
      "名称",
      "数据日期",
      "价格",
      "涨跌幅%",
      "成交额（元）",
      "入选依据",
    ],
    ...rows.map((s) => [
      `${s.code}.${s.symbol.slice(0, 2).toUpperCase()}`,
      s.name,
      s.quoteDate,
      s.price,
      s.changePct,
      s.amount,
      s.checks?.map((c) => c.label).join("；") || "未进行历史筛选",
    ]),
  ];
  return "\ufeff" + data.map((r) => r.map(cell).join(",")).join("\r\n");
}
export function download(rows) {
  const url = URL.createObjectURL(
    new Blob([csvText(rows)], {
      type: "text/csv;charset=utf-8",
    }),
  );
  const a = document.createElement("a");
  a.href = url;
  a.download = "选股名单.csv";
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
