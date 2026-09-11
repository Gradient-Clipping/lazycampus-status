# 新项目接入规范

## 可选组件报告

应用可提供 `GET /internal/monitoring/v1/state`，由 Status 每 30 秒主动读取，无需应用发起请求。`STATUS_MONITOR_TOKEN` 默认不配置，集成关闭；启用时使用独立的至少 32 字符随机 Bearer 凭据，仅允许读监控报告。

```json
{
  "version": 1,
  "observedAt": "2026-09-11T12:00:00.000Z",
  "components": {
    "orders": {
      "status": "operational",
      "healthStatus": "operational",
      "requests": 120,
      "errors": 1,
      "limited": 3,
      "p95Ms": 250,
      "windowSeconds": 300
    }
  }
}
```

组件必须依据真实只读检查或已发生的业务请求。`healthStatus` 单独描述存储、会话、上游入口等只读检查结果，`status` 合并健康检查与调用异常，取较严重状态。Status 可调整流量阈值，但不会降低独立健康检查的故障等级；旧报告没有 `healthStatus` 时保留原有故障等级。

`requests` 排除预期客户端 4xx，`errors` 是服务端失败，429 单独记为 `limited`。窗口为最近 5 分钟，Node.js 的 P95 使用固定耗时桶估算。零请求且只读检查通过时仍为 `operational`，请求数为 0，省略成功率和 P95，页面显示“暂无调用”。没有健康证据、查询失败或统计截断时不能当作零请求；返回 `no_data` 并省略不完整统计。未知和维护时段不计入可用率，也不补造接入前历史。

Easy SWU 检查对应业务表、MySQL/Redis 和匿名教务、公告、电费入口；Identity Bridge 检查身份表、OIDC 会话表和学校认证入口；开放平台检查本地依赖与校园后端只读就绪接口。匿名入口检查不代表完整的学生登录或查询已成功，实际业务错误率仍独立参与判断。Node.js 的认证报告读取立即返回，后台并发探测在 8.5 秒内结束，15 秒内复用结果；首次结果尚未返回或健康结果超过 60 秒时报告未知。不会启动登录、切换 VPN、写入业务数据或发送邮件。

GitOps 监测项配置 `kind: "http"`、`reportKey: "orders"`、`credentialRef` 和 `reportTTLSeconds: 100`。`STATUS_PROBE_CREDENTIALS` 将凭据引用绑定至唯一集群内部 URL；禁止跨地址发送凭据，不跟随重定向。每轮相同报告仅抓取一次，最大 64 KiB。版本不支持、组件缺失或报告过期均显示未知。

公开 API 仅保留数字和时间，不透传任务详情、内部诊断或任意字段。`incidentGroup` 合并同一项目的异常；`dependencies` 为必要依赖，`optionalDependencies` 失败最多降级。`assetCheck: true` 只读检查 HTML 中最多两个同源 JS/CSS 资源。

后台可覆盖检查间隔、超时、异常与恢复次数、耗时阈值；管理 API 还支持 `minRequests`、`degradedErrorPercentage`、`outageErrorPercentage`，默认为 20、5、50。少于最低样本量时，至少 3 个有效请求全部失败也会触发异常。GitOps 继续管理目标、凭据及组件归属。

`availabilityPercentage` 统计正常和性能下降时长，兼容字段 `uptimePercentage` 仍统计完全正常时长。维护和未知时段不进入可用率分母，`coveragePercentage` 单列监测覆盖。新组件从上线后积累历史。

## 通过 GitOps 接入

在状态服务的监测清单中增加项目和服务。只配置只读健康检查，不能使用会触发同步、产生订单、发送消息或消耗用户额度的业务接口。

```json
{
  "groups": [
    { "id": "example", "name": "示例项目", "namespaces": ["example"] }
  ],
  "monitors": [
    {
      "id": "example-api",
      "group": "example",
      "name": "业务 API",
      "kind": "http",
      "target": "https://example.lazycampus.com/readyz",
      "publicUrl": "https://example.lazycampus.com",
      "public": true,
      "expectedCodes": [200],
      "contains": "ready",
      "intervalSeconds": 30,
      "failureThreshold": 3,
      "recoveryThreshold": 2,
      "dependencies": ["k8s:example:deployment:example-api"]
    }
  ]
}
```

