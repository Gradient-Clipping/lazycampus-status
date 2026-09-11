import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import {
  deviceDateKey,
  formatDeviceCalendarDate,
  formatDeviceMonthRange,
  getDeviceTimeZone,
  offsetCalendarDateKey,
  previousMonthStartDateKey,
} from "../web/src/device-time.js";

const originalTimeZone = process.env.TZ;

afterEach(() => {
  if (originalTimeZone === undefined) {
    delete process.env.TZ;
  } else {
    process.env.TZ = originalTimeZone;
  }
});

test("uses the device zone when an instant crosses a local date boundary", () => {
  const instant = Date.parse("2026-01-01T01:00:00Z");

  process.env.TZ = "America/New_York";
  assert.equal(getDeviceTimeZone(), "America/New_York");
  assert.equal(deviceDateKey(instant), "2025-12-31");

  process.env.TZ = "Asia/Tokyo";
  assert.equal(getDeviceTimeZone(), "Asia/Tokyo");
  assert.equal(deviceDateKey(instant), "2026-01-01");
});

test("keeps calendar labels stable while formatting in the device zone", () => {
  for (const timeZone of ["Pacific/Kiritimati", "Etc/GMT+12"]) {
    process.env.TZ = timeZone;
    assert.match(formatDeviceCalendarDate("2026-01-01"), /2026年1月1日/);
    assert.match(
      formatDeviceMonthRange({ start: "2025-12-01", end: "2026-01-31" }),
      /2025年12月.*2026年1月/,
    );
  }
});

test("performs date-key arithmetic without the host default calendar", () => {
  assert.equal(offsetCalendarDateKey("2026-03-01", -1), "2026-02-28");
  assert.equal(previousMonthStartDateKey("2026-01-15"), "2025-12-01");
});
