const chinaFormat = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Shanghai",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
  weekday: "short",
});

export function chinaClock(value = new Date()) {
  const parts = Object.fromEntries(
    chinaFormat.formatToParts(new Date(value)).map((p) => [p.type, p.value]),
  );
  const date = `${parts.year}-${parts.month}-${parts.day}`;
  const minutes = Number(parts.hour) * 60 + Number(parts.minute);
  const weekday = !["Sat", "Sun"].includes(parts.weekday);
  return {
    date,
    time: `${parts.hour}:${parts.minute}:${parts.second}`,
    minutes,
    weekday,
    tradingWindow:
      weekday &&
      ((minutes >= 570 && minutes < 690) || (minutes >= 780 && minutes < 900)),
  };
}

export function isCompletedDate(date, now = new Date()) {
  const clock = chinaClock(now);
  return Boolean(
    (date && date < clock.date) ||
    (date === clock.date && clock.minutes >= 910),
  );
}

export function quoteTimestamp(raw) {
  if (!/^\d{14}$/.test(raw || "")) return null;
  const iso = `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}T${raw.slice(8, 10)}:${raw.slice(10, 12)}:${raw.slice(12, 14)}+08:00`;
  return Number.isFinite(Date.parse(iso)) ? iso : null;
}

export function isFreshQuote(quote, now = new Date()) {
  if (!quote?.quoteAt || !chinaClock(now).tradingWindow) return false;
  const age = new Date(now).getTime() - Date.parse(quote.quoteAt);
  return (
    age >= -15000 &&
    age <= 150000 &&
    chinaClock(quote.quoteAt).date === chinaClock(now).date
  );
}

export function alertMatches(quote, threshold, now = new Date()) {
  const value = threshold === '' ? NaN : Number(threshold);
  return Number.isFinite(value) && value >= -30 && value <= 30 &&
    Number.isFinite(quote.changePct) && isFreshQuote(quote, now) && quote.changePct >= value;
}