此示例展示独立清单结构；修改生产清单时保留其他已有条目。HTTP 默认只接受 200，可以指定其他预期状态；不会跟随重定向。TCP 使用 `tcp://hostname:port`，只能表示端口可连接，不能代表业务可用。

集群发现的 ID 为 `k8s:<namespace>:<kind-lowercase>:<name>`。多容器工作负载还提供 `:<container-name>` 子项。发现项默认仅在管理端显示；公开项目应使用明确的服务名，关联内部工作负载作为辅助判断。

可选的工作负载 annotations：

| Annotation                               | 用途                                            |
| ---------------------------------------- | ----------------------------------------------- |
| `status.lazycampus.com/enabled: "false"` | 不纳入自动发现                                  |
| `status.lazycampus.com/name`             | 管理端显示名称                                  |
| `status.lazycampus.com/group`            | 分组 ID                                         |
| `status.lazycampus.com/public: "true"`   | 显式公开此发现项；默认不公开                    |
| `status.lazycampus.com/grace-seconds`    | CronJob 的完成宽限期，默认 1800 秒，最低 300 秒 |

这些 annotations 只由 Status Page 读取，其他项目忽略它们，移除状态服务不改变业务行为。

## 通过管理 API 接入

在 Keycloak 管理会话中创建 API 凭据，或使用部署时生成的引导凭据。应用只能持有执行所需的最小权限；不要把引导凭据交给业务应用。

```bash
curl --fail-with-body -X POST "$STATUS_ORIGIN/api/v1/admin/components" \
  -H "Authorization: Bearer $STATUS_COMPONENT_TOKEN" \
  -H 'Content-Type: application/json' \
  --data '{"id":"example-worker","name":"任务处理","group":"example","groupName":"示例项目","kind":"heartbeat","heartbeatSeconds":180,"public":true}'
```

随后由管理员签发仅授权 `example-worker` 的 `heartbeat:write` 凭据。

```bash
curl --fail-with-body --max-time 3 -X POST "$STATUS_ORIGIN/api/v1/heartbeats/example-worker" \
  -H "Authorization: Bearer $STATUS_HEARTBEAT_TOKEN" \
  -H 'Content-Type: application/json' \
  --data '{"status":"operational"}'
```

建议每分钟上报一次，并设置至少 3 分钟有效期。心跳只表示上报任务最近成功，不应放在业务必经请求中；网络失败写本地日志并继续原任务。凭据到期前通过管理 API 轮换，旧凭据可随时撤销。

## 可选状态提示

其他项目只需配置可选的 `STATUS_PAGE_URL` 或服务链接。未设置时隐藏链接，不报错，不请求状态 API；设置后也应独立加载，失败不阻断页面或登录。

公开 GET API 支持不携带凭据的跨域读取，也可由业务后端缓存转发 `/api/v1/summary`，或者仅提供状态页链接。状态服务不开放携带凭据的跨域请求，不能在浏览器中嵌入管理或心跳密钥。

## 排障

- 401：重新通过 Keycloak 登录；检查会话是否过期。
- 403：检查凭据权限、绑定的组件、请求 Origin 和管理角色。
- 409：重新读取组件或故障的 `version`，合并自己的修改后重试。
- 429：等待 `Retry-After`，不要不断重试。
- 目标不在白名单：在 GitOps 中修改 `STATUS_PROBE_HOSTS`；内部服务和非标准端口还需放行准确的出站 NetworkPolicy。
- 未知状态：检查最近探测时间、采集器运行时间、Kubernetes RBAC 和数据库状态。不要用人工正常状态掩盖无数据。

Kubernetes 依据参见官方 [Deployment 状态](https://kubernetes.io/docs/concepts/workloads/controllers/deployment/)、[CronJob 计划与时区](https://kubernetes.io/docs/concepts/workloads/controllers/cron-jobs/) 和 [RBAC](https://kubernetes.io/docs/reference/access-authn-authz/rbac/)。
