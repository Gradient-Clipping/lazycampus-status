# Lazy Campus Status

面向用户公开的服务状态页，提供按项目分组的实时状态、可展开的具体服务、90 天可用率、故障进展、维护计划和订阅。

- 公开页面：<https://status.lazycampus.com>
- 管理入口：<https://status.lazycampus.com/admin>，使用 Keycloak 统一登录。
- API 指南：<https://status.lazycampus.com/api-docs>
- OpenAPI：<https://status.lazycampus.com/openapi.json>

前端从原工作区 `platform/apps/status-page` 迁入，保留其布局、字体、状态色条和折叠动效；Logo 和圆形 favicon 与开放平台一致。后端为独立实现的 Node.js、Fastify、MySQL 服务，不依赖原平台的模块系统。

## 页面与监测范围

公开页面以核心项目为入口：Lazy Campus 主页、Smart Shop、Easy SWU 小程序、开放平台和统一登录。展开项目可以查看网站、业务 API、校园登录等服务，继续展开服务可查看最近检查时间、响应时间和故障进展。

重进页面时先读取同一设备时区下最近成功的公开快照，再静默刷新；状态与历史请求互不等待。缓存最多保留 24 小时，超过 100 秒的状态会注明正在确认及上次更新时间，网络失败保留已有服务详情。缓存不保存管理数据，存储被禁用时仍可正常读取在线状态。各项目独立处理展开状态，后台更新不会收起正在查看的服务。

Kubernetes 工作负载、节点、容器、定时任务和存储卷仅作为内部监测依据，默认不会出现在公开 API 中。公开响应不返回内部探测地址、命名空间、镜像、凭据或原始诊断。管理员可以查看探测明细和操作审计。

## 接入方式

业务应用无需依赖本服务，也不需要安装 SDK、增加启动检查或调用 Status Page 的接口。默认使用单向拉取：Status Page 读取健康检查和 Kubernetes 状态。

1. **集群应用**：在 GitOps 的 `clusters/easy-platform/apps/status-page/monitors.json` 中添加分组及监测项。配置通过 ConfigMap 挂载，由 GitOps 更新；业务仓库无需改动。
2. **HTTP / TCP 服务**：管理员可通过管理页面或 `POST /api/v1/admin/components` 注册。目标域名必须在 `STATUS_PROBE_HOSTS` 白名单内；非标准端口还需在 GitOps 中配置出站 NetworkPolicy。
3. **心跳任务**：创建 `heartbeat` 组件并签发绑定该组件的 `heartbeat:write` 凭据。通过 `POST /api/v1/heartbeats/{id}` 上报 `{"status":"operational"}`；超时自动进入异常判断。
4. **可选状态提示**：其他网站可读取 `/api/v1/summary`。建议 3 秒超时、至少 30 秒轮询，失败时隐藏提示或显示未知；不得阻断业务流程。

完整的接入配置与示例见 [接入规范](docs/integration.md)。删除 Status Page 的部署不会影响其他业务的启动、鉴权或请求处理。

## 状态判定

- 默认每 30 秒检查一次，最多 4 个并发网络探测。连续 3 次失败确认异常，连续 2 次成功确认恢复；各组件可独立设置周期、超时、阈值和心跳有效期。
- 慢响应汇总为黄色“性能下降”；仅当组件不可用时汇总为部分异常或服务中断。黄色和红色状态使用感叹号，正常状态使用勾选图标。
- 工作负载按实际就绪副本判定，不能仅凭对象存在报正常。定时任务读取计划、时区、最近成功时间及失败 Job，并检查逾期。
- 监测器使用 MySQL 命名锁，避免发布期间双实例重复探测；邮件队列使用独立锁和工作循环，不延迟状态采集。
- 超过有效期的观测显示 `no_data`。新服务和监测中断不会被补造为 100% 可用。
- 公开可用率使用 `availabilityPercentage`，性能下降仍计为可用；兼容字段 `uptimePercentage` 保留完全正常运行比例。维护和未知不进入可用率分母，覆盖率独立显示。业务组件还展示最近 5 分钟的请求量、成功率、限流次数及 P95 耗时。历史来自真实观测，不补造记录。
- API 日期按请求的 IANA 时区划分，默认 UTC；时间戳采用 RFC 3339 UTC，前端按设备时区显示。
- MySQL 暂时不可达时，已运行实例继续提供内存中的最近快照并标记过期；不会因为数据库错误将旧状态持续显示为正常。

## 管理、API 与订阅

管理页支持公开/隐藏、暂停/恢复监测、运行时阈值、新增组件、故障及维护发布、接入凭据与审计。GitOps 管理目标和凭据，后台可覆盖间隔、超时、确认次数及耗时阈值。修改使用 `version` 处理并发冲突。相同项目异常合并，事件发布支持幂等重放，详见 [运行手册](docs/operations.md)。

