const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { WebSocket } = require("ws");

const root = path.resolve(__dirname, "..");

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => server.listen(0, "127.0.0.1", resolve).once("error", reject));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function startRelay(options = {}) {
  const port = await freePort();
  const dataDir = options.historyFile ? null : fs.mkdtempSync(path.join(os.tmpdir(), "openfront-party-test-"));
  const historyFile = options.historyFile || path.join(dataDir, "match-history.json");
  const child = spawn(process.execPath, ["server.cjs"], {
    cwd: root,
    env: { ...process.env, PORT: String(port), HOST: "127.0.0.1", MATCH_HISTORY_FILE: historyFile },
    stdio: ["ignore", "pipe", "pipe"],
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Relay did not start in time.")), 5_000);
    child.once("exit", (code) => reject(new Error(`Relay exited during startup (${code}).`)));
    child.stdout.on("data", (chunk) => {
      if (!String(chunk).includes("OpenFront pre-lobby available")) return;
      clearTimeout(timer);
      resolve();
    });
  });
  if (dataDir) child.once("exit", () => fs.rmSync(dataDir, { recursive: true, force: true }));
  return { child, origin: `http://127.0.0.1:${port}`, wsUrl: `ws://127.0.0.1:${port}`, historyFile };
}

class TestClient {
  constructor(url) {
    this.socket = new WebSocket(url);
    this.messages = [];
    this.waiters = new Set();
    this.socket.on("message", (data) => {
      const message = JSON.parse(String(data));
      this.messages.push(message);
      for (const waiter of [...this.waiters]) waiter();
    });
  }

  async open() {
    if (this.socket.readyState === WebSocket.OPEN) return;
    await new Promise((resolve, reject) => {
      this.socket.once("open", resolve);
      this.socket.once("error", reject);
    });
  }

  send(type, payload = {}) {
    this.socket.send(JSON.stringify({ v: 1, type, ...payload }));
  }

  async take(predicate, timeoutMs = 4_000) {
    const existing = this.messages.findIndex(predicate);
    if (existing >= 0) return this.messages.splice(existing, 1)[0];
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters.delete(check);
        reject(new Error("Timed out waiting for relay message."));
      }, timeoutMs);
      const check = () => {
        const index = this.messages.findIndex(predicate);
        if (index < 0) return;
        clearTimeout(timer);
        this.waiters.delete(check);
        resolve(this.messages.splice(index, 1)[0]);
      };
      this.waiters.add(check);
    });
  }

  close() {
    this.socket.close();
  }
}

async function jsonRequest(origin, pathName, { method = "GET", token, data } = {}) {
  const response = await fetch(`${origin}${pathName}`, {
    method,
    headers: {
      Accept: "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(data ? { "Content-Type": "application/json" } : {}),
    },
    body: data ? JSON.stringify(data) : undefined,
  });
  const payload = await response.json();
  if (!response.ok) throw Object.assign(new Error(payload.error || `HTTP ${response.status}`), { status: response.status });
  return payload;
}

async function linkCompanion(client, origin) {
  client.send("companion.ticket.create");
  const ticketMessage = await client.take((message) => message.type === "companion.ticket");
  return jsonRequest(origin, "/api/companion/claim", {
    method: "POST",
    data: { ticket: ticketMessage.ticket },
  });
}

async function reportState(origin, linked, phase) {
  return jsonRequest(origin, "/api/companion/state", {
    method: "POST",
    token: linked.companionToken,
    data: { phase },
  });
}

async function events(origin, linked, cursor = linked.cursor, revision = 0) {
  return jsonRequest(origin, `/api/companion/events?cursor=${cursor}&revision=${revision}`, {
    token: linked.companionToken,
  });
}

