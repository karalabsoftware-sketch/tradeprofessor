import { describe, expect, it } from "vitest";
import { fmtDate, fmtDateTime, fmtDateTimeTz, tzLabel } from "../src/lib/format";

/**
 * Istanbul is UTC+3 year-round (no DST since 2016), so these expectations are
 * stable. The point of the tests is that formatting depends on the CONFIGURED
 * zone rather than the machine's local zone — otherwise CI, the dev machine
 * and Vercel would each render different times.
 */

describe("fmtDateTime", () => {
  it("shifts UTC input into Istanbul time", () => {
    expect(fmtDateTime(new Date("2026-08-02T00:00:00Z"))).toBe("2026-08-02 03:00");
    expect(fmtDateTime(new Date("2026-08-02T06:23:00Z"))).toBe("2026-08-02 09:23");
  });

  it("rolls the date over when the offset crosses midnight", () => {
    expect(fmtDateTime(new Date("2026-08-01T21:30:00Z"))).toBe("2026-08-02 00:30");
    expect(fmtDateTime(new Date("2026-08-01T22:15:00Z"))).toBe("2026-08-02 01:15");
  });

  it("uses a 24-hour clock, not AM/PM", () => {
    const s = fmtDateTime(new Date("2026-08-02T18:00:00Z")); // 21:00 Istanbul
    expect(s).toBe("2026-08-02 21:00");
    expect(s).not.toMatch(/[ap]m/i);
  });

  it("accepts epoch milliseconds as well as Date", () => {
    const ms = Date.UTC(2026, 7, 2, 0, 0, 0);
    expect(fmtDateTime(ms)).toBe(fmtDateTime(new Date(ms)));
  });

  it("does not depend on the machine's local timezone", () => {
    // Same instant, two equivalent inputs constructed differently.
    const a = new Date("2026-01-15T12:00:00Z");
    const b = new Date(Date.UTC(2026, 0, 15, 12, 0, 0));
    expect(fmtDateTime(a)).toBe(fmtDateTime(b));
    expect(fmtDateTime(a)).toBe("2026-01-15 15:00"); // winter: still UTC+3
  });
});

describe("fmtDate", () => {
  it("returns the Istanbul calendar date", () => {
    expect(fmtDate(new Date("2026-08-01T21:30:00Z"))).toBe("2026-08-02");
    expect(fmtDate(new Date("2026-08-02T20:59:00Z"))).toBe("2026-08-02");
  });
});

describe("tzLabel", () => {
  it("reports the offset for the configured zone", () => {
    expect(tzLabel(new Date("2026-08-02T00:00:00Z"))).toBe("UTC+3");
    // Same in January — Turkey does not observe DST.
    expect(tzLabel(new Date("2026-01-02T00:00:00Z"))).toBe("UTC+3");
  });
});

describe("fmtDateTimeTz", () => {
  it("appends the zone to the timestamp", () => {
    expect(fmtDateTimeTz(new Date("2026-08-02T06:23:00Z"))).toBe("2026-08-02 09:23 UTC+3");
  });
});
