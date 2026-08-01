/**
 * Indicator math. All functions return arrays aligned with the input array;
 * positions before the warmup window are null.
 *
 * EMA:  seeded with the SMA of the first `period` values, then
 *       ema[i] = ema[i-1] + k * (price[i] - ema[i-1]), k = 2 / (period + 1).
 * RSI:  Wilder smoothing (seed = simple average of first `period` gains/losses).
 * ATR:  Wilder smoothing over True Range (seed = SMA of first `period` TRs).
 */

export interface OhlcCandle {
  high: number;
  low: number;
  close: number;
}

export function ema(values: number[], period: number): (number | null)[] {
  const out: (number | null)[] = new Array(values.length).fill(null);
  if (values.length < period) return out;
  let sum = 0;
  for (let i = 0; i < period; i++) sum += values[i];
  let prev = sum / period;
  out[period - 1] = prev;
  const k = 2 / (period + 1);
  for (let i = period; i < values.length; i++) {
    prev = prev + k * (values[i] - prev);
    out[i] = prev;
  }
  return out;
}

export function rsi(closes: number[], period: number): (number | null)[] {
  const out: (number | null)[] = new Array(closes.length).fill(null);
  if (closes.length < period + 1) return out;

  let gainSum = 0;
  let lossSum = 0;
  for (let i = 1; i <= period; i++) {
    const change = closes[i] - closes[i - 1];
    if (change > 0) gainSum += change;
    else lossSum -= change;
  }
  let avgGain = gainSum / period;
  let avgLoss = lossSum / period;
  out[period] = rsiFromAverages(avgGain, avgLoss);

  for (let i = period + 1; i < closes.length; i++) {
    const change = closes[i] - closes[i - 1];
    const gain = change > 0 ? change : 0;
    const loss = change < 0 ? -change : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    out[i] = rsiFromAverages(avgGain, avgLoss);
  }
  return out;
}

function rsiFromAverages(avgGain: number, avgLoss: number): number {
  if (avgLoss === 0) return avgGain === 0 ? 50 : 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

export function trueRange(candle: OhlcCandle, prevClose: number | null): number {
  const hl = candle.high - candle.low;
  if (prevClose === null) return hl;
  return Math.max(hl, Math.abs(candle.high - prevClose), Math.abs(candle.low - prevClose));
}

export function atr(candles: OhlcCandle[], period: number): (number | null)[] {
  const out: (number | null)[] = new Array(candles.length).fill(null);
  if (candles.length < period) return out;

  const trs = candles.map((c, i) => trueRange(c, i > 0 ? candles[i - 1].close : null));

  let sum = 0;
  for (let i = 0; i < period; i++) sum += trs[i];
  let prev = sum / period;
  out[period - 1] = prev;

  for (let i = period; i < candles.length; i++) {
    prev = (prev * (period - 1) + trs[i]) / period;
    out[i] = prev;
  }
  return out;
}

/** Crossover EVENT: previous close at-or-below previous EMA, current close above current EMA. */
export function crossedAbove(
  prevValue: number,
  prevRef: number | null,
  value: number,
  ref: number | null
): boolean {
  if (prevRef === null || ref === null) return false;
  return prevValue <= prevRef && value > ref;
}

/** Crossunder EVENT: previous close at-or-above previous EMA, current close below current EMA. */
export function crossedBelow(
  prevValue: number,
  prevRef: number | null,
  value: number,
  ref: number | null
): boolean {
  if (prevRef === null || ref === null) return false;
  return prevValue >= prevRef && value < ref;
}
