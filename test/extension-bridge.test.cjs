const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const bridgeSource = fs.readFileSync(path.resolve(__dirname, "..", "extension", "page-bridge.js"), "utf8");

function messageEvent(source, data) {
  const event = new Event("message");
  Object.defineProperties(event, { source: { value: source }, data: { value: data } });
  return event;
}

test("extension page bridge queues and minimizes OpenFront telemetry without exposing extension credentials", () => {
  class MockWindow extends EventTarget {
    postMessage(data) { this.dispatchEvent(messageEvent(this, data)); }
  }
  class MockWebSocket extends EventTarget {
    constructor(url) { super(); this.url = url; this.sent = []; }
    send(data) { this.sent.push(data); }
  }
  class MockWorker extends EventTarget {
    constructor() { super(); this.sent = []; }
    postMessage(message, transfer) { this.sent.push({ message, transfer }); }
  }

  const page = new MockWindow();
  page.WebSocket = MockWebSocket;
  page.Worker = MockWorker;
  const forwarded = [];
  page.addEventListener("message", (event) => {
    if (event.data?.source === "openfront-party-page-bridge-v1") forwarded.push(event.data);
  });
  vm.runInContext(bridgeSource, vm.createContext({
    Array,
    Event,
    EventTarget,
    JSON,
    Map,
    Object,
    Proxy,
    Reflect,
    Set,
    String,
    location: { origin: "https://openfront.io" },
    window: page,
  }));

  const socket = new page.WebSocket("wss://openfront.io/w2");
  const worker = new page.Worker("/assets/game-worker.js");
  worker.postMessage({ type: "init", clientID: "CLIENT01", gameStartInfo: { gameID: "GAME1234", config: {} } });
  socket.dispatchEvent(messageEvent(socket, JSON.stringify({
    type: "start",
    myClientID: "CLIENT01",
    gameStartInfo: { gameID: "GAME1234", config: {} },
    turns: [],
  })));
  const updates = Array.from({ length: 24 }, () => []);
  updates[1].push({ type: 1, id: 9, ownerID: 7, unitType: "Port" }, { type: 1, id: 10, ownerID: 8, unitType: "City" });
  updates[2].push({ type: 2, id: 7, clientID: "CLIENT01" }, { type: 2, id: 8, clientID: "OTHER" });
  updates[23].push({ type: 23, donationType: "gold", senderId: 7, recipientId: 8, amount: 500n });
  worker.dispatchEvent(messageEvent(worker, { type: "game_update_batch", gameUpdates: [{ tick: 10, updates }] }));
  assert.equal(forwarded.length, 0, "page telemetry must wait until the isolated extension listener is ready");

  page.postMessage({ source: "openfront-party-extension-v1", type: "ready" });
  assert.deepEqual(forwarded.map((message) => message.kind), ["worker-outbound", "server", "worker"]);
  const compact = forwarded.find((message) => message.kind === "worker").payload.gameUpdates[0].updates;
  assert.equal(compact[1].length, 1, "untracked units must not cross the page bridge");
  assert.equal(compact[2].length, 1, "other player identities must not cross the page bridge");
  assert.equal(compact[23][0].amount, 500n);
  assert.equal(worker.sent.length, 1, "the bridge must preserve original worker messages");
  assert.equal(socket.sent.length, 0);
  assert.doesNotMatch(JSON.stringify(forwarded, (_, value) => typeof value === "bigint" ? value.toString() : value), /companionToken|Authorization/);
});