async function waitForCompanionEvent(origin, linked, type, cursor, revision, timeoutMs = 4_000) {
  const deadline = Date.now() + timeoutMs;
  let nextCursor = cursor;
  let nextRevision = revision;
  while (Date.now() < deadline) {
    const response = await events(origin, linked, nextCursor, nextRevision);
    const found = response.events.find((event) => event.type === type);
    if (found) return { event: found, response };
    nextCursor = response.cursor;
    nextRevision = response.revision;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for companion event ${type}.`);
}

test("finalized companion reports are authenticated, grouped, and persisted", async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openfront-party-history-"));
  const historyFile = path.join(dataDir, "matches.json");
  const relay = await startRelay({ historyFile });
  const leader = new TestClient(relay.wsUrl);
  t.after(() => {
    leader.close();
    relay.child.kill();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  await leader.open();
  await leader.take((message) => message.type === "session.welcome");
  leader.send("group.create", { name: "Trusted Leader", decisionMode: "dictator", isPublic: true });
  await leader.take((message) => message.type === "group.snapshot" && message.room.members.length === 1);
  const linked = await linkCompanion(leader, relay.origin);
  await jsonRequest(relay.origin, "/api/companion/state", {
    method: "POST", token: linked.companionToken,
    data: { phase: "in_game", gameId: "MATCH-42", worker: "w2" },
  });

  const report = {
    gameId: "MATCH-42", finalized: true, name: "Spoofed Name", won: true,
    finalTiles: 4242, attackTroops: "9000000", donatedTroops: "12000",
    donatedGold: "700000", goldGenerated: "12345678", nukeGoldSpent: "5750000",
    portsBuilt: 3, factoriesBuilt: 2, atomBombs: 1, atomBombsLanded: 1,
    hydrogenBombs: 1, hydrogenBombsLanded: 0,
  };
  await jsonRequest(relay.origin, "/api/companion/matches", { method: "POST", token: linked.companionToken, data: report });
  report.donatedTroops = "13000";
  await jsonRequest(relay.origin, "/api/companion/matches", { method: "POST", token: linked.companionToken, data: report });

  const history = await jsonRequest(relay.origin, "/api/matches");
  assert.equal(history.matches.length, 1);
  assert.equal(history.matches[0].players.length, 1);
  assert.equal(history.matches[0].players[0].name, "Trusted Leader");
  assert.equal(history.matches[0].players[0].donatedTroops, "13000");
  assert.equal("memberId" in history.matches[0].players[0], false);
  assert.equal(fs.existsSync(historyFile), true);

  await assert.rejects(
    jsonRequest(relay.origin, "/api/companion/matches", { method: "POST", token: linked.companionToken, data: { ...report, gameId: "FAKE" } }),
    (error) => error.status === 409,
  );
});

test("party members can report Ready from the viewer connection", async (t) => {
  const relay = await startRelay();
  const leader = new TestClient(relay.wsUrl);
  const member = new TestClient(relay.wsUrl);
  t.after(() => {
    leader.close();
    member.close();
    relay.child.kill();
  });

  await Promise.all([leader.open(), member.open()]);
  const [leaderWelcome, memberWelcome] = await Promise.all([
    leader.take((message) => message.type === "session.welcome"),
    member.take((message) => message.type === "session.welcome"),
  ]);

  leader.send("group.create", { name: "Leader", decisionMode: "dictator", isPublic: true });
  const created = await leader.take((message) => message.type === "group.snapshot" && message.room.members.length === 1);
  member.send("group.join", { name: "Member", code: created.room.code });
  await leader.take((message) => message.type === "group.snapshot" && message.room.members.length === 2);

  member.send("member.state", { state: "ready" });
  const readySnapshot = await member.take((message) => message.type === "group.snapshot" && message.room.members.some((item) => item.id === memberWelcome.clientId && item.phase === "ready"));
  const readyMember = readySnapshot.room.members.find((item) => item.id === memberWelcome.clientId);
  assert.equal(readyMember.state, "ready");
  assert.equal(readyMember.phase, "ready");

  member.send("member.state", { state: "watching" });
  const watchingSnapshot = await member.take((message) => message.type === "group.snapshot" && message.room.members.some((item) => item.id === memberWelcome.clientId && item.phase === "watching"));
  const watchingMember = watchingSnapshot.room.members.find((item) => item.id === memberWelcome.clientId);
  assert.equal(watchingMember.state, "watching");
  assert.equal(watchingMember.phase, "watching");

  const lobby = {
    id: "VIEWERREADY1",
    name: "Europe",
    map: "Europe",
    mode: "Teams",
    server: "w1",
    players: 10,
    capacity: 100,
    startsAt: Date.now() + 60_000,
  };
  leader.send("member.state", { state: "ready" });
  member.send("member.state", { state: "ready" });
  await leader.take((message) => message.type === "group.snapshot" && message.room.members.every((item) => item.phase === "ready"));
  leader.send("member.observe_lobby", { lobby, observedAt: Date.now() });
  leader.send("leader.select_lobby", { lobby });
  await leader.take((message) => message.type === "group.snapshot" && message.room.selectedLobby?.id === lobby.id);
  leader.send("leader.launch", { attendance: "all", lobby });
  const launch = await leader.take((message) => message.type === "launch.accepted");
  assert.equal(launch.participants, 2);
  const launchedSnapshot = await member.take((message) => message.type === "group.snapshot" && message.room.currentLaunch?.lobby?.id === lobby.id);
  assert.deepEqual(new Set(launchedSnapshot.room.currentLaunch.participantIds), new Set([leaderWelcome.clientId, memberWelcome.clientId]));
});

test("duplicate callsigns are rejected and detached viewers do not keep parties active", async (t) => {
  const relay = await startRelay();
  const leader = new TestClient(relay.wsUrl);
  const member = new TestClient(relay.wsUrl);
  const duplicate = new TestClient(relay.wsUrl);
  t.after(() => {
    leader.close();
    member.close();
    duplicate.close();
    relay.child.kill();
  });

  await Promise.all([leader.open(), member.open(), duplicate.open()]);
  await Promise.all([
    leader.take((message) => message.type === "session.welcome"),
    member.take((message) => message.type === "session.welcome"),
    duplicate.take((message) => message.type === "session.welcome"),
  ]);

  leader.send("group.create", { name: "Alpha", decisionMode: "dictator", isPublic: true });
  const created = await leader.take((message) => message.type === "group.snapshot" && message.room.members.length === 1);
  duplicate.send("group.join", { name: "alpha", code: created.room.code });
  const duplicateError = await duplicate.take((message) => message.type === "group.error");
  assert.match(duplicateError.message, /callsign is already/i);

  member.send("group.join", { name: "Bravo", code: created.room.code });
  await leader.take((message) => message.type === "group.snapshot" && message.room.members.length === 2);
  leader.send("member.state", { state: "ready" });
  member.send("member.state", { state: "ready" });
  await leader.take((message) => message.type === "group.snapshot" && message.room.members.every((item) => item.phase === "ready"));

  const memberClosed = new Promise((resolve) => member.socket.once("close", resolve));
  member.close();
  await memberClosed;
  await leader.take((message) => message.type === "group.snapshot" && message.room.members.some((item) => item.name === "Bravo" && item.viewerConnected === false));

  const listed = await jsonRequest(relay.origin, "/api/groups");
  assert.equal(listed.groups.find((group) => group.code === created.room.code)?.members, 1);

  const lobby = {
    id: "DETACHEDVIEWER1",
    name: "Cleanup test",
    map: "Cleanup test",
    mode: "Teams",
    server: "w1",
    players: 1,
    capacity: 100,
    startsAt: Date.now() + 60_000,
  };
  leader.send("member.observe_lobby", { lobby, observedAt: Date.now() });
  leader.send("leader.select_lobby", { lobby });
  await leader.take((message) => message.type === "group.snapshot" && message.room.selectedLobby?.id === lobby.id);
  leader.send("leader.launch", { attendance: "all", lobby });
  const launch = await leader.take((message) => message.type === "launch.accepted");
  assert.equal(launch.participants, 1);

  const leaderClosed = new Promise((resolve) => leader.socket.once("close", resolve));
  leader.close();
  await leaderClosed;
  let remaining = await jsonRequest(relay.origin, "/api/groups");
  for (let attempt = 0; attempt < 20 && remaining.groups.some((group) => group.code === created.room.code); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    remaining = await jsonRequest(relay.origin, "/api/groups");
  }
  assert.equal(remaining.groups.some((group) => group.code === created.room.code), false);
});

test("connected companions launch into an observed lobby and split members receive a persistent move event", async (t) => {
  const relay = await startRelay();
  const leader = new TestClient(relay.wsUrl);
  const member = new TestClient(relay.wsUrl);
  t.after(() => {
    leader.close();
    member.close();
    relay.child.kill();
  });

  await Promise.all([leader.open(), member.open()]);
  await Promise.all([
    leader.take((message) => message.type === "session.welcome"),
    member.take((message) => message.type === "session.welcome"),
  ]);

  leader.send("group.create", { name: "Leader", decisionMode: "dictator", isPublic: true });
  const created = await leader.take((message) => message.type === "group.snapshot" && message.room.members.length === 1);
  member.send("group.join", { name: "Member", code: created.room.code });
  await leader.take((message) => message.type === "group.snapshot" && message.room.members.length === 2);

  const firstLobby = {
    id: "TESTGAME1",
    name: "Bering Sea",
    map: "Bering Sea",
    mode: "Teams",
    server: "w1",
    players: 10,
    capacity: 100,
    startsAt: Date.now() + 60_000,
  };
  leader.send("member.observe_lobby", { lobby: firstLobby, observedAt: Date.now() });
  leader.send("leader.select_lobby", { lobby: firstLobby });
  await leader.take((message) => message.type === "group.snapshot" && message.room.selectedLobby?.id === firstLobby.id);
  leader.send("leader.launch", { attendance: "all", lobby: firstLobby });
  const blocked = await leader.take((message) => message.type === "group.error");
  assert.match(blocked.message, /Ready/i);

  const [leaderLink, memberLink] = await Promise.all([
    linkCompanion(leader, relay.origin),
    linkCompanion(member, relay.origin),
  ]);
  await Promise.all([
    reportState(relay.origin, leaderLink, "ready"),
    reportState(relay.origin, memberLink, "ready"),
  ]);

  leader.send("member.observe_lobby", { lobby: firstLobby, observedAt: Date.now() });
  leader.send("leader.launch", { attendance: "all", lobby: firstLobby });
  const firstLaunch = await leader.take((message) => message.type === "launch.accepted");
  assert.equal(firstLaunch.participants, 2);

  const [leaderFirstEvents, memberFirstEvents] = await Promise.all([
    events(relay.origin, leaderLink),
    events(relay.origin, memberLink),
  ]);
  assert.equal(leaderFirstEvents.events.find((event) => event.type === "join.command")?.gameId, firstLobby.id);
  assert.equal(memberFirstEvents.events.find((event) => event.type === "join.command")?.gameId, firstLobby.id);

  await Promise.all([
    reportState(relay.origin, leaderLink, "in_lobby"),
    reportState(relay.origin, memberLink, "in_game"),
  ]);
  await reportState(relay.origin, leaderLink, "ready");

  const secondLobby = {
    ...firstLobby,
    id: "TESTGAME2",
    name: "Europe",
    map: "Europe",
    players: 20,
    startsAt: Date.now() + 60_000,
  };
  leader.send("member.observe_lobby", { lobby: secondLobby, observedAt: Date.now() });
  leader.send("leader.select_lobby", { lobby: secondLobby });
  await leader.take((message) => message.type === "group.snapshot" && message.room.selectedLobby?.id === secondLobby.id);
  leader.send("member.observe_lobby", { lobby: secondLobby, observedAt: Date.now() });
  leader.send("leader.launch", { attendance: "ready", lobby: secondLobby });
  const splitLaunch = await leader.take((message) => message.type === "launch.accepted" && message.leftBehind === 1);
  assert.equal(splitLaunch.participants, 1);

  const leaderSecondEvents = await events(relay.origin, leaderLink, leaderFirstEvents.cursor, leaderFirstEvents.revision);
  assert.equal(leaderSecondEvents.events.find((event) => event.type === "join.command")?.gameId, secondLobby.id);
  await reportState(relay.origin, leaderLink, "in_lobby");

  const moved = await waitForCompanionEvent(
    relay.origin,
    memberLink,
    "party.moved",
    memberFirstEvents.cursor,
    memberFirstEvents.revision,
  );
  const movedEvent = moved.event;
  assert.equal(movedEvent.persistent, true);
  assert.equal(movedEvent.lobby.id, secondLobby.id);

  const action = await jsonRequest(relay.origin, "/api/companion/action", {
    method: "POST",
    token: memberLink.companionToken,
    data: { eventId: movedEvent.eventId, action: "follow_next" },
  });
  const memberState = action.room.members.find((item) => item.id === memberLink.memberId);
  assert.equal(memberState.catchUpRoundId, splitLaunch.roundId + 1);
});
