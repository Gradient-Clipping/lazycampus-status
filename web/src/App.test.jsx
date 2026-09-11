import React from "react";
import { afterEach, expect, test, vi } from "vitest";
import {
  cleanup,
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { App } from "./App.jsx";
import { getDeviceTimeZone } from "./device-time.js";
import { readPublicCache, writePublicCache } from "./public-cache.js";
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  localStorage.clear();
  window.history.replaceState({}, "", "/");
});

test("returning visitors see cached services immediately and refresh without collapsing their selection", async () => {
  const timeZone = getDeviceTimeZone();
  const cached = { ...snapshot, updatedAt: new Date().toISOString() };
  writePublicCache("status", timeZone, cached);
  let finishStatus;
  vi.stubGlobal(
    "fetch",
    vi.fn((url) =>
      String(url).includes("/history")
        ? Promise.reject(new Error("History is temporarily unavailable"))
        : new Promise((resolve) => {
            finishStatus = resolve;
          }),
    ),
  );
  render(<App />);
  expect(screen.getByText("Smart Shop")).toBeTruthy();
  expect(screen.queryByText("正在读取服务状态")).toBeNull();
  const project = screen.getByRole("button", { name: /Smart Shop/ });
  for (let count = 0; count < 5; count++) fireEvent.click(project);
  expect(project.getAttribute("aria-expanded")).toBe("true");
  const current = {
    ...cached,
    headline: "部分服务性能下降",
    overallStatus: "degraded_performance",
  };
  await act(async () => finishStatus({ ok: true, json: async () => current }));
  expect(await screen.findByText("部分服务性能下降")).toBeTruthy();
  expect(project.getAttribute("aria-expanded")).toBe("true");
  expect(screen.queryByText("暂时无法更新状态")).toBeNull();
  expect(readPublicCache("status", timeZone).headline).toBe(current.headline);
});

test("failed refresh retains the last service details and identifies the old observation", async () => {
  const cached = {
    ...snapshot,
    updatedAt: new Date(Date.now() - 120000).toISOString(),
  };
  writePublicCache("status", getDeviceTimeZone(), cached);
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok: false })),
  );
  render(<App />);
  expect(screen.getByText("Smart Shop")).toBeTruthy();
  expect(screen.getByText("正在确认最新状态")).toBeTruthy();
  expect(await screen.findByText("暂时无法更新状态")).toBeTruthy();
  expect(screen.getByText(/上次更新：/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: /Smart Shop/ }));
  fireEvent.click(screen.getByRole("button", { name: /业务 API/ }));
  expect(screen.getByText("124 ms")).toBeTruthy();
  expect(readPublicCache("status", getDeviceTimeZone()).headline).toBe(
    cached.headline,
  );
});
const history = [
  { date: "2026-09-11", status: "operational", coveragePercentage: 12 },
];
const snapshot = {
  title: "LaZy Campus",
  overallStatus: "operational",
  headline: "所有服务正常运行",
  message: "所有服务运行正常。",
  range: { start: "2026-06-14", end: "2026-09-11" },
  updatedAt: "2026-09-11T08:00:00Z",
  subscriptionsEnabled: false,
  activeIncidents: [],
  groups: [
    {
      id: "shop",
      name: "Smart Shop",
      status: "operational",
      uptimePercentage: "100.000",
      history,
      components: [
        {
          id: "shop-api",
          name: "业务 API",
          status: "operational",
          checkedAt: "2026-09-11T08:00:00Z",
          latencyMs: 124,
          uptimePercentage: "100.000",
          history,
          description: "商品与订单服务",
        },
      ],
    },
  ],
};
function mock() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url) => ({
      ok: true,
      json: async () =>
        String(url).includes("/history")
          ? {
              range: snapshot.range,
              months: [{ key: "2026-09", incidents: [] }],
            }
          : snapshot,
    })),
  );
  vi.spyOn(window, "scrollTo").mockImplementation(() => {});
}
test("idle services show no calls without inventing success rates or historical availability", async () => {
  const current = structuredClone(snapshot);
  current.updatedAt = new Date().toISOString();
  const component = current.groups[0].components[0];
  component.uptimePercentage = null;
  component.evidence = {
    requests: 0,
    errors: 0,
    limited: 2,
    windowSeconds: 300,
  };
  component.history = [{ date: "2026-09-11", status: "no_data" }];
  writePublicCache("status", getDeviceTimeZone(), current);
  vi.stubGlobal(
    "fetch",
    vi.fn(() => new Promise(() => {})),
  );
  render(<App />);
  fireEvent.click(screen.getByRole("button", { name: /Smart Shop/ }));
  fireEvent.click(screen.getByRole("button", { name: /业务 API/ }));
  const details = document.querySelector(".component-detail");
  expect(within(details).getAllByText("暂无调用").length).toBe(2);
  expect(within(details).queryByText("100.00%")).toBeNull();
  expect(within(details).getByText("正常运行")).toBeTruthy();
  expect(within(details).getByText("暂无记录")).toBeTruthy();
  expect(screen.getByRole("button", { name: /2026.*暂无记录/ })).toBeTruthy();
});
test("projects and service details expand independently and preserve the original status anatomy", async () => {
  mock();
  render(<App />);
  await screen.findByText("所有服务正常运行");
  const project = screen.getByRole("button", { name: /Smart Shop/ });
  expect(project.getAttribute("aria-expanded")).toBe("false");
  fireEvent.click(project);
  expect(project.getAttribute("aria-expanded")).toBe("true");
  const component = screen.getByRole("button", { name: /业务 API/ });
  expect(component.getAttribute("aria-expanded")).toBe("false");
  fireEvent.click(component);
  expect(screen.getByText("124 ms")).toBeTruthy();
  expect(screen.getByText("商品与订单服务")).toBeTruthy();
  expect(document.querySelector(".brand-button img").getAttribute("src")).toBe(
    "/logo.webp",
  );
  expect(document.querySelectorAll(".system-group").length).toBe(1);
  fireEvent.click(screen.getByRole("button", { name: "查看历史" }));
  expect(await screen.findByRole("heading", { name: "历史记录" })).toBeTruthy();
});
test("history chart is keyboard navigable without adding 90 tab stops", async () => {
  mock();
  render(<App />);
  await screen.findByText("Smart Shop");
  const chart = document.querySelector(".desktop-uptime .uptime-chart");
  expect(
    within(chart)
      .getAllByRole("button")
      .filter((b) => b.tabIndex === 0).length,
  ).toBe(1);
  fireEvent.focus(within(chart).getAllByRole("button")[0]);
  expect(await screen.findByRole("tooltip")).toBeTruthy();
});
test("RSS subscription works without requiring email or login", async () => {
  mock();
  HTMLDialogElement.prototype.showModal = vi.fn(function () {
    this.setAttribute("open", "");
  });
  HTMLDialogElement.prototype.close = vi.fn(function () {
    this.removeAttribute("open");
  });
  render(<App />);
  await screen.findByText("Smart Shop");
  fireEvent.click(screen.getByRole("button", { name: "订阅更新" }));
  await waitFor(() => expect(screen.getByRole("dialog")).toBeTruthy());
  expect(screen.getByRole("textbox", { name: "RSS 订阅地址" }).value).toMatch(
    /\/feed\.rss$/,
  );
  expect(screen.getByRole("button", { name: "邮件" }).disabled).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "关闭" }));
  expect(screen.queryByRole("dialog")).toBeNull();
});
