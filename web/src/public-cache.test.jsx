import { afterEach, expect, test, vi } from "vitest";
import { readPublicCache, writePublicCache } from "./public-cache.js";

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});
const zone = "Asia/Singapore";
function data() {
  return {
    updatedAt: new Date().toISOString(),
    range: { start: "2026-06-14", end: "2026-09-11" },
    groups: [],
    activeIncidents: [],
    headline: "所有服务正常运行",
  };
}
test("public cache rejects expired, wrong-zone and corrupt records", () => {
  const snapshot = data();
  writePublicCache("status", zone, snapshot);
  expect(readPublicCache("status", zone)).toEqual(snapshot);
  expect(readPublicCache("status", "America/New_York")).toBeNull();
  expect(readPublicCache("status", zone, Date.now() + 86400001)).toBeNull();
  localStorage.setItem("lazycampus-status:public:v1:status", "broken JSON");
  expect(readPublicCache("status", zone)).toBeNull();
});
test("unavailable storage and unsuccessful snapshots never replace a valid cached observation", () => {
  const snapshot = data();
  writePublicCache("status", zone, snapshot);
  writePublicCache("status", zone, { ...snapshot, stale: true });
  expect(readPublicCache("status", zone)).toEqual(snapshot);
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new Error("Storage disabled");
  });
  expect(() => writePublicCache("status", zone, snapshot)).not.toThrow();
  vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
    throw new Error("Storage disabled");
  });
  expect(readPublicCache("status", zone)).toBeNull();
});
