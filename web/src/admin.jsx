import { useCallback, useEffect, useState } from "react";
import { api } from "./subscribe.jsx";
import { formatInstant, inputToInstant } from "./device-time.js";
const phases = {
  investigating: "正在排查",
  identified: "原因已确认",
  monitoring: "恢复观察",
  resolved: "已恢复",
  scheduled: "计划维护",
  in_progress: "维护中",
  completed: "维护完成",
  cancelled: "已取消",
};
const states = {
  operational: "正常",
  degraded_performance: "性能下降",
  partial_outage: "部分异常",
  full_outage: "中断",
  maintenance: "维护中",
  no_data: "未知",
};
export function Admin({ navigate }) {
  const [data, setData] = useState(null),
    [tab, setTab] = useState("services"),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    try {
      setData(await api("/api/v1/admin/overview", undefined, "GET"));
      setError("");
    } catch (error) {
      if (error.status === 401) window.location.replace("/auth/login");
      else setError(error.message);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  async function action(fn) {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await fn();
      await load();
    } catch (error) {
      setError(error.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="history-page admin-page">
      <div className="breadcrumbs">
        <button onClick={() => navigate("/")}>服务状态</button>
        <span>/</span>
        <span>管理</span>
      </div>
      <div className="admin-heading">
        <h1>状态页管理</h1>
        <div>
          <button className="secondary-button" disabled={busy} onClick={load}>
            刷新
          </button>
          <button
            className="text-button"
            onClick={() =>
              action(async () => {
                await api("/auth/logout", {});
                navigate("/");
              })
            }
          >
            退出
          </button>
        </div>
      </div>
      {error ? (
        <p role="alert" className="form-message error">
          {error}
        </p>
      ) : null}
      {!data ? (
        <p>读取中…</p>
      ) : (
        <>
          <div className="admin-summary">
            <span>最近监测 {formatInstant(data.lastRun)}</span>
            <span>{data.components.length} 个监测组件</span>
            <span>{data.storageError ? "存储异常" : "存储正常"}</span>
            <span>采集耗时 {data.cycleDurationMs ?? "—"} ms</span>
            <span>
              邮件任务{" "}
              {data.lastMailError ? "异常" : formatInstant(data.lastMailRun)}
            </span>
            <span>
              待处理投递{" "}
              {data.attention?.reduce(
                (sum, item) => sum + Number(item.count),
                0,
              ) || 0}
            </span>
          </div>
          <nav className="tabs" aria-label="管理栏目">
            {[
              ["services", "服务"],
              ["incidents", "故障与维护"],
              ["tokens", "接入凭据"],
              ["audit", "审计"],
            ].map(([key, label]) => (
              <button
                key={key}
                className={tab === key ? "tab tab--active" : "tab"}
                aria-pressed={tab === key}
                onClick={() => setTab(key)}
              >
                {label}
              </button>
            ))}
          </nav>
          {tab === "services" ? (
            <Services
              components={data.components}
              action={action}
              busy={busy}
            />
          ) : tab === "incidents" ? (
            <Incidents
              components={data.components}
              incidents={data.incidents}
              action={action}
              busy={busy}
            />
          ) : tab === "tokens" ? (
            <Tokens components={data.components} action={action} busy={busy} />
          ) : (
            <Audit />
          )}
          <p className="admin-revision">运行版本 {data.revision}</p>
          <div className="admin-summary">
            {data.deliveries.map((d) => (
              <span key={d.status}>
                邮件 {d.status}: {d.count}
              </span>
            ))}
          </div>
        </>
      )}
    </main>
  );
}
function Services({ components, action, busy }) {
  const [internal, setInternal] = useState(false),
    [query, setQuery] = useState(""),
    [creating, setCreating] = useState(false),
    [kind, setKind] = useState("http");
  const visible = components.filter(
    (c) =>
      (internal || c.public !== false) &&
      [c.name, c.id, c.groupName].some((v) =>
        v?.toLowerCase().includes(query.toLowerCase()),
      ),
  );
  function create(event) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    void action(async () => {
      await api("/api/v1/admin/components", {
        id: data.get("id"),
        name: data.get("name"),
        group: data.get("group"),
        groupName: data.get("groupName"),
        kind,
        public: data.get("public") === "on",
        ...(kind === "heartbeat"
          ? { heartbeatSeconds: Number(data.get("heartbeatSeconds")) }
          : { target: data.get("target") }),
      });
      setCreating(false);
    });
  }
  return (
    <section className="admin-section">
      <div className="admin-toolbar">
        <input
          aria-label="搜索组件"
          placeholder="搜索项目或组件"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <label>
          <input
            type="checkbox"
            checked={internal}
            onChange={(e) => setInternal(e.target.checked)}
          />
          显示内部监测
        </label>
        <button
          className="subscribe-button"
          onClick={() => setCreating(!creating)}
        >
          {creating ? "收起" : "新增服务"}
        </button>
      </div>
      {creating ? (
        <form className="admin-form" onSubmit={create}>
          <h2>新增服务</h2>
          <div className="form-grid">
            <label>
              唯一 ID
              <input
                name="id"
                required
                pattern="[a-zA-Z0-9][a-zA-Z0-9:._-]*"
                maxLength={160}
              />
            </label>
            <label>
              显示名称
              <input name="name" required maxLength={100} />
            </label>
            <label>
              项目 ID
              <input name="group" required maxLength={80} />
            </label>
            <label>
              项目名称
              <input name="groupName" required maxLength={100} />
            </label>
            <label>
              监测类型
              <select value={kind} onChange={(e) => setKind(e.target.value)}>
                <option value="http">HTTP</option>
                <option value="tcp">TCP</option>
                <option value="heartbeat">心跳</option>
              </select>
            </label>
            {kind === "heartbeat" ? (
              <label>
                心跳有效期（秒）
                <input
                  name="heartbeatSeconds"
                  type="number"
                  min={60}
                  max={86400}
                  defaultValue={180}
                  required
                />
              </label>
            ) : (
              <label>
                探测地址
                <input
                  name="target"
                  placeholder={
                    kind === "tcp"
                      ? "tcp://service.example:443"
                      : "https://service.example/health"
                  }
                  required
                  maxLength={2048}
                />
              </label>
            )}
          </div>
          <label className="checkbox-row">
            <input name="public" type="checkbox" defaultChecked />
            在公开页面展示
          </label>
          <button className="subscribe-button" disabled={busy}>
            保存服务
          </button>
        </form>
      ) : null}
      <div className="admin-service-list">
        {visible.map((c) => (
          <Service key={c.id} component={c} action={action} busy={busy} />
        ))}
      </div>
      {!visible.length ? <p>没有匹配的组件。</p> : null}
    </section>
  );
}
function Service({ component: c, action, busy }) {
  const [open, setOpen] = useState(false),
    [observations, setObservations] = useState(null),
    [error, setError] = useState("");
  async function details() {
    setOpen(!open);
    if (!open)
      try {
        setObservations(
          (
            await api(
              "/api/v1/admin/components/" +
                encodeURIComponent(c.id) +
                "/observations",
              undefined,
              "GET",
            )
          ).observations,
        );
      } catch (error) {
        setError(error.message);
      }
  }
  function patch(body) {
    void action(() =>
      api(
        "/api/v1/admin/components/" + encodeURIComponent(c.id),
        { version: c.version, ...body },
        "PATCH",
      ),
    );
  }
  return (
    <article className="admin-service">
      <button
        className="admin-service-title"
        onClick={details}
        aria-expanded={open}
      >
        <span>
          <strong>{c.name}</strong>
          <small>
            {c.groupName} · {c.kind}
          </small>
        </span>
        <span className={"status-badge status-" + c.status}>
          {states[c.status]}
        </span>
      </button>
      {open ? (
        <div className="admin-service-body">
          <dl>
            <div>
              <dt>ID</dt>
              <dd>
                <code>{c.id}</code>
              </dd>
            </div>
            <div>
              <dt>来源</dt>
              <dd>{c.source}</dd>
            </div>
            <div>
              <dt>最近检查</dt>
              <dd>{formatInstant(c.checkedAt)}</dd>
            </div>
            <div>
              <dt>诊断</dt>
              <dd>{c.reason}</dd>
            </div>
            {c.target ? (
              <div>
                <dt>探测地址</dt>
                <dd>
                  <code>{c.target}</code>
                </dd>
              </div>
            ) : null}
            {c.dependencies?.length ? (
              <div>
                <dt>关联检查</dt>
                <dd>{c.dependencies.join("、")}</dd>
              </div>
            ) : null}
          </dl>
          {c.kind !== "kubernetes" ? (
            <form
              className="admin-form"
              onSubmit={(event) => {
                event.preventDefault();
                const values = new FormData(event.currentTarget);
                patch(
                  Object.fromEntries(
                    [
                      "intervalSeconds",
                      "timeoutSeconds",
                      "failureThreshold",
                      "recoveryThreshold",
                      "degradedAfterMs",
                    ].map((key) => [key, Number(values.get(key))]),
                  ),
                );
              }}
            >
              <div className="form-grid">
                {[
                  ["intervalSeconds", "检查间隔（秒）", 30, 3600, 30],
                  ["timeoutSeconds", "超时（秒）", 1, 15, 5],
                  ["failureThreshold", "异常确认次数", 1, 10, 3],
                  ["recoveryThreshold", "恢复确认次数", 1, 10, 2],
                  ["degradedAfterMs", "响应阈值（毫秒）", 100, 15000, 3000],
                ].map(([key, label, min, max, fallback]) => (
                  <label key={key}>
                    {label}
                    <input
                      name={key}
                      type="number"
                      min={min}
                      max={max}
                      defaultValue={c[key] || fallback}
                      required
                    />
                  </label>
                ))}
              </div>
              <button className="secondary-button" disabled={busy}>
                保存监测设置
              </button>
            </form>
          ) : null}
          <div className="admin-toolbar">
            <button
              className="secondary-button"
              disabled={busy}
              onClick={() => patch({ paused: !c.paused })}
            >
              {c.paused ? "恢复监测" : "暂停监测"}
            </button>
            <button
              className="secondary-button"
              disabled={busy}
              onClick={() => patch({ public: c.public === false })}
            >
              {c.public === false ? "公开显示" : "隐藏"}
            </button>
          </div>
          {error ? <p role="alert">{error}</p> : null}
          {observations ? (
            <div className="docs-table">
              <table>
                <thead>
                  <tr>
                    <th>时间</th>
                    <th>原始结果 / 确认状态</th>
                    <th>耗时</th>
                    <th>诊断</th>
                  </tr>
                </thead>
                <tbody>
                  {observations.map((r, index) => (
                    <tr key={r.checkedAt + index}>
                      <td>{formatInstant(r.checkedAt)}</td>
                      <td>
                        {states[r.rawStatus]} / {states[r.status]}
                      </td>
                      <td>{r.latencyMs ?? "—"} ms</td>
                      <td>{r.reason}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p>读取探测记录…</p>
          )}
        </div>
      ) : null}
    </article>
  );
}
function Incidents({ components, incidents, action, busy }) {
  const [creating, setCreating] = useState(false),
    [maintenance, setMaintenance] = useState(false),
    [ids, setIDs] = useState([]);
  function create(event) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    void action(async () => {
      await api("/api/v1/admin/incidents", {
        title: data.get("title"),
        message: data.get("message"),
        componentIds: ids,
        severity: maintenance ? "maintenance" : data.get("severity"),
        ...(maintenance
          ? {
              scheduledStart: inputToInstant(data.get("start")),
              scheduledEnd: inputToInstant(data.get("end")),
            }
          : {}),
      });
      setCreating(false);
      setIDs([]);
    });
  }
  return (
    <section className="admin-section">
      <div className="admin-toolbar">
        <button
          className="subscribe-button"
          onClick={() => setCreating(!creating)}
        >
          {creating ? "收起" : "发布故障或维护"}
        </button>
      </div>
      {creating ? (
        <form className="admin-form" onSubmit={create}>
          <label>
            标题
            <input name="title" required maxLength={160} />
          </label>
          <label>
            情况说明
            <textarea name="message" required maxLength={4000} />
          </label>
          <div className="component-options">
            {components
              .filter((c) => c.public !== false)
              .map((c) => (
                <label key={c.id}>
                  <input
                    type="checkbox"
                    checked={ids.includes(c.id)}
                    onChange={(e) =>
                      setIDs((old) =>
                        e.target.checked
                          ? [...old, c.id]
                          : old.filter((id) => id !== c.id),
                      )
                    }
                  />
                  {c.groupName} · {c.name}
                </label>
              ))}
          </div>
          <label className="checkbox-row">
            <input
              type="checkbox"
              checked={maintenance}
              onChange={(e) => setMaintenance(e.target.checked)}
            />
            计划维护
          </label>
          {maintenance ? (
            <div className="form-grid">
              <label>
                开始时间
                <input type="datetime-local" name="start" required />
              </label>
              <label>
                结束时间
                <input type="datetime-local" name="end" required />
              </label>
            </div>
          ) : (
            <label>
              影响程度
              <select name="severity">
                <option value="partial_outage">部分异常</option>
                <option value="degraded_performance">性能下降</option>
                <option value="full_outage">服务中断</option>
              </select>
            </label>
          )}
          <button className="subscribe-button" disabled={busy || !ids.length}>
            发布
          </button>
        </form>
      ) : null}
      <div className="admin-service-list">
        {incidents.map((i) => (
          <IncidentEditor key={i.id} incident={i} action={action} busy={busy} />
        ))}
      </div>
      {!incidents.length ? <p>没有故障或维护记录。</p> : null}
    </section>
  );
}
function IncidentEditor({ incident: i, action, busy }) {
  const [open, setOpen] = useState(false);
  const choices = (
    {
      investigating: ["investigating", "identified", "monitoring", "resolved"],
      identified: ["identified", "monitoring", "resolved"],
      monitoring: ["monitoring", "identified", "resolved"],
      scheduled: ["scheduled", "in_progress", "cancelled"],
      in_progress: ["in_progress", "completed"],
    }[i.phase] || []
  ).filter((phase) => !(i.source === "monitor" && phase === "resolved"));
  const terminal = ["resolved", "completed", "cancelled"].includes(i.phase);
  function update(event) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    void action(async () => {
      await api("/api/v1/admin/incidents/" + i.id + "/updates", {
        version: i.version,
        phase: data.get("phase"),
        message: data.get("message"),
      });
      setOpen(false);
    });
  }
  return (
    <article className="admin-service">
      <button
        className="admin-service-title"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
      >
        <span>
          <strong>{i.title}</strong>
          <small>
            {formatInstant(i.updatedAt)} ·{" "}
            {i.source === "monitor" ? "自动监测" : "人工发布"}
          </small>
        </span>
        <span>{phases[i.phase]}</span>
      </button>
      {open ? (
        <div className="admin-service-body">
          <p>{i.message}</p>
          <a href={"/incidents/" + i.id} target="_blank" rel="noreferrer">
            查看公开记录 ↗
          </a>
          {!terminal ? (
            <form className="admin-form" onSubmit={update}>
              <label>
                进展
                <select name="phase" defaultValue={i.phase}>
                  {choices.map((value) => (
                    <option key={value} value={value}>
                      {phases[value]}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                更新说明
                <textarea name="message" required maxLength={4000} />
              </label>
              {i.source === "monitor" ? (
                <p>自动故障由连续成功的监测确认恢复。</p>
              ) : null}
              <button className="subscribe-button" disabled={busy}>
                发布更新
              </button>
            </form>
          ) : null}
        </div>
      ) : null}
    </article>
  );
}
function Tokens({ components, action, busy }) {
  const [tokens, setTokens] = useState([]),
    [created, setCreated] = useState(null),
    [scope, setScope] = useState("heartbeat:write"),
    [ids, setIDs] = useState([]),
    [error, setError] = useState("");
  const load = useCallback(async () => {
    try {
      setTokens((await api("/api/v1/admin/tokens", undefined, "GET")).tokens);
    } catch (error) {
      setError(error.message);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  function create(event) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    void action(async () => {
      setCreated(
        await api("/api/v1/admin/tokens", {
          name: data.get("name"),
          scopes: [scope],
          componentIds: scope === "heartbeat:write" ? ids : [],
          expiresDays: Number(data.get("days")),
        }),
      );
      await load();
    });
  }
  return (
    <section className="admin-section">
      <form className="admin-form" onSubmit={create}>
        <h2>创建接入凭据</h2>
        <div className="form-grid">
          <label>
            名称
            <input name="name" required maxLength={100} />
          </label>
          <label>
            有效天数
            <input
              name="days"
              type="number"
              min={1}
              max={365}
              defaultValue={90}
              required
            />
          </label>
          <label>
            权限
            <select value={scope} onChange={(e) => setScope(e.target.value)}>
              {[
                ["heartbeat:write", "心跳上报"],
                ["admin:read", "只读管理数据"],
                ["components:write", "管理组件"],
                ["incidents:write", "发布故障"],
              ].map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </label>
        </div>
        {scope === "heartbeat:write" ? (
          <div className="component-options">
            {components
              .filter((c) => c.kind === "heartbeat")
              .map((c) => (
                <label key={c.id}>
                  <input
                    type="checkbox"
                    checked={ids.includes(c.id)}
                    onChange={(e) =>
                      setIDs((old) =>
                        e.target.checked
                          ? [...old, c.id]
                          : old.filter((id) => id !== c.id),
                      )
                    }
                  />
                  {c.name}
                </label>
              ))}
            {!components.some((c) => c.kind === "heartbeat") ? (
              <span>请先添加心跳监测服务。</span>
            ) : null}
          </div>
        ) : null}
        <button
          className="subscribe-button"
          disabled={busy || (scope === "heartbeat:write" && !ids.length)}
        >
          创建凭据
        </button>
      </form>
      {created ? (
        <div className="token-created" role="status">
          <strong>请保存密钥，此处只显示一次。</strong>
          <input
            aria-label="新接入密钥"
            readOnly
            value={created.token}
            onFocus={(e) => e.target.select()}
          />
          <button className="secondary-button" onClick={() => setCreated(null)}>
            我已保存
          </button>
        </div>
      ) : null}
      {error ? <p role="alert">{error}</p> : null}
      <div className="admin-service-list">
        {tokens.map((t) => (
          <article className="admin-service" key={t.id}>
            <div className="admin-service-title">
              <span>
                <strong>{t.name}</strong>
                <small>
                  {t.scopes.join("、")} · 到期 {formatInstant(t.expires_at)}
                </small>
              </span>
              <button
                className="secondary-button"
                disabled={busy || Boolean(t.revoked)}
                onClick={() =>
                  action(async () => {
                    await api(
                      "/api/v1/admin/tokens/" + t.id,
                      undefined,
                      "DELETE",
                    );
                    await load();
                  })
                }
              >
                {t.revoked ? "已撤销" : "撤销"}
              </button>
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}
function Audit() {
  const [data, setData] = useState(null),
    [error, setError] = useState("");
  useEffect(() => {
    let live = true;
    api("/api/v1/admin/audit", undefined, "GET")
      .then((data) => {
        if (live) setData(data.events);
      })
      .catch((error) => {
        if (live) setError(error.message);
      });
    return () => {
      live = false;
    };
  }, []);
  return (
    <section className="admin-section">
      {error ? <p role="alert">{error}</p> : null}
      {data ? (
        <div className="docs-table">
          <table>
            <thead>
              <tr>
                <th>时间</th>
                <th>操作者</th>
                <th>操作</th>
                <th>对象</th>
              </tr>
            </thead>
            <tbody>
              {data.map((e) => (
                <tr key={e.id}>
                  <td>{formatInstant(e.created_at)}</td>
                  <td>{e.actor}</td>
                  <td>{e.action}</td>
                  <td>
                    <code>{e.target}</code>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p>读取中…</p>
      )}
    </section>
  );
}
