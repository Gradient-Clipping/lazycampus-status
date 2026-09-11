import assert from "node:assert/strict";
import test from "node:test";
import {
  interpretReport,
  publicEvidence,
  freshEvidence,
  dependencyResult,
} from "../server/evidence.mjs";
import { historyFor } from "../server/snapshot.mjs";
import { probe } from "../server/probes.mjs";
test("idle traffic, unknown evidence and independent health failures remain distinct", () => {
  const now = new Date("2026-09-12T00:00:00Z");
  const interpret = (item, policy = {}) =>
    interpretReport(
      JSON.stringify({
        version: 1,
        observedAt: now.toISOString(),
        components: { api: item },
      }),
      "api",
      now,
      100,
      policy,
    );
  const idle = {
    status: "operational",
    healthStatus: "operational",
    requests: 0,
    errors: 0,
  };
  assert.equal(interpret(idle).status, "operational");
  assert.equal(interpret(idle).evidence.successPercentage, undefined);
  assert.equal(
    publicEvidence({ ...idle, successPercentage: 100 }).successPercentage,
    undefined,
  );
  assert.equal(
    interpret({ status: "no_data", healthStatus: "operational" }).status,
    "no_data",
  );
  assert.equal(
    interpret({ ...idle, healthStatus: "invalid" }).status,
    "no_data",
  );
  const failure = {
    status: "partial_outage",
    healthStatus: "partial_outage",
    requests: 100,
    errors: 0,
    p95Ms: 10,
  };
  assert.equal(interpret(failure).status, "partial_outage");
  assert.equal(
    interpret({ ...failure, healthStatus: undefined }).status,
    "partial_outage",
  );
  assert.equal(
    interpret(
      { ...failure, healthStatus: "operational", errors: 10 },
      { degradedErrorPercentage: 20 },
    ).status,
    "operational",
  );
  assert.equal(
    interpret({ ...idle, requests: 20, errors: 20 }).status,
    "partial_outage",
  );
  assert.equal(
    freshEvidence(
      { ...idle, observedAt: new Date(+now - 101000).toISOString() },
      now,
    ),
    null,
  );
  assert.equal(
    freshEvidence(
      { ...idle, observedAt: new Date(+now + 31000).toISOString() },
      now,
    ),
    null,
  );
  assert.equal(
    freshEvidence({ ...idle, observedAt: now.toISOString() }, now).requests,
    0,
  );
});
test("probe credentials are never forwarded to a different URL", async () => {
  const result = await probe(
    {
      kind: "http",
      target: "https://example.test/",
      credentialRef: "internal",
      reportKey: "orders",
    },
    ["example.test"],
    new Date(),
    {
      credentials: {
        internal: {
          target: "http://app.ns.svc.cluster.local:3000/report",
          token: "test",
        },
      },
    },
  );
  assert.equal(result.status, "no_data");
});
test("report authorization failures are missing evidence rather than user outages", async () => {
  const target = "https://example.test/report";
  const cache = new Map([
    [
      target + ":false",
      Promise.resolve({ status: 401, body: "", headers: {} }),
    ],
  ]);
  cache.clear();
  cache.set(
    target + "::false",
    Promise.resolve({ status: 401, body: "", headers: {} }),
  );
  const result = await probe(
    { kind: "http", target, reportKey: "orders" },
    ["example.test"],
    new Date(),
    { cache },
  );
  assert.equal(result.status, "no_data");
});
test("reports require current versioned evidence and never publish private application fields", () => {
  const now = new Date("2026-09-11T12:00:00Z");
  const report = {
    version: 1,
    observedAt: now.toISOString(),
    components: {
      orders: {
        status: "operational",
        requests: 20,
        errors: 1,
        token: "secret",
        customer: "private",
      },
    },
  };
  const result = interpretReport(JSON.stringify(report), "orders", now);
  assert.deepEqual(result.evidence, {
    requests: 20,
    errors: 1,
    successPercentage: 95,
    observedAt: now.toISOString(),
  });
  assert.equal(
    interpretReport(JSON.stringify(report), "missing", now).status,
    "no_data",
  );
  assert.equal(
    interpretReport(JSON.stringify(report), "orders", new Date(+now + 101000))
      .status,
    "no_data",
  );
  assert.equal(interpretReport("{", "orders", now).status, "no_data");
  assert.equal(publicEvidence({ password: "secret" }), null);
});
test("optional mail outages do not make an unrelated API unavailable", () => {
  const byId = new Map([["mail", { status: "full_outage" }]]);
  const statusOf = (c) => c?.status || "no_data";
  assert.equal(
    dependencyResult({}, { status: "operational" }, byId, statusOf).status,
    "operational",
  );
  assert.equal(
    dependencyResult(
      { optionalDependencies: ["mail"] },
      { status: "operational" },
      byId,
      statusOf,
    ).status,
    "degraded_performance",
  );
  assert.equal(
    dependencyResult(
      { dependencies: ["mail"] },
      { status: "operational" },
      byId,
      statusOf,
    ).status,
    "partial_outage",
  );
});
test("availability separates slow service from outage without inventing past observations", () => {
  const result = historyFor(
    [
      { start: 0, end: 100, status: "operational" },
      { start: 100, end: 300, status: "degraded_performance" },
      { start: 300, end: 400, status: "full_outage" },
    ],
    [{ key: "2026-09-11", start: 0, end: 1000 }],
  );
  assert.equal(result.availabilityPercentage, "75.000");
  assert.equal(result.uptimePercentage, "25.000");
  assert.equal(result.coveragePercentage, 40);
});
