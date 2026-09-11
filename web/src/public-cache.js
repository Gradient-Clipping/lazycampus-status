const prefix = "lazycampus-status:public:v1:";
const maxAge = 24 * 60 * 60 * 1000;
export const staleAfter = 100000;

export function validPublicData(kind, data) {
  return Boolean(
    data &&
      data.range?.start &&
      data.range?.end &&
      (kind === "status"
        ? Array.isArray(data.groups) &&
          Array.isArray(data.activeIncidents) &&
          data.groups.every((group) => Array.isArray(group.components)) &&
          typeof data.headline === "string"
        : Array.isArray(data.months) &&
          data.months.every((month) => Array.isArray(month.incidents))),
  );
}

export function readPublicCache(kind, timeZone, now = Date.now()) {
  try {
    const entry = JSON.parse(localStorage.getItem(prefix + kind));
    const age = now - Date.parse(entry?.data?.updatedAt);
    return entry?.timeZone === timeZone &&
      Number.isFinite(age) &&
      age >= -60000 &&
      age <= maxAge &&
      !entry.data.stale &&
      validPublicData(kind, entry.data)
      ? entry.data
      : null;
  } catch {
    return null;
  }
}

export function writePublicCache(kind, timeZone, data) {
  if (
    data.stale ||
    !Number.isFinite(Date.parse(data.updatedAt)) ||
    !validPublicData(kind, data)
  )
    return;
  try {
    localStorage.setItem(prefix + kind, JSON.stringify({ timeZone, data }));
  } catch {
    // Storage may be disabled or full; live updates must remain usable.
  }
}
