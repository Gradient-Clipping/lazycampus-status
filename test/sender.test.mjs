import assert from "node:assert/strict";
import test from "node:test";
import { sendEmail } from "../server/subscriptions.mjs";
test("Sender uses the verified transaction contract and never assumes HTTP 200 means accepted", async (t) => {
  const config = { senderKey: "test-only", senderFrom: "status@example.test" };
  let payload;
  const mocked = t.mock.method(globalThis, "fetch", async (url, options) => {
    assert.equal(url, "https://api.sender.net/v2/message/send");
    assert.equal(options.redirect, "error");
    payload = JSON.parse(options.body);
    return new Response('{"success":true}', { status: 200 });
  });
  assert.equal(
    (await sendEmail(config, "user@example.test", "status", "message")).ok,
    true,
  );
  assert.deepEqual(payload.to, { email: "user@example.test" });
  mocked.mock.mockImplementation(
    async () => new Response('{"success":false}', { status: 200 }),
  );
  assert.equal(
    (await sendEmail(config, "user@example.test", "status", "message")).ok,
    false,
  );
  mocked.mock.mockImplementation(
    async () =>
      new Response("{}", { status: 429, headers: { "Retry-After": "120" } }),
  );
  const limited = await sendEmail(
    config,
    "user@example.test",
    "status",
    "message",
  );
  assert.equal(limited.retry, true);
  assert.equal(limited.retryAfter, 120);
  mocked.mock.mockImplementation(async () => {
    throw new Error("timeout");
  });
  const uncertain = await sendEmail(
    config,
    "user@example.test",
    "status",
    "message",
  );
  assert.equal(uncertain.retry, false);
  assert.equal(uncertain.code, "DELIVERY_UNCERTAIN");
});
