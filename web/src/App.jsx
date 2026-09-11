import { memo, useCallback, useEffect, useId, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { Admin } from "./admin.jsx";
import { Subscribe, Unsubscribe } from "./subscribe.jsx";
import { APIDocs } from "./api-docs.jsx";
import {
  readPublicCache,
  writePublicCache,
  validPublicData,
  staleAfter,
} from "./public-cache.js";
const statusPageLogoUrl = "/logo.webp";
import {
  deviceDateKey,
  formatDeviceCalendarDate,
  formatDeviceMonthName,
  formatDeviceMonthRange,
  offsetCalendarDateKey,
  previousMonthStartDateKey,
  getDeviceTimeZone,
  formatInstant,
} from "./device-time.js";

const ASSET = "/assets";
const STATUS_META = {
  operational: { label: "正常运行", color: "#24c19a" },
  degraded_performance: { label: "性能下降", color: "#fbbf24" },
  partial_outage: { label: "部分异常", color: "#f5785c" },
  full_outage: { label: "服务中断", color: "#f87171" },
  maintenance: { label: "维护中", color: "#818cf8" },
  no_data: { label: "暂无数据", color: "#e4e4e7" },
};

function fallbackHistory() {
  const end = deviceDateKey();
  return Array.from({ length: 90 }, (_, index) => {
    return {
      date: offsetCalendarDateKey(end, -(89 - index)),
      status: "no_data",
    };
  });
}

const fallbackSnapshot = (() => {
  const history = fallbackHistory();
  return {
    title: "LaZy Campus",
    overallStatus: "no_data",
    headline: "正在读取服务状态",
    message: "请稍候。",
    range: { start: history[0].date, end: history.at(-1).date },
    groups: [],
    activeIncidents: [],
  };
})();

function fallbackHistoryPage() {
  const current = deviceDateKey();
  const previous = previousMonthStartDateKey(current);
  return {
    title: "LaZy Campus",
    range: { start: previous, end: current },
    months: [
      { key: current.slice(0, 7), incidents: [] },
      { key: previous.slice(0, 7), incidents: [] },
    ],
  };
}

function staleSnapshot(previous, headline) {
  return {
    ...previous,
    stale: true,
    overallStatus: "no_data",
    headline,
    message: previous.updatedAt
      ? `上次更新：${formatInstant(previous.updatedAt)}。正在重新连接。`
      : "正在重新连接，请稍后再试。",
  };
}

function statusClass(status) {
  return `status-${status || "no_data"}`;
}

function uptime(value) {
  return value === null || value === undefined
    ? "暂无数据"
    : `${value}% 可用率`;
}

export function IncidentCard({ incident, navigate }) {
  return (
    <article className="incident-card">
      <button
        className="text-button"
        onClick={() => navigate("/incidents/" + incident.id)}
      >
        <strong>{incident.title}</strong>
      </button>
      <p>{incident.message}</p>
      <time>{formatInstant(incident.updatedAt)}</time>
      {incident.scheduledStart ? (
        <p>
          {formatInstant(incident.scheduledStart)} —{" "}
          {formatInstant(incident.scheduledEnd)}
        </p>
      ) : null}
    </article>
  );
}

const ComponentItem = memo(function ComponentItem({
  component,
  index,
  incidents,
  navigate,
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="component-status">
      <button
        className="component-row component-row-button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <span className="component-row__name">
          <ComponentStatusIcon index={index} status={component.status} />
          <span>{component.name}</span>
          <img
            className={open ? "detail-chevron chevron--open" : "detail-chevron"}
            src={`${ASSET}/chevron-down.svg`}
            alt=""
          />
        </span>
        <span>{uptime(component.uptimePercentage)}</span>
      </button>
      <div className="component-uptime">
        <UptimeChart history={component.history} label={component.name} />
      </div>
      {open ? (
        <div className="component-detail">
          <dl>
            <div>
              <dt>当前状态</dt>
              <dd>{STATUS_META[component.status]?.label}</dd>
            </div>
            <div>
              <dt>最近检查</dt>
              <dd>{formatInstant(component.checkedAt)}</dd>
            </div>
            <div>
              <dt>响应时间</dt>
              <dd>
                {component.latencyMs === null
                  ? "暂无数据"
                  : `${component.latencyMs} ms`}
              </dd>
            </div>
          </dl>
          {component.description ? <p>{component.description}</p> : null}
          {component.url ? (
            <a href={component.url} target="_blank" rel="noreferrer">
              访问服务 ↗
            </a>
          ) : null}
          {incidents
            .filter((i) => i.componentIds.includes(component.id))
            .map((i) => (
              <IncidentCard key={i.id} incident={i} navigate={navigate} />
            ))}
        </div>
      ) : null}
    </div>
  );
});

function StatusIcon({ status = "operational" }) {
  return (
    <span
      role="img"
      aria-label={STATUS_META[status]?.label || "暂无数据"}
      className={`status-icon ${statusClass(status)}`}
    />
  );
}

function formatRange(range) {
  return formatDeviceMonthRange(range);
}

const UptimeChart = memo(function UptimeChart({ history, label }) {
  const timeZone = getDeviceTimeZone();
  const values = useMemo(
    () =>
      (history?.length ? history : fallbackHistory()).map((item) => ({
        ...item,
        label: formatDeviceCalendarDate(item.date, timeZone),
      })),
    [history, timeZone],
  );
  const tooltipId = useId();
  const [tooltip, setTooltip] = useState(null);

  function showTooltip(event, item) {
    const bounds = event.currentTarget.getBoundingClientRect();
    const center = bounds.left + bounds.width / 2;
    const edgeInset = 72;
    const below = bounds.top < 72;

    setTooltip({
      below,
      item,
      x: Math.max(edgeInset, Math.min(window.innerWidth - edgeInset, center)),
      y: below ? bounds.bottom + 8 : bounds.top - 8,
    });
  }

  return (
    <>
      <div className="uptime-chart" aria-label={`${label} 90 天可用率`}>
        {values.map((item, index) => (
          <button
            aria-describedby={
              tooltip?.item.date === item.date ? tooltipId : undefined
            }
            aria-label={`${item.label}: ${STATUS_META[item.status]?.label || item.status}`}
            className={`uptime-pill ${statusClass(item.status)}`}
            key={item.date}
            tabIndex={index === 0 ? 0 : -1}
            onKeyDown={(event) => {
              let target;
              if (event.key === "ArrowRight")
                target = event.currentTarget.nextElementSibling;
              else if (event.key === "ArrowLeft")
                target = event.currentTarget.previousElementSibling;
              else if (event.key === "Home")
                target = event.currentTarget.parentElement.firstElementChild;
              else if (event.key === "End")
                target = event.currentTarget.parentElement.lastElementChild;
              if (target) {
                event.preventDefault();
                target.focus();
              }
            }}
            onBlur={() => setTooltip(null)}
            onFocus={(event) => showTooltip(event, item)}
            onPointerEnter={(event) => showTooltip(event, item)}
            onPointerLeave={() => setTooltip(null)}
            style={{
              "--pill-color": STATUS_META[item.status]?.color || "#f7f7f8",
            }}
            type="button"
          />
        ))}
      </div>
      {tooltip
        ? createPortal(
            <div
              className={
                tooltip.below
                  ? "uptime-tooltip uptime-tooltip--below"
                  : "uptime-tooltip"
              }
              id={tooltipId}
              role="tooltip"
              style={{ left: tooltip.x, top: tooltip.y }}
            >
              <strong>{tooltip.item.label}</strong>
              <span>
                <i
                  style={{
                    background: STATUS_META[tooltip.item.status]?.color,
                  }}
                />
                {tooltip.item.status === "operational"
                  ? "正常运行"
                  : STATUS_META[tooltip.item.status]?.label}
              </span>
              {tooltip.item.coveragePercentage !== undefined ? (
                <span>监测覆盖 {tooltip.item.coveragePercentage}%</span>
              ) : null}
            </div>,
            document.body,
          )
        : null}
    </>
  );
});

function SummaryStatusIcon({ open, status }) {
  return (
    <span
      className={
        open
          ? "summary-status-slot summary-status-slot--hidden"
          : "summary-status-slot"
      }
    >
      <StatusIcon status={status} />
    </span>
  );
}

function ComponentStatusIcon({ index, status }) {
  return (
    <span
      className="component-status-slot"
      style={{ "--component-index": index }}
    >
      <StatusIcon status={status} />
    </span>
  );
}

const StatusGroup = memo(function StatusGroup({ group, incidents, navigate }) {
  const [open, setOpen] = useState(false);
  const groupHistory = group.history || [];
  return (
    <div className="system-group" key={group.id}>
      <button
        aria-expanded={open}
        className="system-group__summary"
        onClick={() => setOpen((value) => !value)}
        type="button"
      >
        <span className="system-group__name">
          <SummaryStatusIcon open={open} status={group.status} />
          <strong>{group.name}</strong>
          <span className="component-count">
            <span className="component-count__label">
              {group.components.length} 个服务
            </span>
            <img
              alt=""
              className={open ? "chevron chevron--open" : "chevron"}
              src={`${ASSET}/chevron-down.svg`}
            />
          </span>
        </span>
        <span
          aria-hidden={open}
          className={open ? "uptime-copy uptime-copy--hidden" : "uptime-copy"}
        >
          {uptime(group.uptimePercentage)}
        </span>
      </button>
      <div
        aria-hidden={!open}
        className={
          open
            ? "components-reveal components-reveal--open"
            : "components-reveal"
        }
        inert={!open}
      >
        <div className="components-reveal__inner">
          <div className="components-list">
            {group.components.map((component, index) => (
              <ComponentItem
                key={component.id}
                component={component}
                index={index}
                incidents={incidents}
                navigate={navigate}
              />
            ))}
          </div>
        </div>
      </div>
      <div
        className={
          open ? "aggregate-reveal" : "aggregate-reveal aggregate-reveal--open"
        }
      >
        <div className="aggregate-reveal__inner">
          <div className="desktop-uptime">
            <UptimeChart history={groupHistory} label={group.name} />
          </div>
        </div>
      </div>
    </div>
  );
});

function StatusOverview({ snapshot, navigate }) {
  return (
    <main className="main-content">
      <section
        className={`headline-card ${statusClass(snapshot.overallStatus)}`}
      >
        <div className="headline-card__title">
          <StatusIcon status={snapshot.overallStatus} />
          <strong>{snapshot.headline}</strong>
        </div>
        <p>{snapshot.message}</p>
      </section>

      {snapshot.activeIncidents?.length ? (
        <section className="active-incidents" aria-label="Active incidents">
          {snapshot.activeIncidents.map((incident) => (
            <IncidentCard
              key={incident.id}
              incident={incident}
              navigate={navigate}
            />
          ))}
        </section>
      ) : null}

      {snapshot.scheduledMaintenances?.length ? (
        <section className="active-incidents" aria-label="计划维护">
          {snapshot.scheduledMaintenances.map((i) => (
            <IncidentCard key={i.id} incident={i} navigate={navigate} />
          ))}
        </section>
      ) : null}

      <section className="system-card">
        <div className="system-card__header">
          <h1>服务状态</h1>
          <span className="date-range">{formatRange(snapshot.range)}</span>
        </div>
        {snapshot.groups.map((group) => (
          <StatusGroup
            key={group.id}
            group={group}
            incidents={snapshot.activeIncidents}
            navigate={navigate}
          />
        ))}
      </section>

      <div className="history-action">
        <button
          className="secondary-button"
          onClick={() => navigate("/history")}
          type="button"
        >
          <img alt="" src={`${ASSET}/calendar.svg`} />
          查看历史
        </button>
      </div>
      <p className="status-updated">
        最近更新：{formatInstant(snapshot.updatedAt)}
      </p>
      <p className="history-explanation">
        可用率基于最近 90
        天内的实际监测记录；灰色代表暂无数据，维护时段单独统计。
      </p>
    </main>
  );
}

function History({ data, navigate }) {
  return (
    <main className="history-page">
      <div className="breadcrumbs">
        <button onClick={() => navigate("/")} type="button">
          LaZy Campus
        </button>
        <span>/</span>
        <span>历史记录</span>
      </div>
      <div className="history-heading">
        <h1>历史记录</h1>
        <span className="date-range">{formatRange(data.range)}</span>
      </div>
      <div className="month-list">
        {data.months.map((month) => {
          return (
            <section className="month-row" key={month.key}>
              <h2>{formatDeviceMonthName(month.key)}</h2>
              {month.incidents.length === 0 ? (
                <p className="no-incidents">
                  <StatusIcon />
                  没有故障记录
                </p>
              ) : (
                <div className="history-incidents">
                  {month.incidents.map((incident) => (
                    <IncidentCard
                      key={incident.id}
                      incident={incident}
                      navigate={navigate}
                    />
                  ))}
                </div>
              )}
            </section>
          );
        })}
      </div>
    </main>
  );
}

function Header({ navigate, subscribe }) {
  return (
    <header className="site-header">
      <button
        aria-label="LaZy Campus home"
        className="brand-button"
        onClick={() => navigate("/")}
        type="button"
      >
        <img alt="Lazy Campus" src={statusPageLogoUrl} />
      </button>
      <button className="subscribe-button" onClick={subscribe}>
        订阅更新
      </button>
    </header>
  );
}

function Footer({ navigate }) {
  return (
    <footer className="site-footer">
      <a className="footer-brand" href="https://lazycampus.com">
        <img alt="" src={statusPageLogoUrl} />
        Lazy Campus
      </a>
      <button className="text-button" onClick={() => navigate("/api-docs")}>
        Status API
      </button>
      <button className="text-button" onClick={() => navigate("/admin")}>
        管理
      </button>
    </footer>
  );
}

export function App() {
  const [snapshot, setSnapshot] = useState(() => {
    const cached = readPublicCache("status", getDeviceTimeZone());
    if (!cached) return fallbackSnapshot;
    return Date.now() - Date.parse(cached.updatedAt) > staleAfter
      ? staleSnapshot(cached, "正在确认最新状态")
      : cached;
  });
  const [history, setHistory] = useState(
    () =>
      readPublicCache("history", getDeviceTimeZone()) || fallbackHistoryPage(),
  );
  const [path, setPath] = useState(window.location.pathname);
  const [subscribing, setSubscribing] = useState(false);

  useEffect(() => {
    let live = true;
    const loading = new Set();
    const controllers = new Set();
    async function refresh(kind, setter) {
      if (loading.has(kind) || document.hidden) return;
      loading.add(kind);
      const controller = new AbortController();
      controllers.add(controller);
      const timeout = window.setTimeout(() => controller.abort(), 10000);
      const timeZone = getDeviceTimeZone();
      try {
        const response = await fetch(
          `/api/v1/${kind}?timeZone=${encodeURIComponent(timeZone)}`,
          { cache: "no-store", signal: controller.signal },
        );
        if (!response.ok) throw new Error("Unavailable");
        const data = await response.json();
        if (!validPublicData(kind, data))
          throw new Error("Invalid public data");
        if (live) {
          setter(data);
          writePublicCache(kind, timeZone, data);
        }
      } catch {
        if (live && kind === "status")
          setSnapshot((previous) =>
            staleSnapshot(previous, "暂时无法更新状态"),
          );
      } finally {
        window.clearTimeout(timeout);
        controllers.delete(controller);
        loading.delete(kind);
      }
    }
    function load() {
      void refresh("status", setSnapshot);
      void refresh("history", setHistory);
    }
    load();
    const timer = window.setInterval(load, 30000);
    document.addEventListener("visibilitychange", load);
    return () => {
      live = false;
      window.clearInterval(timer);
      controllers.forEach((controller) => controller.abort());
      document.removeEventListener("visibilitychange", load);
    };
  }, []);

  useEffect(() => {
    const onPopState = () => setPath(window.location.pathname);
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  const navigate = useCallback((nextPath) => {
    window.history.pushState({}, "", nextPath);
    setPath(nextPath);
    window.scrollTo({ top: 0 });
  }, []);

  const isHistory = path === "/history" || path.endsWith("/history/");
  useEffect(() => {
    document.title = isHistory
      ? "History · LaZy Campus Status"
      : "LaZy Campus Status";
  }, [isHistory]);

  return (
    <div className="status-page">
      <div
        className={path === "/admin" ? "page-shell admin-shell" : "page-shell"}
      >
        <Header navigate={navigate} subscribe={() => setSubscribing(true)} />
        {path === "/admin" ? (
          <Admin navigate={navigate} />
        ) : path === "/api-docs" ? (
          <APIDocs navigate={navigate} />
        ) : path === "/unsubscribe" ? (
          <Unsubscribe />
        ) : path.startsWith("/incidents/") ? (
          <IncidentDetail id={path.split("/")[2]} navigate={navigate} />
        ) : isHistory ? (
          <History data={history} navigate={navigate} />
        ) : (
          <StatusOverview navigate={navigate} snapshot={snapshot} />
        )}
        <Footer navigate={navigate} />
        {subscribing ? (
          <Subscribe snapshot={snapshot} close={() => setSubscribing(false)} />
        ) : null}
      </div>
    </div>
  );
}

function IncidentDetail({ id, navigate }) {
  const [data, setData] = useState(null),
    [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/v1/incidents/" + encodeURIComponent(id), {
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) throw new Error("无法读取此记录");
        return response.json();
      })
      .then(setData)
      .catch((error) => {
        if (error.name !== "AbortError") setError(error.message);
      });
    return () => controller.abort();
  }, [id]);
  return (
    <main className="history-page">
      <div className="breadcrumbs">
        <button onClick={() => navigate("/")}>服务状态</button>
        <span>/</span>
        <button onClick={() => navigate("/history")}>历史记录</button>
      </div>
      {error ? (
        <p role="alert">{error}</p>
      ) : !data ? (
        <p>读取中…</p>
      ) : (
        <>
          <h1 className="incident-title">{data.title}</h1>
          <p>{data.message}</p>
          {data.scheduledStart ? (
            <p>
              {formatInstant(data.scheduledStart)} —{" "}
              {formatInstant(data.scheduledEnd)}
            </p>
          ) : null}
          <div className="incident-timeline">
            {data.updates.map((update) => (
              <article key={update.id}>
                <time>{formatInstant(update.createdAt)}</time>
                <strong>
                  {
                    {
                      investigating: "正在排查",
                      identified: "原因已确认",
                      monitoring: "恢复观察",
                      resolved: "已恢复",
                      scheduled: "计划维护",
                      in_progress: "维护中",
                      completed: "维护完成",
                      cancelled: "已取消",
                    }[update.phase]
                  }
                </strong>
                <p>{update.message}</p>
              </article>
            ))}
          </div>
        </>
      )}
    </main>
  );
}
