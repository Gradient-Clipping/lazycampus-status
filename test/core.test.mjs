import assert from "node:assert/strict";
import test from "node:test";
import { nextState, effectiveStatus } from "../server/status.mjs";
import {
  aggregateStatus,
  combinePeriods,
  historyFor,
  midnight,
} from "../server/snapshot.mjs";
import { workloadResult, discover } from "../server/kubernetes.mjs";
import { safeAddress, validateTarget } from "../server/probes.mjs";
import { authorizedIdentity } from "../server/auth.mjs";
test("failure and recovery thresholds suppress flapping and stale checks never stay green", () => {
  const now = new Date("2026-09-11T08:00:00Z");
  let previous = {
    status: "operational",
    rawStatus: "operational",
    streak: 8,
    checkedAt: now.toISOString(),
  };
  for (let index = 1; index <= 3; index++) {
    const at = new Date(+now + index * 30000);
    const next = nextState(previous, { status: "full_outage" }, at);
    assert.equal(next.status, index < 3 ? "operational" : "full_outage");
    previous = {
      ...previous,
      ...next,
      rawStatus: "full_outage",
      checkedAt: at.toISOString(),
    };
  }
  let state = nextState(
    previous,
    { status: "operational" },
    new Date(+now + 120000),
  );
  assert.equal(state.status, "full_outage");
  previous = {
    ...previous,
    ...state,
    rawStatus: "operational",
    checkedAt: new Date(+now + 120000).toISOString(),
  };
  state = nextState(
    previous,
    { status: "operational" },
    new Date(+now + 150000),
  );
  assert.equal(state.status, "operational");
  assert.equal(
    effectiveStatus(
      { ...previous, status: "operational" },
      new Date(+now + 500000),
    ),
    "no_data",
  );
  assert.equal(
    nextState(
      { ...previous, status: "operational" },
      { status: "full_outage" },
      new Date(+now + 500000),
    ).status,
    "no_data",
  );
});
test("unknown and maintenance do not inflate uptime; a group uses every component", () => {
  const periods = [
    { start: 0, end: 500, status: "operational" },
    { start: 500, end: 700, status: "full_outage" },
    { start: 700, end: 900, status: "maintenance" },
  ];
  const result = historyFor(periods, [
    { key: "2026-01-01", start: 0, end: 1000 },
  ]);
  assert.equal(result.uptimePercentage, "71.429");
  assert.equal(result.history[0].coveragePercentage, 90);
  assert.equal(
    historyFor([], [{ key: "2026-01-01", start: 0, end: 1000 }])
      .uptimePercentage,
    null,
  );
  const combined = combinePeriods([
    [{ start: 0, end: 100, status: "operational" }],
    [{ start: 0, end: 100, status: "full_outage" }],
  ]);
  assert.equal(combined[0].status, "partial_outage");
  assert.equal(aggregateStatus(["operational", "no_data"]), "no_data");
  const partialDay = historyFor(
    [
      { start: 0, end: 100, status: "no_data" },
      { start: 100, end: 400, status: "operational" },
    ],
    [{ key: "2026-01-01", start: 0, end: 1000 }],
  );
  assert.equal(partialDay.history[0].status, "operational");
  assert.equal(partialDay.history[0].coveragePercentage, 30);
  assert.equal(partialDay.uptimePercentage, "100.000");
});
test("daily boundaries respect DST and user timezone", () => {
  assert.equal(
    midnight("2026-03-09", "America/New_York") -
      midnight("2026-03-08", "America/New_York"),
    23 * 3600000,
  );
  assert.equal(
    new Date(midnight("2026-09-11", "Asia/Shanghai")).toISOString(),
    "2026-09-10T16:00:00.000Z",
  );
});

