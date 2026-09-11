import { settings } from "./config.mjs";
import { Store } from "./store.mjs";
import { createApp } from "./app.mjs";
const config = settings();
if (config.adminToken.length < 32)
  throw new Error("STATUS_ADMIN_TOKEN must contain at least 32 characters");
const store = new Store(config.db);
await store.init();
const app = await createApp({ store, config });
await app.snapshots.refresh();
await app.listen({ host: "0.0.0.0", port: config.port });
app.monitor.start();
let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  await app.close();
  await store.close();
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
