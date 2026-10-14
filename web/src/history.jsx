import { useEffect, useId, useMemo, useRef, useState } from "react";
import {
  deviceDateKey,
  formatDeviceCalendarMonth,
  formatDeviceMonthRange,
  formatDeviceWeekday,
  formatDeviceTime,
} from "./device-time.js";

function Popover({ label, children, quiet = false }) {
  const [open, setOpen] = useState(false);
  const root = useRef(null);
  const trigger = useRef(null);
  const id = useId();
  useEffect(() => {
    if (!open) return;
    const dismiss = (event) => {
      if (!root.current?.contains(event.target)) setOpen(false);
    };
    const escape = (event) => {
      if (event.key === "Escape") {
        setOpen(false);
        trigger.current?.focus();
      }
    };
    document.addEventListener("pointerdown", dismiss);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", dismiss);
      document.removeEventListener("keydown", escape);
    };
  }, [open]);
  return (
    <div
      className={`history-popover${quiet ? " history-range" : ""}`}
      ref={root}
    >
      <button
        ref={trigger}
        type="button"
        aria-expanded={open}
        aria-controls={id}
        aria-haspopup="dialog"
        className="history-filter-trigger"
        onClick={() => setOpen((value) => !value)}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown") {
            event.preventDefault();
            setOpen(true);
            requestAnimationFrame(() =>
              root.current
                ?.querySelector(
                  ".history-filter-panel button, .history-filter-panel input",
                )
                ?.focus(),
            );
          }
        }}
      >
        {label}
        <img src="/assets/chevron-down.svg" alt="" />
      </button>
      <div
        id={id}
        className="history-filter-panel"
        data-open={open}
        role="dialog"
        aria-label={quiet ? "选择历史月份" : "筛选服务"}
        aria-hidden={!open}
        inert={!open}
      >
        {children(() => {
          setOpen(false);
          trigger.current?.focus();
        })}
      </div>
    </div>
  );
}

const phases = {
  investigating: "调查中",
  identified: "已定位",
  monitoring: "观察恢复",
  resolved: "已恢复",
  scheduled: "计划维护",
  in_progress: "维护中",
  completed: "维护完成",
  cancelled: "已取消",
};

export function History({ data, groups = [], navigate }) {
  const [selected, setSelected] = useState([]);
  const [monthKey, setMonthKey] = useState("");
  const toggle = (ids) =>
    setSelected((current) =>
      ids.every((id) => current.includes(id))
        ? current.filter((id) => !ids.includes(id))
        : [...new Set([...current, ...ids])],
    );
  const months = useMemo(
    () =>
      data.months
        .filter((month) => !monthKey || month.key === monthKey)
        .map((month) => {
          const days = new Map();
          const incidents = month.incidents
            .filter(
              (incident) =>
                !selected.length ||
                incident.componentIds.some((id) => selected.includes(id)),
            )
            .sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt));
          for (const incident of incidents) {
            const date = deviceDateKey(new Date(incident.startedAt));
            const rows = days.get(date) || [];
            rows.push(incident);
            days.set(date, rows);
          }
          return { ...month, days: [...days] };
        }),
    [data, monthKey, selected],
  );
  return (
    <main className="history-page">
      <nav className="breadcrumbs" aria-label="面包屑">
        <button onClick={() => navigate("/")} type="button">
          LaZy Campus
        </button>
        <span aria-hidden="true">/</span>
        <span aria-current="page">历史记录</span>
      </nav>
      <div className="history-heading">
        <h1>历史记录</h1>
        <Popover
          quiet
          label={
            monthKey
              ? formatDeviceCalendarMonth(monthKey)
              : formatDeviceMonthRange(data.range)
          }
        >
          {(close) => (
            <>
              <button
                type="button"
                onClick={() => {
                  setMonthKey("");
                  close();
                }}
              >
                最近 90 天
              </button>
              {data.months.map((month) => (
                <button
                  type="button"
                  key={month.key}
                  aria-pressed={monthKey === month.key}
                  onClick={() => {
                    setMonthKey(month.key);
                    close();
                  }}
                >
                  {formatDeviceCalendarMonth(month.key)}
                </button>
              ))}
            </>
          )}
        </Popover>
        <Popover
          label={selected.length ? `筛选服务 · ${selected.length}` : "筛选服务"}
        >
          {() => (
            <>
              <div className="history-filter-caption">
                <span>按服务查看</span>
                <button type="button" onClick={() => setSelected([])}>
                  清除筛选
                </button>
              </div>
              {groups.map((group) => (
                <fieldset key={group.id}>
                  <legend>{group.name}</legend>
                  <label className="history-filter-group">
                    <input
                      type="checkbox"
                      checked={group.components.every((c) =>
                        selected.includes(c.id),
                      )}
                      onChange={() => toggle(group.components.map((c) => c.id))}
                    />
                    全部服务
                  </label>
                  {group.components.map((component) => (
                    <label key={component.id}>
                      <input
                        type="checkbox"
                        checked={selected.includes(component.id)}
                        onChange={() => toggle([component.id])}
                      />
                      {component.name}
                    </label>
                  ))}
                </fieldset>
              ))}
              {!groups.length && <p>正在读取服务列表。</p>}
            </>
          )}
        </Popover>
      </div>
      <div className="month-list">
        {months.map((month) => (
          <section
            className="month-row"
            key={month.key}
            aria-label={formatDeviceCalendarMonth(month.key)}
          >
            <h2>{formatDeviceCalendarMonth(month.key)}</h2>
            {!month.days.length ? (
              <p className="no-incidents">
                {selected.length
                  ? "所选服务在此月没有事件记录"
                  : "没有故障或维护记录"}
              </p>
            ) : (
              month.days.map(([date, incidents]) => (
                <div className="history-day" key={date}>
                  <div className="history-day-label">
                    <time dateTime={date}>{date.slice(-2)}</time>
                    <span>{formatDeviceWeekday(date)}</span>
                  </div>
                  <div className="history-events">
                    {incidents.map((incident) => {
                      const update = [...(incident.updates || [])].sort(
                        (a, b) =>
                          Date.parse(b.createdAt) - Date.parse(a.createdAt),
                      )[0];
                      return (
                        <a
                          className={`history-event status-${incident.severity}`}
                          key={incident.id}
                          href={`/incidents/${encodeURIComponent(incident.id)}`}
                          onClick={(event) => {
                            if (
                              event.button ||
                              event.metaKey ||
                              event.ctrlKey ||
                              event.shiftKey ||
                              event.altKey
                            )
                              return;
                            event.preventDefault();
                            navigate(`/incidents/${incident.id}`);
                          }}
                        >
                          <div className="history-event-heading">
                            <h3>{incident.title}</h3>
                            <time dateTime={incident.startedAt}>
                              {formatDeviceTime(incident.startedAt)}
                            </time>
                          </div>
                          <p>{update?.message || incident.message}</p>
                          <span className="history-event-state">
                            {phases[incident.phase] || "状态更新"}
                          </span>
                        </a>
                      );
                    })}
                  </div>
                </div>
              ))
            )}
          </section>
        ))}
      </div>
      <p className="history-explanation">
        历史颜色表示事件发生时的影响；当前服务状态请查看首页。
      </p>
    </main>
  );
}