管理员必须同时匹配 `OIDC_ADMIN_USERNAME`（生产为 `ystemsrx`）和 `OIDC_ADMIN_ROLE`（`platform-admin`）。不提供本地账号或密码登录。OIDC 使用授权码、PKCE、state、nonce 和服务端短期会话，并支持 Keycloak 后通道注销。

API 凭据使用 SHA-256 摘要保存，签发时只显示一次，必须设置期限；心跳权限绑定具体组件。HTTP 探测不跟随重定向，不接受 URL 凭据，校验目标白名单与解析后的 IP，禁止访问回环和云元数据地址。

公开 API 每 IP 每分钟 120 次；心跳每组件每分钟 6 次。邮件验证每 IP 每小时 3 次、每邮箱每分钟 1 次且每天 6 次，全局每天 100 次；验证码校验每邮箱与 IP 每 10 分钟各 5 次。超限返回 429 与 `Retry-After`。敏感操作的计数持久化于 MySQL。

提供可匿名读取的 RSS 2.0 / Atom 1.0 订阅，每次公开故障或维护进展生成独立、稳定的条目标识，保留最近 50 条更新。首页包含订阅地址自动发现标记，可直接将 `/feed.rss` 或 `/feed.atom` 添加到阅读器；私有和已归档服务不会出现在订阅内容中。

邮件使用 Sender 事务邮件，必须验证邮箱后才启用，支持按服务订阅及退订。故障与维护更新经持久队列发送，全局每天最多 500 封；明确的 429/5xx 最多尝试 5 次，网络结果不确定时记录为 `uncertain`，避免盲目重复发送。未配置 Sender 时公开页面保留 RSS，邮件选项禁用。

## 本地开发与验证

需要 Node.js 22、MySQL 8.4 和 Docker（运行集成测试时使用）。

```bash
npm ci
npm run build
# 配置 .env.example 中的环境变量，使用自己的随机 STATUS_ADMIN_TOKEN。
node --env-file=.env server/main.mjs
```

前端开发使用 `npm run dev`，Vite 代理到本机 3100 端口。开发时将 `STATUS_ORIGIN` 设置为实际前端地址，保证 OIDC 回调及来源校验一致。

```bash
npm run check
docker compose -f compose.test.yml up -d --wait
STATUS_TEST_MYSQL=1 npm test
npm run test:ui
npm run build
docker compose -f compose.test.yml down --volumes
```

集成测试仅连接独立的 `status_test` 数据库，邮件使用测试替身，不发送真实邮件。覆盖状态机、时区与 DST、统计、权限隔离、并发编辑、凭据撤销、限流、邮件验证、故障进展和存储故障。

## 部署与运维

GitHub Actions 检查后发布 `ccr.ccs.tencentyun.com/lazycampus/lazycampus-status:1.0.<run-number>`；共享 Flux Image Automation 更新 `server-gitops/main`，再部署到 `status-page` 命名空间。源码仓库不存放生产探测清单或密钥。

GitOps 包含 Namespace、Deployment、Service、Ingress、只读 RBAC、NetworkPolicy、监测清单、Keycloak 客户端、镜像策略、GitHub webhook、Nginx 和 EdgeOne 规则。初始化和恢复通过版本化的 `scripts/bootstrap-status-page.sh` 完成。

Dockerfile 固定运行时摘要。若首次发布的大基础层跨境上传停滞，可从本仓库的已提交版本在部署主机执行 `bash scripts/mirror-runtime.sh`，将同一基础镜像预先同步到 TCR；凭据读取服务器既有的根目录只读文件，不打印到日志。该脚本仅发布 `base-node22-20260911` 标签，Flux 的应用版本策略不会选中它；应用发布仍由 GitHub Actions 检查、构建和推送。

生产使用独立 MySQL 数据库/账号 `lazycampus_status`，沿用集群 MySQL 备份。最近探测明细保留 7 天，历史区间保留 100 天，管理审计保留 90 天，已完成邮件投递保留 30 天。故障与维护记录保留在数据库，公开页展示最近 90 天。

`/healthz` 检查进程；`/readyz` 检查是否建立快照并返回实际提交 SHA。管理 API 提供监测器最近运行时间、集群发现时间、消息投递计数及 Prometheus 格式指标。

当前部署与业务同处单节点集群，宿主机、网络或整个集群不可达时，状态页本身也可能不可访问。若需覆盖整站失联，应把独立外部探测器或状态页部署到另一故障域；本项目支持脱离 Kubernetes，仅运行 HTTP/TCP/心跳监测。
