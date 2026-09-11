const DATE_KEY = /^(\d{4})-(\d{2})-(\d{2})$/;
const MONTH_KEY = /^(\d{4})-(\d{2})$/;

const formatters = new Map();
function dateFormatter(locale, options) {
  const key = locale + JSON.stringify(options);
  if (!formatters.has(key)) {
    if (formatters.size >= 32) formatters.clear();
    formatters.set(key, new Intl.DateTimeFormat(locale, options));
  }
  return formatters.get(key);
}

function pad(value) {
  return String(value).padStart(2, "0");
}

function partsRecord(formatter, value) {
  return Object.fromEntries(
    formatter
      .formatToParts(value)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  );
}

function parseDateKey(value) {
  const match = DATE_KEY.exec(value || "");
  if (!match) {
    throw new Error(`无效的日历日期：${value}`);
  }
  return {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
  };
}

export function getDeviceTimeZone() {
  const timeZone = new Intl.DateTimeFormat().resolvedOptions().timeZone;
  if (!timeZone) {
    throw new Error("无法读取用户设备时区");
  }
  return timeZone;
}

export function deviceDateKey(value = Date.now()) {
  const timeZone = getDeviceTimeZone();
  const parts = partsRecord(
    dateFormatter("en-CA-u-ca-iso8601", {
      day: "2-digit",
      month: "2-digit",
      timeZone,
      year: "numeric",
    }),
    value,
  );
  return `${parts.year}-${parts.month}-${parts.day}`;
}

export function offsetCalendarDateKey(value, days) {
  const { year, month, day } = parseDateKey(value);
  const calendar = new Date(Date.UTC(year, month - 1, day));
  calendar.setUTCDate(calendar.getUTCDate() + days);
  return `${calendar.getUTCFullYear()}-${pad(calendar.getUTCMonth() + 1)}-${pad(
    calendar.getUTCDate(),
  )}`;
}

export function previousMonthStartDateKey(value) {
  const { year, month } = parseDateKey(value);
  return month === 1 ? `${year - 1}-12-01` : `${year}-${pad(month - 1)}-01`;
}

function offsetAt(instant, timeZone) {
  const parts = partsRecord(
    dateFormatter("en-US-u-ca-iso8601", {
      day: "2-digit",
      hour: "2-digit",
      hourCycle: "h23",
      minute: "2-digit",
      month: "2-digit",
      second: "2-digit",
      timeZone,
      year: "numeric",
    }),
    instant,
  );
  const representedAsUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second),
  );
  return representedAsUtc - instant.getTime();
}

function deviceCalendarDateInstant(value, timeZone) {
  const { year, month, day } = parseDateKey(value);
  const deviceNoonAsUtc = Date.UTC(year, month - 1, day, 12);
  let instant = new Date(
    deviceNoonAsUtc - offsetAt(new Date(deviceNoonAsUtc), timeZone),
  );
  const correctedOffset = offsetAt(instant, timeZone);
  instant = new Date(deviceNoonAsUtc - correctedOffset);
  return instant;
}

export function formatDeviceCalendarDate(
  value,
  timeZone = getDeviceTimeZone(),
) {
  return dateFormatter("zh-CN", {
    day: "numeric",
    month: "long",
    timeZone,
    year: "numeric",
  }).format(deviceCalendarDateInstant(value, timeZone));
}

export function formatDeviceCalendarMonth(value) {
  const dateKey = DATE_KEY.test(value) ? value : `${value}-01`;
  const timeZone = getDeviceTimeZone();
  return dateFormatter("zh-CN", {
    month: "long",
    timeZone,
    year: "numeric",
  }).format(deviceCalendarDateInstant(dateKey, timeZone));
}

export function formatDeviceMonthName(value) {
  if (!MONTH_KEY.test(value)) {
    throw new Error(`无效的日历月份：${value}`);
  }
  const timeZone = getDeviceTimeZone();
  return dateFormatter("zh-CN", {
    month: "long",
    timeZone,
  }).format(deviceCalendarDateInstant(`${value}-01`, timeZone));
}

export function formatDeviceMonthRange(range) {
  return `${formatDeviceCalendarMonth(range.start)} – ${formatDeviceCalendarMonth(
    range.end,
  )}`;
}

export function formatInstant(value) {
  if (!value) return "暂无记录";
  return dateFormatter("zh-CN", {
    timeZone: getDeviceTimeZone(),
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).format(new Date(value));
}
export function inputToInstant(value) {
  return new Date(value).toISOString();
}