test("slow responses remain degraded while only unavailable services produce outage summaries", () => {
  assert.equal(
    aggregateStatus(["operational", "degraded_performance"]),
    "degraded_performance",
  );
  assert.equal(
    aggregateStatus(["degraded_performance", "degraded_performance"]),
    "degraded_performance",
  );
  assert.equal(
    aggregateStatus(["full_outage", "degraded_performance"]),
    "partial_outage",
  );
  assert.equal(aggregateStatus(["full_outage", "full_outage"]), "full_outage");
  assert.equal(aggregateStatus(["partial_outage"]), "partial_outage");
  assert.equal(aggregateStatus(["operational", "no_data"]), "no_data");
  const combined = combinePeriods([
    [{ start: 0, end: 100, status: "operational" }],
    [{ start: 0, end: 100, status: "degraded_performance" }],
  ]);
  assert.equal(combined[0].status, "degraded_performance");
});
test("workloads, cron failures and overdue schedules reflect health rather than existence", () => {
  assert.equal(
    workloadResult({
      kind: "Deployment",
      spec: { replicas: 2 },
      metadata: { generation: 2 },
      status: { readyReplicas: 1, observedGeneration: 2 },
    }).status,
    "partial_outage",
  );
  assert.equal(
    workloadResult({ kind: "Deployment", spec: { replicas: 0 } }).status,
    "maintenance",
  );
  const cron = {
    kind: "CronJob",
    metadata: { uid: "job-owner", creationTimestamp: "2026-09-01T00:00:00Z" },
    spec: { schedule: "0 * * * *", timeZone: "Asia/Shanghai" },
    status: { lastSuccessfulTime: "2026-09-11T07:01:00Z" },
  };
  assert.equal(
    workloadResult(cron, new Date("2026-09-11T08:20:00Z")).status,
    "operational",
  );
  assert.equal(
    workloadResult(cron, new Date("2026-09-11T08:40:00Z")).status,
    "full_outage",
  );
  assert.equal(
    workloadResult(cron, new Date("2026-09-11T08:05:00Z"), [
      {
        metadata: {
          creationTimestamp: "2026-09-11T08:00:00Z",
          ownerReferences: [{ uid: "job-owner" }],
        },
        status: { conditions: [{ type: "Failed", status: "True" }] },
      },
    ]).status,
    "full_outage",
  );
  assert.equal(
    workloadResult({
      kind: "Node",
      status: {
        conditions: [
          { type: "Ready", status: "True" },
          { type: "DiskPressure", status: "True" },
        ],
      },
    }).status,
    "degraded_performance",
  );
});
test("Kubernetes inventory is private by default and sidecars are independently observable", () => {
  const workload = {
    kind: "Deployment",
    metadata: { namespace: "example", name: "api" },
    spec: {
      replicas: 1,
      selector: { matchLabels: { app: "api" } },
      template: { spec: { containers: [{ name: "api" }, { name: "tunnel" }] } },
    },
    status: { readyReplicas: 1 },
  };
  const pod = {
    kind: "Pod",
    metadata: { namespace: "example", labels: { app: "api" } },
    status: {
      containerStatuses: [
        { name: "api", ready: true },
        { name: "tunnel", ready: false },
      ],
    },
  };
  const results = discover([workload, pod]);
  assert.equal(results.length, 3);
  assert(results.every((r) => r.component.public === false));
  assert.equal(results.at(-1).result.status, "full_outage");
});
test("probes reject unapproved hosts, credentials, loopback and cloud metadata", () => {
  for (const address of [
    "127.0.0.1",
    "169.254.169.254",
    "100.100.100.200",
    "::1",
    "::ffff:127.0.0.1",
    "fe80::1",
    "10.0.0.1",
  ])
    assert.equal(safeAddress(address), false, address);
  assert.equal(safeAddress("10.43.2.3", true), true);
  assert.equal(safeAddress("169.254.169.254", true), false);
  assert.throws(() =>
    validateTarget(
      { kind: "http", target: "http://user:password@example.com" },
      ["example.com"],
    ),
  );
  assert.throws(() =>
    validateTarget({ kind: "http", target: "https://attacker.com" }, [
      "example.com",
    ]),
  );
  assert.throws(() =>
    validateTarget({ kind: "tcp", target: "tcp://example.com:443/private" }, [
      "example.com",
    ]),
  );
  assert.doesNotThrow(() =>
    validateTarget({ kind: "http", target: "https://example.com/health" }, [
      "example.com",
    ]),
  );
});
test("admin identity requires both the named administrator and its Keycloak role", () => {
  const config = { adminUsername: "ystemsrx", adminRole: "platform-admin" };
  assert.throws(() =>
    authorizedIdentity(
      {
        sub: "x",
        preferred_username: "someone",
        realm_access: { roles: ["platform-admin"] },
      },
      config,
    ),
  );
  assert.throws(() =>
    authorizedIdentity(
      { sub: "x", preferred_username: "ystemsrx", realm_access: { roles: [] } },
      config,
    ),
  );
  assert.equal(
    authorizedIdentity(
      {
        sub: "x",
        preferred_username: "ystemsrx",
        exp: 9999999999,
        realm_access: { roles: ["platform-admin"] },
      },
      config,
    ).username,
    "ystemsrx",
  );
});
