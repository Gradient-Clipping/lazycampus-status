import assert from "node:assert/strict";
import test from "node:test";
import { createApp } from "../server/app.mjs";
import { settings } from "../server/config.mjs";

test("the built public UI and deep links are served without a session or a database", async () => {
  const app = await createApp({
    store: {},
    config: settings({}),
    logging: false,
  });
  try {
    for (const path of [
      "/",
      "/history",
      "/admin",
      "/api-docs",
      "/unsubscribe",
    ]) {
      const response = await app.inject({ url: path });
      assert.equal(response.statusCode, 200, path + ": " + response.body);
      assert.match(response.headers["content-type"], /text\/html/);
      assert.match(response.body, /<div id="root"><\/div>/);
      assert.equal(response.headers["cache-control"], "no-store");
      assert.equal(response.headers["set-cookie"], undefined);
    }
    const index = await app.inject({ url: "/" });
    const script = index.body.match(/src="([^"]+\.js)"/)[1];
    for (const path of [script, "/favicon.svg", "/logo.webp"]) {
      const asset = await app.inject({ url: path });
      assert.equal(asset.statusCode, 200, path);
      assert(asset.rawPayload.length > 0);
    }
    assert.equal(
      (await app.inject({ method: "HEAD", url: "/" })).statusCode,
      200,
    );
    for (const path of ["/server/main.mjs", "/.env", "/unknown-page"]) {
      assert.equal((await app.inject({ url: path })).statusCode, 404, path);
    }
  } finally {
    await app.close();
  }
});
