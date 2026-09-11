import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { feedEntries, renderFeed } from "../server/feeds.mjs";
import { createApp } from "../server/app.mjs";
import { settings } from "../server/config.mjs";

const origin = "https://status.example.org";
const atom = "http://www.w3.org/2005/Atom";
const initial = "2026-09-11T08:00:00.000Z";
const later = "2026-09-11T08:10:00.000Z";
const incident = {
  id: "10000000-0000-4000-8000-000000000001",
  title: "查询 & <服务>",
  message: "已恢复",
  phase: "resolved",
  startedAt: initial,
  updatedAt: later,
  updates: [
    {
      id: "10000000-0000-4000-8000-000000000003",
      phase: "resolved",
      message: "已恢复",
      createdAt: later,
    },
    {
      id: "10000000-0000-4000-8000-000000000002",
      phase: "investigating",
      message: '请等待 <script>alert("x")</script> & 复查\u0001',
      createdAt: initial,
    },
  ],
};

test("feed updates retain stable distinct identifiers and newest progress is listed first", () => {
  const entries = feedEntries([incident]);
  assert.equal(entries.length, 2);
  assert.equal(entries[0].message, "已恢复");
  assert.equal(entries[1].id, incident.id);
  assert.notEqual(entries[0].id, entries[1].id);
  assert.deepEqual(
    feedEntries([incident]).map((entry) => entry.id),
    entries.map((entry) => entry.id),
  );
  const simultaneous = {
    ...incident,
    updates: incident.updates.map((update) => ({
      ...update,
      createdAt: initial,
    })),
  };
  assert.equal(
    new Set(feedEntries([simultaneous]).map((entry) => entry.id)).size,
    2,
  );
});

test("RSS and Atom are parseable feeds with reader metadata and safe text", () => {
  const entries = feedEntries([incident]);
  for (const format of ["rss", "atom"]) {
    const dom = new JSDOM(renderFeed(format, origin, entries, later), {
      contentType: "application/xml",
    });
    try {
      const doc = dom.window.document;
      assert.equal(doc.querySelector("parsererror"), null);
      assert.equal(doc.querySelector("script"), null);
      assert.equal(
        doc.getElementsByTagNameNS(atom, "link")[0].getAttribute("href"),
        `${origin}/feed.${format}`,
      );
      if (format === "rss") {
        assert.equal(doc.documentElement.getAttribute("version"), "2.0");
        assert.equal(doc.querySelectorAll("channel > item").length, 2);
        assert.equal(doc.querySelector("channel > link").textContent, origin);
        assert(
          !Number.isNaN(Date.parse(doc.querySelector("pubDate").textContent)),
        );
        assert(
          doc
            .querySelectorAll("description")[2]
            .textContent.includes("&lt;script&gt;"),
        );
      } else {
        assert.equal(doc.documentElement.namespaceURI, atom);
        assert.equal(
          doc.getElementsByTagNameNS(atom, "author")[0].textContent,
          "Lazy Campus",
        );
        assert.equal(doc.getElementsByTagNameNS(atom, "entry").length, 2);
        assert.equal(
          doc.getElementsByTagNameNS(atom, "updated")[0].textContent,
          later,
        );
        assert.equal(
          doc.getElementsByTagNameNS(atom, "content")[1].getAttribute("type"),
          "text",
        );
        assert(
          doc
            .getElementsByTagNameNS(atom, "content")[1]
            .textContent.includes('<script>alert("x")</script>'),
        );
      }
    } finally {
      dom.window.close();
    }
  }
  const empty = new JSDOM(renderFeed("atom", origin, [], later), {
    contentType: "application/xml",
  });
  assert.equal(
    empty.window.document.getElementsByTagNameNS(atom, "author").length,
    1,
  );
  assert.equal(
    empty.window.document.getElementsByTagNameNS(atom, "entry").length,
    0,
  );
  empty.window.close();
});

test("anonymous feed endpoints include recent updates on longstanding incidents and exclude private services", async () => {
  const app = await createApp({
    store: {},
    config: settings({ STATUS_ORIGIN: origin }),
    logging: false,
  });
  const now = new Date();
  const startedAt = new Date(+now - 120 * 86400000).toISOString();
  const current = {
    ...incident,
    phase: "investigating",
    startedAt,
    updatedAt: now.toISOString(),
    componentIds: ["public"],
    updates: [{ ...incident.updates[1], createdAt: now.toISOString() }],
  };
  app.snapshots.data = {
    at: now,
    periods: [],
    components: [
      {
        id: "public",
        public: true,
        group: "project",
        name: "Public service",
        status: "degraded_performance",
        checkedAt: now.toISOString(),
      },
      { id: "archived", public: true, archived: true },
    ],
    incidents: [
      current,
      {
        ...current,
        id: "private-incident",
        title: "PRIVATE SERVICE",
        componentIds: ["private"],
      },
      {
        ...current,
        id: "archived-incident",
        title: "ARCHIVED SERVICE",
        componentIds: ["archived"],
      },
    ],
  };
  try {
    for (const phase of ["investigating", "resolved"]) {
      current.phase = phase;
      for (const format of ["rss", "atom"]) {
        const response = await app.inject({ url: `/feed.${format}` });
        assert.equal(response.statusCode, 200);
        assert.match(
          response.headers["content-type"],
          new RegExp(`application/${format}\\+xml`),
        );
        assert.equal(response.headers["set-cookie"], undefined);
        assert(response.body.includes(current.id));
        assert(!response.body.includes("PRIVATE SERVICE"));
        assert(!response.body.includes("private-incident"));
        assert(!response.body.includes("ARCHIVED SERVICE"));
      }
    }
  } finally {
    await app.close();
  }
});
