import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { Store } from "../server/store.mjs";
import { settings } from "../server/config.mjs";
import { recordObservations } from "../server/status.mjs";

test(
  "batched monitoring preserves overrides, freshness, history and atomic rollback",
  { skip: process.env.STATUS_TEST_MYSQL !== "1" },
  async (t) => {
    const config = settings({
      MYSQL_HOST: "127.0.0.1",
      MYSQL_PORT: process.env.STATUS_TEST_MYSQL_PORT || "3311",
      MYSQL_DATABASE: "status_test",
      MYSQL_USER: "status_test",
      MYSQL_PASSWORD: "local-test-only-password",
    });
    const store = new Store(config.db);
    await store.init();
    const prefix = "batch-" + randomUUID().slice(0, 8);
    const start = new Date("2026-09-12T00:00:00Z");
    const specs = Array.from({ length: 53 }, (_, index) => ({
      id: `${prefix}-${String(index).padStart(3, "0")}`,
      name: "Batched component " + index,
      group: prefix,
      incidentGroup: prefix,
      kind: "kubernetes",
      public: false,
    }));
    const first = specs[0].id;
    try {
      await t.test("unchanged JSON definitions are not rewritten", async () => {
        assert.equal(await store.upsertMany(specs, "kubernetes", start), 53);
        const reordered = specs.map((spec) =>
          Object.fromEntries(Object.entries(spec).reverse()),
        );
        assert.equal(
          await store.upsertMany(
            reordered,
            "kubernetes",
            new Date(+start + 30000),
          ),
          0,
        );
        assert.equal(
          (await store.component(first)).lastSeen,
          start.toISOString(),
        );
        await store.query("UPDATE components SET overrides=? WHERE id=?", [
          JSON.stringify({ name: "Administrator override", paused: true }),
          first,
        ]);
        assert.equal(
          await store.upsertMany(
            [{ ...specs[0], description: "changed" }],
            "kubernetes",
            start,
          ),
          1,
        );
        const current = await store.component(first);
        assert.equal(current.name, "Administrator override");
        assert.equal(current.paused, true);
        assert.equal(
          await store.upsertMany(
            [{ ...specs[0], name: "Wrong owner" }],
            "config",
            start,
          ),
          0,
        );
        assert.equal((await store.component(first)).source, "kubernetes");
        await store.query("UPDATE components SET overrides='{}' WHERE id=?", [
          first,
        ]);
      });
      await t.test(
        "normal cycles retain every observation with far fewer commits",
        async () => {
          let transactions = 0;
          const original = store.transaction.bind(store);
          store.transaction = (fn) => {
            transactions++;
            return original(fn);
          };
          const observations = specs.map(({ id }) => ({
            id,
            result: { status: "operational" },
            now: new Date(+start + 30000),
            seen: true,
          }));
          await recordObservations(store, observations);
          assert(
            transactions < specs.length / 5,
            "commit count must fall by at least 80%",
          );
          const [row] = await store.query(
            "SELECT COUNT(*) AS count FROM observations WHERE component_id IN (?)",
            [specs.map(({ id }) => id)],
          );
          assert.equal(Number(row.count), 53);
          assert.equal(
            (await store.component(first)).lastSeen,
            observations[0].now.toISOString(),
          );
          for (const offset of [60, 90, 120]) {
            await recordObservations(
              store,
              specs.map(({ id }) => ({
                id,
                result: {
                  status: "full_outage",
                  reason: "Upstream unavailable",
                },
                now: new Date(+start + offset * 1000),
                seen: true,
              })),
            );
          }
          assert.equal((await store.component(first)).status, "full_outage");
          for (const offset of [150, 180]) {
            await recordObservations(
              store,
              specs.map(({ id }) => ({
                id,
                result: { status: "operational" },
                now: new Date(+start + offset * 1000),
                seen: true,
              })),
            );
          }
          assert.equal((await store.component(first)).status, "operational");
          const periods = await store.query(
            "SELECT status FROM periods WHERE component_id=? ORDER BY id",
            [first],
          );
          assert.deepEqual(
            periods.map((p) => p.status),
            ["operational", "full_outage", "operational"],
          );
          await recordObservations(store, [
            {
              id: first,
              result: { status: "no_data" },
              now: new Date(+start + 210000),
            },
          ]);
          assert.equal(
            (await store.component(first)).lastSeen,
            new Date(+start + 180000).toISOString(),
          );
          store.transaction = original;
        },
      );
      await t.test(
        "failure rolls back all members of the same batch",
        async () => {
          const ids = specs.slice(0, 2).map(({ id }) => id);
          const before = await Promise.all(
            ids.map((id) => store.component(id)),
          );
          const counts = () =>
            store.query(
              "SELECT component_id,COUNT(*) AS count FROM observations WHERE component_id IN (?) GROUP BY component_id ORDER BY component_id",
              [ids],
            );
          const previousCounts = await counts();
          await assert.rejects(
            recordObservations(store, [
              {
                id: ids[0],
                result: { status: "operational" },
                now: new Date(+start + 240000),
                seen: true,
              },
              {
                id: ids[1],
                result: { status: "invalid-status-".repeat(8) },
                now: new Date(+start + 240000),
                seen: true,
              },
            ]),
          );
          assert.deepEqual(await counts(), previousCounts);
          assert.deepEqual(
            await Promise.all(ids.map((id) => store.component(id))),
            before,
          );
        },
      );
      await t.test("rediscovery reactivates archived definitions", async () => {
        await store.query("UPDATE components SET archived=TRUE WHERE id=?", [
          first,
        ]);
        assert.equal(
          await store.upsertMany([specs[0]], "kubernetes", start),
          1,
        );
        assert.equal((await store.component(first)).archived, false);
      });
    } finally {
      for (const table of ["observations", "periods", "component_evidence"])
        await store.query(`DELETE FROM ${table} WHERE component_id IN (?)`, [
          specs.map(({ id }) => id),
        ]);
      await store.query("DELETE FROM components WHERE id IN (?)", [
        specs.map(({ id }) => id),
      ]);
      await store.close();
    }
  },
);
