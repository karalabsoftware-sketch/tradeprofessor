/**
 * Date formatting for the dashboard.
 *
 * Everything is STORED and reasoned about in UTC (candle boundaries, cron
 * slots, Binance timestamps) and only DISPLAYED in the configured zone. The
 * zone is passed explicitly to Intl, never taken from the runtime's local
 * time, so the server render and the client render always agree — no
 * hydration mismatch, and the page reads identically wherever it is opened.
 */

import { CONFIG } from "@/config/strategy";

const TZ = CONFIG.display.timeZone;

const dateTimeFmt = new Intl.DateTimeFormat("en-CA", {
  timeZone: TZ,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

const dateFmt = new Intl.DateTimeFormat("en-CA", {
  timeZone: TZ,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

const offsetFmt = new Intl.DateTimeFormat("en-US", {
  timeZone: TZ,
  timeZoneName: "shortOffset",
});

/** "2026-08-02 09:23" in the display zone. */
export function fmtDateTime(input: Date | number): string {
  return dateTimeFmt.format(toDate(input)).replace(", ", " ");
}

/** "2026-08-02" in the display zone. */
export function fmtDate(input: Date | number): string {
  return dateFmt.format(toDate(input));
}

/**
 * Current offset label for the display zone, e.g. "UTC+3".
 * Derived from Intl rather than hardcoded so it stays correct if the zone
 * ever observes DST again.
 */
export function tzLabel(at: Date | number = Date.now()): string {
  const part = offsetFmt
    .formatToParts(toDate(at))
    .find((p) => p.type === "timeZoneName");
  // Intl yields "GMT+3" / "GMT+03:30" / "GMT" for UTC.
  const raw = part?.value ?? "GMT";
  return raw === "GMT" ? "UTC" : raw.replace("GMT", "UTC");
}

/** "2026-08-02 09:23 UTC+3" — timestamp with its zone spelled out. */
export function fmtDateTimeTz(input: Date | number): string {
  return `${fmtDateTime(input)} ${tzLabel(input)}`;
}

function toDate(input: Date | number): Date {
  return input instanceof Date ? input : new Date(input);
}
