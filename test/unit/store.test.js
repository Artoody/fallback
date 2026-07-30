import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import Store from "../../src/store.js";

test("rotating PROXY_API_KEY reconciles one env client and revokes the old key", (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "fallback-store-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const store = new Store({ dataDir, persistDebounceMs: 1 });
  store.seedFromEnv({ geminiKeys: ["g"], proxyApiKey: "old-client-key" });
  const old = store.findClientByKey("old-client-key");
  assert.ok(old);

  store.data.clients.push({
    ...old,
    id: "legacy-duplicate",
    stats: { requests: 2, success: 1, errors: 1 },
  });
  store.seedFromEnv({ proxyApiKey: "new-client-key" });

  assert.equal(store.findClientByKey("old-client-key"), null);
  assert.ok(store.findClientByKey("new-client-key"));
  const envClients = store.listClients().filter((client) => client.source === "env-proxy");
  assert.equal(envClients.length, 1);
  assert.equal(envClients[0].stats.requests, 2);
});
