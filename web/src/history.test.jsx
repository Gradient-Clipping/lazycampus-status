import React from "react";
import { afterEach, expect, test, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { History } from "./history.jsx";
afterEach(cleanup);
const groups = [
  {
    id: "campus",
    name: "Easy SWU",
    components: [
      { id: "teaching", name: "教务查询" },
      { id: "content", name: "校园资讯" },
    ],
  },
];
const event = (id, title, component, date) => ({
  id,
  title,
  componentIds: [component],
  startedAt: date,
  severity: "degraded_performance",
  phase: "resolved",
  message: "已恢复",
  updates: [],
});
const data = {
  range: { start: "2026-07-17", end: "2026-10-14" },
  months: [
    {
      key: "2026-10",
      incidents: [
        event("a", "教务请求恢复", "teaching", "2026-10-13T06:00:00Z"),
        event("b", "资讯请求恢复", "content", "2026-10-13T05:00:00Z"),
      ],
    },
    {
      key: "2026-09",
      incidents: [
        event("c", "九月服务恢复", "content", "2026-09-12T06:00:00Z"),
      ],
    },
  ],
};
test("history groups events by day, retains real links and filters by component", () => {
  const navigate = vi.fn();
  render(<History data={data} groups={groups} navigate={navigate} />);
  expect(document.querySelectorAll(".history-day-label")).toHaveLength(2);
  const link = screen.getByRole("link", { name: /教务请求恢复/ });
  expect(link.getAttribute("href")).toBe("/incidents/a");
  fireEvent.click(link);
  expect(navigate).toHaveBeenCalledWith("/incidents/a");
  fireEvent.click(screen.getByRole("button", { name: "筛选服务" }));
  fireEvent.click(
    screen.getByRole("checkbox", { name: "教务查询", exact: true }),
  );
  expect(screen.getByRole("link", { name: /教务请求恢复/ })).toBeTruthy();
  expect(screen.queryByRole("link", { name: /资讯请求恢复/ })).toBeNull();
  expect(screen.queryByRole("link", { name: /九月服务恢复/ })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "清除筛选" }));
  expect(screen.getAllByRole("link")).toHaveLength(3);
});
test("filter keeps a mounted panel for both animation directions and restores keyboard focus", () => {
  render(<History data={data} groups={groups} navigate={vi.fn()} />);
  const trigger = screen.getByRole("button", { name: "筛选服务" });
  const panel = document.getElementById(trigger.getAttribute("aria-controls"));
  expect(panel.getAttribute("aria-hidden")).toBe("true");
  fireEvent.click(trigger);
  expect(trigger.getAttribute("aria-expanded")).toBe("true");
  expect(panel.getAttribute("data-open")).toBe("true");
  fireEvent.keyDown(
    screen.getByRole("checkbox", { name: "教务查询", exact: true }),
    { key: "Escape" },
  );
  expect(panel.isConnected).toBe(true);
  expect(panel.getAttribute("data-open")).toBe("false");
  expect(panel.hasAttribute("inert")).toBe(true);
  expect(document.activeElement).toBe(trigger);
  fireEvent.click(trigger);
  fireEvent.pointerDown(document.body);
  expect(trigger.getAttribute("aria-expanded")).toBe("false");
});
test("month selection narrows the history and can return to the full observed range", () => {
  render(<History data={data} groups={groups} navigate={vi.fn()} />);
  const trigger = document.querySelector(".history-range button");
  fireEvent.click(trigger);
  fireEvent.click(
    within(screen.getByRole("dialog", { name: "选择历史月份" })).getByRole(
      "button",
      { name: "2026年9月" },
    ),
  );
  expect(screen.getAllByRole("link")).toHaveLength(1);
  expect(screen.getByRole("link", { name: /九月服务恢复/ })).toBeTruthy();
  fireEvent.click(trigger);
  fireEvent.click(screen.getByRole("button", { name: "最近 90 天" }));
  expect(screen.getAllByRole("link")).toHaveLength(3);
});
