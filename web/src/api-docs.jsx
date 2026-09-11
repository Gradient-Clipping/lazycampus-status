import { useState } from "react";
export function APIDocs({ navigate }) {
  const [copied, setCopied] = useState(false);
  const base = window.location.origin;
  const example = `try {\n  const response = await fetch('${base}/api/v1/summary', {\n    signal: AbortSignal.timeout(3000)\n  });\n  if (response.ok) {\n    const status = await response.json();\n    // 将 status.headline 用于可选状态提示。\n  }\n} catch {\n  // 状态服务不可达时，继续应用原有流程。\n}`;
  async function copy() {
    try {
      await navigator.clipboard.writeText(example);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }
  return (
    <main className="history-page api-docs">
      <div className="breadcrumbs">
        <button onClick={() => navigate("/")}>服务状态</button>
        <span>/</span>
        <span>Status API</span>
      </div>
      <h1 className="incident-title">Status API</h1>
      <p>
        读取服务状态、订阅故障进展，或为自己的项目添加独立监测。公开查询无需密钥。
      </p>
      <a
        className="secondary-button"
        href="/openapi.json"
        download="lazycampus-status-openapi.json"
      >
        下载 OpenAPI 3.0 契约
      </a>
      <section>
        <h2>公开查询</h2>
        <div className="docs-table">
          <table>
            <thead>
              <tr>
                <th>GET 接口</th>
                <th>用途</th>
              </tr>
            </thead>
            <tbody>
              {[
                ["/api/v1/summary", "轻量项目摘要，适合可选状态提示"],
                ["/api/v1/status", "完整项目、服务状态与 90 天历史"],
                ["/api/v1/components", "所有公开服务及历史"],
                ["/api/v1/components/{id}", "单个服务详情"],
                ["/api/v1/history", "按月份汇总的故障与维护历史"],
                ["/api/v1/incidents/{id}", "故障详情与进展记录"],
                ["/feed.rss · /feed.atom", "故障与维护订阅"],
              ].map(([path, description]) => (
                <tr key={path}>
                  <td>
                    <code>{path}</code>
                  </td>
                  <td>{description}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p>
          历史接口支持 <code>timeZone=Asia%2FShanghai</code> 等 IANA 时区；默认
          UTC。时间戳均为 RFC 3339，日期统计按指定时区划分。
        </p>
      </section>
      <section>
        <h2>状态与统计</h2>
        <div className="docs-table">
          <table>
            <tbody>
              {[
                ["operational", "正常运行"],
                ["degraded_performance", "性能下降"],
                ["partial_outage", "部分异常"],
                ["full_outage", "服务中断"],
                ["maintenance", "维护中"],
                ["no_data", "暂无数据或监测已过期"],
              ].map(([code, label]) => (
                <tr key={code}>
                  <td>
                    <code>{code}</code>
                  </td>
                  <td>{label}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p>
          默认每 30 秒探测一次，连续 3 次失败确认异常，连续 2
          次成功确认恢复。可用率使用
          availabilityPercentage，统计正常和性能下降时长；维护和未知不进入分母。coveragePercentage
          单独表示覆盖率，uptimePercentage
          保留完全正常运行比例。新接入项目不会补造历史记录。
        </p>
        <p>
          <code>stale: true</code> 表示监测数据更新延迟。请结合{" "}
          <code>updatedAt</code> 与组件的 <code>checkedAt</code>{" "}
          使用，避免将旧状态当成当前正常。
        </p>
      </section>
      <section>
        <h2>业务组件报告</h2>
        <p>
          组件 evidence 可包含最近 5 分钟的
          requests、errors、limited、successPercentage、p95Ms 和
          observedAt。预期的 4xx
          不计为服务故障，限流单独统计；没有近期样本时显示未知。P95
          在部分服务中使用耗时桶估算。
        </p>
        <p>
          应用可选提供只读
          /internal/monitoring/v1/state，由状态页携带独立凭据主动读取。关闭状态页不影响应用。管理端发布事件可携带
          Idempotency-Key，重试复用相同键和请求体。
        </p>
      </section>
      <section>
        <h2>可选接入示例</h2>
        <div className="docs-code-header">
          <span>JavaScript</span>
          <button className="text-button" onClick={copy}>
            {copied ? "已复制" : "复制"}
          </button>
        </div>
        <pre>
          <code>{example}</code>
        </pre>
        <p>
          缓存最近一次有效摘要，轮询间隔至少 30
          秒。状态查询失败时隐藏提示或显示“状态未知”，不要阻断登录、查询或应用启动。
        </p>
      </section>
      <section>
        <h2>新增项目</h2>
        <ol>
          <li>
            已有集群项目：在 GitOps
            监测清单中添加项目分组、公开服务名和健康检查地址；不修改业务源码。
          </li>
          <li>
            外部 HTTP / TCP 服务：管理员通过组件管理或{" "}
            <code>POST /api/v1/admin/components</code>{" "}
            注册目标。探测域名须在部署白名单内。
          </li>
          <li>
            定时任务或无入站地址的服务：创建心跳组件，签发仅绑定该组件的{" "}
            <code>heartbeat:write</code> 凭据，通过{" "}
            <code>POST /api/v1/heartbeats/{"{id}"}</code> 上报{" "}
            <code>{'{"status":"operational"}'}</code>。
          </li>
        </ol>
        <p>
          管理及心跳 API 使用 <code>Authorization: Bearer &lt;token&gt;</code>
          。凭据只显示一次，可设置有效期和撤销。公开页面不提供注册或管理权限。
        </p>
      </section>
      <section>
        <h2>限制与错误</h2>
        <p>
          公开 API 每来源地址每分钟 120 次；心跳每组件每分钟 6
          次。邮件验证码每来源地址每小时 3 次、每邮箱每分钟 1 次且每天 6
          次；验证码校验每邮箱和来源地址每 10 分钟各 5 次。
        </p>
        <p>
          400 参数无效，401 未登录，403 权限不足，404 不存在，409 编辑冲突，429
          请求过多，503 暂时不可用。遇到 429 请遵守 <code>Retry-After</code>
          ；其他临时错误使用指数退避。错误体包含 <code>error.code</code>、
          <code>error.message</code> 和 <code>error.requestId</code>。
        </p>
        <p>
          涉及管理修改时传入当前记录的 <code>version</code>；收到 409
          后重新读取，避免覆盖其他管理员的修改。
        </p>
      </section>
    </main>
  );
}
