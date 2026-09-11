import assert from "node:assert/strict";
import test from "node:test";
import { randomInt, randomUUID } from "node:crypto";
import { Store, hash } from "../server/store.mjs";
import { settings } from "../server/config.mjs";
import { createApp } from "../server/app.mjs";
import {
  recordObservation,
  reconcileGroupedIncidents,
} from "../server/status.mjs";
test(
  "MySQL-backed monitoring, scoped API, incident lifecycle and verified subscriptions",
  { skip: process.env.STATUS_TEST_MYSQL !== "1" },
  async (t) => {
    const config = settings({
      ...process.env,
      MYSQL_HOST: "127.0.0.1",
      MYSQL_PORT: process.env.STATUS_TEST_MYSQL_PORT || "3311",
      MYSQL_DATABASE: "status_test",
      MYSQL_USER: "status_test",
      MYSQL_PASSWORD: "local-test-only-password",
      STATUS_ADMIN_TOKEN: "local-test-only-random-credential-0123456789",
      SENDER_API_KEY: "test-no-network",
      SENDER_FROM_EMAIL: "status@example.test",
    });
    const store = new Store(config.db);
    await store.init();
    const emails = [];
    const app = await createApp({
      store,
      config,
      logging: false,
      sendEmail: async (_config, to, subject, text) => {
        emails.push({ to, subject, text });
        return { ok: true };
      },
    });
    await app.ready();
    const prefix = "test-" + randomUUID().slice(0, 8),
      id = prefix + "-web",
      hidden = prefix + "-private",
      heartbeat = prefix + "-heartbeat";
    const headers = { authorization: "Bearer " + config.adminToken };
    const remoteAddress = "192.0.2." + randomInt(1, 255);
    const inject = (method, url, payload, extra = headers) =>
      app.inject({ method, url, payload, headers: extra, remoteAddress });
    try {
      await t.test(
        "public has no admin access and unknown request fields are rejected",
        async () => {
          assert.equal(
            (await inject("GET", "/api/v1/admin/overview", undefined, {}))
              .statusCode,
            401,
          );
          assert.equal(
            (
              await inject("POST", "/api/v1/admin/components", {
                id,
                name: "test",
                group: "tests",
                kind: "heartbeat",
                unknown: true,
              })
            ).statusCode,
            400,
          );
        },
      );
      await t.test(
        "public data cannot reveal private targets or Kubernetes inventory",
        async () => {
          for (const [key, isPublic] of [
            [id, true],
            [hidden, false],
            [heartbeat, false],
          ]) {
            const response = await inject("POST", "/api/v1/admin/components", {
              id: key,
              name: key === hidden ? "PRIVATE_INTERNAL_NAME" : "测试服务",
              group: prefix,
              kind: "heartbeat",
              public: isPublic,
            });
            assert.equal(response.statusCode, 201, response.body);
          }
          await app.snapshots.refresh();
          const snapshot = await inject("GET", "/api/v1/status");
          assert.equal(snapshot.statusCode, 200);
          assert(!snapshot.body.includes("PRIVATE_INTERNAL_NAME"));
          assert(!snapshot.body.includes("target"));
          assert.equal(
            (await inject("GET", "/api/v1/components/" + hidden, undefined, {}))
              .statusCode,
            404,
          );
        },
      );
      await t.test(
        "optimistic concurrency, CSRF and component-scoped heartbeats are enforced",
        async () => {
          const response = await inject(
            "PATCH",
            "/api/v1/admin/components/" + id,
            { version: 1, description: "updated" },
          );
          assert.equal(response.statusCode, 200, response.body);
          assert.equal(
            (
              await inject("PATCH", "/api/v1/admin/components/" + id, {
                version: 1,
                description: "lost edit",
              })
            ).statusCode,
            409,
          );
          const token = await inject("POST", "/api/v1/admin/tokens", {
            name: prefix,
            scopes: ["heartbeat:write"],
            componentIds: [heartbeat],
            expiresDays: 1,
          });
          assert.equal(token.statusCode, 201, token.body);
          const credential = token.json(),
            limited = { authorization: "Bearer " + credential.token };
          assert.equal(
            (
              await inject(
                "POST",
                "/api/v1/heartbeats/" + id,
                { status: "operational" },
                limited,
              )
            ).statusCode,
            403,
          );
          assert.equal(
            (
              await inject(
                "POST",
                "/api/v1/heartbeats/" + heartbeat,
                { status: "operational" },
                limited,
              )
            ).statusCode,
            200,
          );
          assert.equal(
            (
              await inject(
                "POST",
                "/api/v1/admin/components",
                { id: "evil", name: "evil", group: "tests", kind: "heartbeat" },
                limited,
              )
            ).statusCode,
            403,
          );
          for (let i = 0; i < 5; i++)
            assert.equal(
              (
                await inject(
                  "POST",
                  "/api/v1/heartbeats/" + heartbeat,
                  { status: "operational" },
                  limited,
                )
              ).statusCode,
              200,
            );
          const limit = await inject(
            "POST",
            "/api/v1/heartbeats/" + heartbeat,
            { status: "operational" },
            limited,
          );
          assert.equal(limit.statusCode, 429);
          assert(+limit.headers["retry-after"] > 0);
          await inject("DELETE", "/api/v1/admin/tokens/" + credential.id);
          assert.equal(
            (
              await inject(
                "POST",
                "/api/v1/heartbeats/" + heartbeat,
                { status: "operational" },
                limited,
              )
            ).statusCode,
            403,
          );
          const cookie = "test-session-" + randomUUID();
          await store.query(
            "INSERT INTO sessions (hash,payload,expires_at) VALUES (?,?,DATE_ADD(UTC_TIMESTAMP(3),INTERVAL 5 MINUTE))",
            [
              hash(cookie),
              JSON.stringify({ kind: "admin", username: "ystemsrx" }),
            ],
          );
          assert.equal(
            (
              await inject(
                "PATCH",
                "/api/v1/admin/components/" + id,
                { version: 2, paused: true },
                {
                  cookie: "status_session=" + cookie,
                  origin: "https://attacker.test",
                },
              )
            ).statusCode,
            403,
          );
          await store.query("DELETE FROM sessions WHERE hash=?", [
            hash(cookie),
          ]);
        },
      );
      await t.test(
        "automatic incident opens once, recovers after two successes and history has gaps",
        async () => {
          const base = Date.now() - 600000;
          for (const [offset, status] of [
            [0, "operational"],
            [30, "operational"],
            [60, "full_outage"],
            [90, "full_outage"],
            [120, "full_outage"],
            [150, "full_outage"],
            [180, "operational"],
          ])
            await recordObservation(
              store,
              id,
              { status, reason: "test" },
              new Date(base + offset * 1000),
            );
          let rows = await store.query(
            "SELECT * FROM incidents WHERE automatic_key=?",
            [id],
          );
          assert.equal(rows.length, 1);
          const incidentId = rows[0].id;
          await recordObservation(
            store,
            id,
            { status: "operational", reason: "test" },
            new Date(base + 210000),
          );
          rows = await store.query("SELECT phase FROM incidents WHERE id=?", [
            incidentId,
          ]);
          assert.equal(rows[0].phase, "resolved");
          await recordObservation(
            store,
            id,
            { status: "operational" },
            new Date(base + 480000),
          );
          const periods = await store.query(
            "SELECT * FROM periods WHERE component_id=? ORDER BY started_at",
            [id],
          );
          assert.equal(periods.length, 4);
          await app.snapshots.refresh();
          const snapshot = app.snapshots.snapshot();
          const service = snapshot.groups
            .flatMap((g) => g.components)
            .find((c) => c.id === id);
          assert.equal(service.status, "no_data");
          assert(service.history.some((day) => day.status === "no_data"));
          assert.notEqual(service.uptimePercentage, "100.000");
        },
      );
      await t.test(
        "manual incidents validate lifecycle and render safely in feeds",
        async () => {
          const incident = await inject("POST", "/api/v1/admin/incidents", {
            title: "<script> & 测试",
            message: "测试更新",
            componentIds: [id],
            severity: "partial_outage",
          });
          assert.equal(incident.statusCode, 201, incident.body);
          const identifier = incident.json().id;
          await store.query(
            "UPDATE incidents SET started_at=DATE_SUB(UTC_TIMESTAMP(),INTERVAL 120 DAY),component_ids=? WHERE id=?",
            [JSON.stringify([id, hidden]), identifier],
          );
          await app.snapshots.refresh();
          const longstanding = await inject(
            "GET",
            "/api/v1/incidents/" + identifier,
            undefined,
            {},
          );
          assert.equal(longstanding.statusCode, 200);
          assert.deepEqual(longstanding.json().componentIds, [id]);
          assert.equal(
            (
              await inject(
                "POST",
                "/api/v1/admin/incidents/" + identifier + "/updates",
                { version: 1, phase: "completed", message: "bad" },
              )
            ).statusCode,
            400,
          );
          assert.equal(
            (
              await inject(
                "POST",
                "/api/v1/admin/incidents/" + identifier + "/updates",
                { version: 1, phase: "resolved", message: "已恢复" },
              )
            ).statusCode,
            200,
          );
          const feed = await inject("GET", "/feed.atom");
          assert(feed.body.includes("&lt;script&gt; &amp;"));
          assert(!feed.body.includes("<script>"));
          assert(feed.body.includes("<updated>"));
          assert(feed.body.includes("已恢复"));
          assert(feed.body.includes(identifier));
          const incidentDetail = await inject(
            "GET",
            "/api/v1/incidents/" + identifier,
            undefined,
            {},
          );
          assert.equal(incidentDetail.statusCode, 200);
          assert.equal(incidentDetail.json().updates.length, 2);
        },
      );
      await t.test(
        "email subscriptions require verification and rate limit both issuance and guesses",
        async () => {
          const email = prefix + "@example.test";
          const response = await inject(
            "POST",
            "/api/v1/subscriptions",
            { email, componentIds: [id] },
            {},
          );
          assert.equal(response.statusCode, 202, response.body);
          let [row] = await store.query(
            "SELECT * FROM subscriptions WHERE email=?",
            [email],
          );
          assert.equal(row.active, 0);
          assert.equal(
            (await inject("POST", "/api/v1/subscriptions", { email }, {}))
              .statusCode,
            429,
          );
          const code = emails.at(-1).text.match(/\b\d{6}\b/)[0];
          assert.equal(
            (
              await inject(
                "POST",
                "/api/v1/subscriptions/confirm",
                { email, code: "000000" },
                {},
              )
            ).statusCode,
            400,
          );
          assert.equal(
            (
              await inject(
                "POST",
                "/api/v1/subscriptions/confirm",
                { email, code },
                {},
              )
            ).statusCode,
            200,
          );
          [row] = await store.query(
            "SELECT * FROM subscriptions WHERE email=?",
            [email],
          );
          assert.equal(row.active, 1);
          assert.equal(
            (
              await inject(
                "POST",
                "/api/v1/subscriptions/confirm",
                { email, code },
                {},
              )
            ).statusCode,
            400,
          );
        },
      );
      await t.test(
        "monitor locking prevents concurrent owners and snapshots survive storage loss as stale",
        async () => {
          let release;
          const gate = new Promise((resolve) => {
            release = resolve;
          });
          let acquired;
          const first = store.locked("test-lock-" + prefix, async () => {
            acquired = true;
            await gate;
          });
          for (let index = 0; !acquired && index < 100; index++)
            await new Promise((resolve) => setTimeout(resolve, 5));
          assert.equal(acquired, true, "first owner must acquire MySQL lock");
          assert.equal(
            await store.locked("test-lock-" + prefix, async () =>
              assert.fail("second owner"),
            ),
            false,
          );
          release();
          await first;
          await app.monitor.cycle();
          assert(app.monitor.lastRun, "real monitor cycle must complete");
          const publicResponse = await inject(
            "GET",
            "/api/v1/summary",
            undefined,
            {},
          );
          assert.equal(
            publicResponse.headers["access-control-allow-origin"],
            "*",
          );
          assert.equal(
            (await inject("GET", "/api/v1/admin/me")).headers[
              "access-control-allow-origin"
            ],
            undefined,
          );
          assert.equal(
            (
              await inject(
                "GET",
                "/api/v1/status?timeZone=invalid-zone",
                undefined,
                {},
              )
            ).statusCode,
            400,
          );
          const spec = (
            await inject("GET", "/openapi.json", undefined, {})
          ).json();
          assert.equal(spec.openapi, "3.0.3");
          assert(
            spec.paths["/api/v1/status"].get.responses["200"].content[
              "application/json"
            ].schema,
          );
          const previous = store.components;
          store.components = async () => {
            throw new Error("unavailable");
          };
          await app.snapshots.refresh();
          store.components = previous;
          assert.equal(app.snapshots.snapshot().stale, true);
          assert.equal(
            (await inject("GET", "/readyz", undefined, {})).statusCode,
            200,
          );
        },
      );
      await t.test(
        "incident publication is idempotent and rejects conflicting replay",
        async () => {
          const body = {
            title: "Idempotent incident",
            message: "Test update",
            componentIds: [id],
            severity: "partial_outage",
          };
          const keyed = { ...headers, "idempotency-key": prefix + "-event" };
          const first = await inject(
            "POST",
            "/api/v1/admin/incidents",
            body,
            keyed,
          );
          const second = await inject(
            "POST",
            "/api/v1/admin/incidents",
            body,
            keyed,
          );
          assert.equal(first.statusCode, 201);
          assert.deepEqual(second.json(), first.json());
          const conflict = await inject(
            "POST",
            "/api/v1/admin/incidents",
            { ...body, message: "different" },
            keyed,
          );
          assert.equal(conflict.statusCode, 409);
          const [count] = await store.query(
            "SELECT COUNT(*) n FROM incident_updates WHERE incident_id=?",
            [first.json().id],
          );
          assert.equal(Number(count.n), 1);
        },
      );
      await t.test(
        "related failures share one incident and missing evidence never resolves it",
        async () => {
          const ids = [prefix + "-group-a", prefix + "-group-b"];
          const at = new Date();
          for (const key of ids) {
            await store.upsert(
              {
                id: key,
                name: key,
                group: prefix,
                incidentGroup: prefix,
                public: true,
                kind: "heartbeat",
                failureThreshold: 1,
                recoveryThreshold: 1,
              },
              "manual",
            );
            await recordObservation(store, key, { status: "full_outage" }, at);
          }
          await reconcileGroupedIncidents(store, at);
          await reconcileGroupedIncidents(store, at);
          const rows = await store.query(
            "SELECT * FROM incidents WHERE automatic_key=?",
            ["group:" + prefix],
          );
          assert.equal(rows.length, 1);
          assert.deepEqual(
            typeof rows[0].component_ids === "string"
              ? JSON.parse(rows[0].component_ids)
              : rows[0].component_ids,
            ids,
          );
          await recordObservation(store, ids[0], { status: "operational" }, at);
          await recordObservation(store, ids[1], { status: "no_data" }, at);
          await reconcileGroupedIncidents(store, at);
          assert.equal(
            (
              await store.query("SELECT phase FROM incidents WHERE id=?", [
                rows[0].id,
              ])
            )[0].phase,
            "investigating",
          );
          await recordObservation(store, ids[1], { status: "operational" }, at);
          await reconcileGroupedIncidents(store, at);
          assert.equal(
            (
              await store.query("SELECT phase FROM incidents WHERE id=?", [
                rows[0].id,
              ])
            )[0].phase,
            "resolved",
          );
          await store.query(
            "DELETE FROM incident_updates WHERE incident_id=?",
            [rows[0].id],
          );
          await store.query("DELETE FROM incidents WHERE id=?", [rows[0].id]);
        },
      );
    } finally {
      const incidents = await store.query(
        "SELECT id FROM incidents WHERE JSON_CONTAINS(component_ids,JSON_QUOTE(?))",
        [id],
      );
      for (const row of incidents)
        await store.query("DELETE FROM incident_updates WHERE incident_id=?", [
          row.id,
        ]);
      await store.query(
        "DELETE FROM incidents WHERE JSON_CONTAINS(component_ids,JSON_QUOTE(?))",
        [id],
      );
      for (const table of ["observations", "periods"])
        await store.query(`DELETE FROM ${table} WHERE component_id LIKE ?`, [
          prefix + "%",
        ]);
      await store.query("DELETE FROM components WHERE id LIKE ?", [
        prefix + "%",
      ]);
      await store.query("DELETE FROM api_tokens WHERE name=?", [prefix]);
      await store.query("DELETE FROM subscriptions WHERE email=?", [
        prefix + "@example.test",
      ]);
      await app.close();
      await store.close();
    }
  },
);
