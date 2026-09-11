import { useEffect, useRef, useState } from "react";
export async function api(path, body, method = "POST") {
  const response = await fetch(path, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: "no-store",
  });
  const result = await response.json();
  if (!response.ok)
    throw Object.assign(
      new Error(result.error?.message || "请求未完成，请重试"),
      { status: response.status },
    );
  return result;
}
export function Subscribe({ snapshot, close }) {
  const dialog = useRef(null),
    [tab, setTab] = useState(snapshot.subscriptionsEnabled ? "email" : "rss"),
    [email, setEmail] = useState(""),
    [code, setCode] = useState(""),
    [selected, setSelected] = useState([]),
    [custom, setCustom] = useState(false),
    [stage, setStage] = useState("email"),
    [message, setMessage] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    const node = dialog.current;
    node.showModal();
    return () => node.close();
  }, []);
  async function submit(event) {
    event.preventDefault();
    setBusy(true);
    setError("");
    setMessage("");
    try {
      if (stage === "email") {
        if (custom && !selected.length) throw new Error("请至少选择一个服务");
        const result = await api("/api/v1/subscriptions", {
          email,
          componentIds: custom ? selected : [],
        });
        setStage("verify");
        setMessage(result.message);
      } else {
        const result = await api("/api/v1/subscriptions/confirm", {
          email,
          code,
        });
        setStage("complete");
        setMessage(result.message);
      }
    } catch (error) {
      setError(error.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <dialog
      ref={dialog}
      className="subscribe-modal"
      onClose={close}
      aria-labelledby="subscribe-title"
    >
      <header>
        <h2 id="subscribe-title">订阅服务更新</h2>
        <button className="close-button" onClick={close} aria-label="关闭">
          <img alt="" src="/assets/close.svg" />
        </button>
      </header>
      <div className="subscribe-body">
        <div className="tabs">
          <button
            className={tab === "email" ? "tab tab--active" : "tab"}
            aria-pressed={tab === "email"}
            onClick={() => setTab("email")}
            disabled={!snapshot.subscriptionsEnabled}
          >
            <img alt="" src="/assets/email.svg" />
            邮件
          </button>
          <button
            className={tab === "rss" ? "tab tab--active" : "tab"}
            aria-pressed={tab === "rss"}
            onClick={() => setTab("rss")}
          >
            <img alt="" src="/assets/rss.svg" />
            RSS / Atom
          </button>
        </div>
        {tab === "email" ? (
          <form className="email-form" onSubmit={submit}>
            <label htmlFor="subscription-email">邮箱地址</label>
            <input
              id="subscription-email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoComplete="email"
              required
              maxLength={254}
              disabled={stage !== "email" || busy}
            />
            {stage === "email" ? (
              <>
                <label className="checkbox-row">
                  <input
                    type="checkbox"
                    checked={custom}
                    onChange={(e) => setCustom(e.target.checked)}
                  />
                  只订阅指定服务
                </label>
                {custom ? (
                  <div className="component-options">
                    {snapshot.groups.map((group) => (
                      <fieldset key={group.id}>
                        <legend>{group.name}</legend>
                        {group.components.map((c) => (
                          <label key={c.id}>
                            <input
                              type="checkbox"
                              checked={selected.includes(c.id)}
                              onChange={(e) =>
                                setSelected((items) =>
                                  e.target.checked
                                    ? [...items, c.id]
                                    : items.filter((id) => id !== c.id),
                                )
                              }
                            />
                            {c.name}
                          </label>
                        ))}
                      </fieldset>
                    ))}
                  </div>
                ) : null}
              </>
            ) : stage === "verify" ? (
              <>
                <label className="verify-label" htmlFor="subscription-code">
                  邮件验证码
                </label>
                <input
                  id="subscription-code"
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  inputMode="numeric"
                  pattern="[0-9]{6}"
                  maxLength={6}
                  autoComplete="one-time-code"
                  required
                />
              </>
            ) : null}
            {message ? (
              <p className="form-message success" role="status">
                {message}
              </p>
            ) : null}
            {error ? (
              <p className="form-message error" role="alert">
                {error}
              </p>
            ) : null}
            <div className="subscription-note">
              <img alt="" src="/assets/megaphone.svg" />
              仅发送服务故障与维护通知，可随时通过邮件退订。
            </div>
            <div className="modal-actions">
              {stage === "verify" ? (
                <button
                  className="secondary-button"
                  type="button"
                  onClick={() => {
                    setStage("email");
                    setMessage("");
                  }}
                >
                  修改邮箱
                </button>
              ) : null}
              {stage === "complete" ? (
                <button
                  className="subscribe-button"
                  type="button"
                  onClick={close}
                >
                  完成
                </button>
              ) : (
                <button className="subscribe-button" disabled={busy}>
                  {busy
                    ? "提交中…"
                    : stage === "email"
                      ? "发送验证码"
                      : "确认订阅"}
                </button>
              )}
            </div>
          </form>
        ) : (
          <div className="feed-panel">
            <p>将订阅地址添加到 RSS / Atom 阅读器，接收故障与维护进展。</p>
            {["rss", "atom"].map((format) => (
              <label key={format}>
                <span>{format.toUpperCase()}</span>
                <input
                  readOnly
                  aria-label={`${format.toUpperCase()} 订阅地址`}
                  value={`${window.location.origin}/feed.${format}`}
                  onFocus={(e) => e.target.select()}
                />
              </label>
            ))}
            <div className="modal-actions">
              <button className="secondary-button" onClick={close}>
                完成
              </button>
            </div>
          </div>
        )}
      </div>
    </dialog>
  );
}
export function Unsubscribe() {
  const [message, setMessage] = useState("确认后将停止接收服务通知。"),
    [done, setDone] = useState(false),
    [busy, setBusy] = useState(false);
  async function submit() {
    setBusy(true);
    try {
      const [id, token] = window.location.hash.slice(1).split(".");
      const result = await api("/api/v1/subscriptions/unsubscribe", {
        id,
        token,
      });
      setMessage(result.message);
      setDone(true);
      window.history.replaceState({}, "", window.location.pathname);
    } catch (error) {
      setMessage(error.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="history-page">
      <h1 className="incident-title">退订通知</h1>
      <p role="status">{message}</p>
      {!done ? (
        <button className="subscribe-button" disabled={busy} onClick={submit}>
          {busy ? "提交中…" : "确认退订"}
        </button>
      ) : null}
    </main>
  );
}
