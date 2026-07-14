const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const companionSource = fs.readFileSync(
  path.resolve(__dirname, "..", "public", "openfront-party-companion.user.js"),
  "utf8",
);

function messageEvent(data) {
  const event = new Event("message");
  Object.defineProperty(event, "data", { value: data });
  return event;
}

test("companion records confirmed local match telemetry from OpenFront messages", () => {
  const values = new Map();

  class MockWebSocket extends EventTarget {
    constructor(url) {
      super();
      this.url = url;
      this.sent = [];
    }

    send(data) {
      this.sent.push(data);
    }
  }

  class MockWorker extends EventTarget {
    constructor() {
      super();
      this.sent = [];
    }
    postMessage(message, transfer) {
      this.sent.push({ message, transfer });
    }
  }

  const document = {
    readyState: "loading",
    addEventListener() {},
  };
  const page = { WebSocket: MockWebSocket, Worker: MockWorker };
  const context = vm.createContext({
    BigInt,
    Date,
    Event,
    EventTarget,
    Map,
    MutationObserver: class {},
    Object,
    Proxy,
    Reflect,
    Set,
    String,
    URL,
    URLSearchParams,
    clearTimeout,
    console,
    document,
    history: { replaceState() {} },
    location: { pathname: "/w2/game/GAME1234", search: "", hash: "" },
    setInterval() {},
    setTimeout,
    unsafeWindow: page,
    window: page,
    GM_addStyle() {},
    GM_deleteValue(key) { values.delete(key); },
    GM_getValue(key, fallback) { return values.has(key) ? values.get(key) : fallback; },
    GM_setValue(key, value) { values.set(key, structuredClone(value)); },
    GM_xmlhttpRequest() {},
  });

  vm.runInContext(companionSource, context);

  new page.WebSocket("wss://openfront.io/w2");
  const worker = new page.Worker("/assets/game-worker.js");
  worker.postMessage({
    type: "init",
    clientID: "CLIENT01",
    gameStartInfo: { gameID: "GAME1234" },
  });
  worker.postMessage({
    type: "turn",
    turn: {
      turnNumber: 10,
      intents: [{ type: "build_unit", unit: "Port", tile: 42, clientID: "CLIENT01" }],
    },
  });
  const updates = Array.from({ length: 24 }, () => []);
  updates[2].push({ type: 2, id: 7, clientID: "CLIENT01" });
  updates[1].push({ type: 1, id: 99, ownerID: 7, unitType: "Port" });
  updates[23].push({ type: 23, donationType: "troops", senderId: 7, recipientId: 8, amount: 12500n });
  updates[23].push({ type: 23, donationType: "gold", senderId: 7, recipientId: 8, amount: 500000n });
  worker.dispatchEvent(messageEvent({ type: "game_update_batch", gameUpdates: [{ tick: 10, updates }] }));

  const winUpdates = Array.from({ length: 25 }, () => []);
  winUpdates[10].push({
    type: 10,
    winner: ["player", "CLIENT01"],
    allPlayersStats: {
      CLIENT01: {
        finalTiles: 9876,
        attacks: ["7654321", "123", "0"],
        gold: ["100", "200", "300", "400", "500", "600"],
        units: { port: ["3"], fact: ["2"] },
        bombs: { abomb: ["4", "3"], hbomb: ["1", "1"] },
      },
    },
  });
  worker.dispatchEvent(messageEvent({ type: "game_update_batch", gameUpdates: [{ tick: 20, updates: winUpdates }] }));

  const sessions = values.get("openfront-party-match-telemetry-v1");
  assert.equal(worker.sent.length, 2, "companion must preserve worker postMessage calls");
  assert.deepEqual(JSON.parse(JSON.stringify(sessions.GAME1234)), {
    gameId: "GAME1234",
    startedAt: sessions.GAME1234.startedAt,
    updatedAt: sessions.GAME1234.updatedAt,
    donatedTroops: "12500",
    donatedGold: "500000",
    portsBuilt: 3,
    factoriesBuilt: 2,
    atomBombsBuilt: 4,
    hydrogenBombsBuilt: 1,
    atomBombGoldSpent: "3000000",
    hydrogenBombGoldSpent: "5000000",
    goldGenerated: "2100",
    goldBreakdown: {
      workers: "100",
      conquest: "200",
      tradeShips: "300",
      capturedTrade: "400",
      ownTrains: "500",
      otherTrains: "600",
    },
    finalized: true,
    finalTiles: 9876,
    attackTroops: "7654321",
    atomBombsLanded: 3,
    hydrogenBombsLanded: 1,
    won: true,
    endedAt: sessions.GAME1234.endedAt,
    infiniteGold: false,
    hostInfiniteGold: false,
    clientId: "CLIENT01",
    playerId: 7,
  });
});
