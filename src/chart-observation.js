const PERIOD = 20;
const LOOKBACK = 5;

const positive = (value) => Number.isFinite(value) && value > 0;
const relative = (value, baseline) =>
  positive(value) && positive(baseline) ? (value / baseline - 1) * 100 : null;

export function bollingerBands(bars) {
  return bars.map((_, index) => {
    if (index < PERIOD - 1) return null;
    const closes = bars
      .slice(index + 1 - PERIOD, index + 1)
      .map((b) => b.close);
    if (!closes.every(positive)) return null;
    const middle = closes.reduce((sum, close) => sum + close, 0) / PERIOD;
    const variance =
      closes.reduce((sum, close) => sum + (close - middle) ** 2, 0) / PERIOD;
    const deviation = 2 * Math.sqrt(variance);
    return { upper: middle + deviation, middle, lower: middle - deviation };
  });
}

export function observeDailyChart(bars, asOf) {
  if (!asOf) return null;
  const completed = bars.filter((bar) => bar.date <= asOf);
  const last = completed.at(-1);
  if (last?.date !== asOf || !positive(last.ma20)) return null;

  const recent = completed.slice(-(LOOKBACK + 2));
  const prior = recent.slice(0, -1);
  const hasCrossHistory =
    prior.length === LOOKBACK + 1 &&
    prior.every((bar) => positive(bar.ma20) && positive(bar.close));
  const crossIndex = hasCrossHistory
    ? prior.findLastIndex(
        (bar, i) =>
          i > 0 &&
          prior[i - 1].close <= prior[i - 1].ma20 &&
          bar.close > bar.ma20,
      )
    : -1;
  const crossDate = crossIndex > 0 ? prior[crossIndex].date : null;
  const sinceCross = crossDate ? recent.slice(crossIndex + 1) : [];
  const held =
    crossDate &&
    sinceCross.every((bar) => positive(bar.low) && positive(bar.ma20))
      ? sinceCross.every((bar) => bar.low >= bar.ma20)
      : null;
  const priorVolumes = prior.slice(-LOOKBACK).map((bar) => bar.volume);
  const meanVolume =
    priorVolumes.length === LOOKBACK && priorVolumes.every(positive)
      ? priorVolumes.reduce((sum, volume) => sum + volume, 0) / LOOKBACK
      : null;
  const volumeRatio =
    positive(last.volume) && meanVolume ? last.volume / meanVolume : null;
  const lowDistance = relative(last.low, last.ma20);
  const ma20Change = relative(last.ma20, recent.at(-LOOKBACK - 1)?.ma20);
  const near =
    lowDistance !== null &&
    last.low >= last.ma20 &&
    last.low <= last.ma20 * 1.02;
  const retest =
    held === true &&
    near &&
    volumeRatio !== null &&
    volumeRatio < 1 &&
    ma20Change !== null &&
    ma20Change >= 0;
  return {
    date: last.date,
    closeDistance: relative(last.close, last.ma20),
    ma5Distance: relative(last.ma5, last.ma20),
    ma20Change,
    lowDistance,
    volumeRatio,
    crossDate,
    hasCrossHistory,
    held,
    retest,
  };
}
