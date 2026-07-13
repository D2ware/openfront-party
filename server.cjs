const http = require("node:http");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { WebSocketServer, WebSocket } = require("ws");

const PORT = Number(process.env.PORT || 3030);
const HOST = process.env.HOST || "127.0.0.1";
const PUBLIC_DIR = path.join(__dirname, "public");
const VIEWER_DIR = path.join(__dirname, "viewer");
const MAX_MESSAGE_BYTES = 8 * 1024;
const MAX_HTTP_BODY_BYTES = 16 * 1024;
const HEARTBEAT_MS = 25_000;
const STALE_VIEWER_MS = 70_000;
const VIEWER_RECONNECT_GRACE_MS = 5 * 60_000;
const COMPANION_GRACE_MS = 30 * 60_000;
const COMPANION_TICKET_MS = 60_000;
const JOIN_COMMAND_MS = 20_000;
const MAX_LOBBY_OBSERVATION_AGE_MS = 10_000;
const MIN_LOBBY_START_LEAD_MS = 8_000;
const LONG_POLL_MS = 20_000;

const rooms = new Map();
const sessions = new Map();
const companionTickets = new Map();
const companionTokens = new Map();

const demoLobbies = [
  { id: "montreal", name: "Montreal", mode: "Free for all", map: "Compact map", players: 18, capacity: 100, eta: "1m 52s", server: "w2", status: "open" },
  { id: "bering-sea", name: "Bering Sea", mode: "2 teams of 10", map: "Compact map", players: 0, capacity: 20, eta: "1m 57s", server: "w1", status: "open" },
  { id: "aegean", name: "Aegean", mode: "Free for all", map: "Random spawn", players: 8, capacity: 60, eta: "1m 32s", server: "w3", status: "open" },
  { id: "world", name: "World", mode: "Free for all", map: "World map", players: 0, capacity: 35, eta: "Open", server: "w0", status: "open" },
  { id: "hormuz", name: "Strait of Hormuz", mode: "2 teams of 32", map: "Classic", players: 0, capacity: 64, eta: "Open", server: "w4", status: "open" },
  { id: "svalmel", name: "Svalmel", mode: "4 teams of 12", map: "Water nukes", players: 0, capacity: 48, eta: "Open", server: "w2", status: "open" },
];

function cleanText(value, max) {
  return typeof value === "string" ? value.trim().replace(/[<>]/g, "").slice(0, max) : "";
}

function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString("base64url");
}

function tokenHash(token) {
  return crypto.createHash("sha256").update(String(token)).digest("base64url");
}

function roomCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  return Array.from({ length: 6 }, () => alphabet[crypto.randomInt(alphabet.length)]).join("");
}

function send(socket, message) {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
}

function json(res, status, payload, extraHeaders = {}) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    ...extraHeaders,
  });
  res.end(JSON.stringify(payload));
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_HTTP_BODY_BYTES) {
        reject(Object.assign(new Error("Request body is too large."), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
      catch { reject(Object.assign(new Error("Request body must be valid JSON."), { status: 400 })); }
    });
    req.on("error", reject);
  });
}

function serveFile(req, res) {
  const requested = req.url === "/" ? "/index.html" : req.url.split("?")[0];
  if (requested === "/viewer") { res.writeHead(302, { Location: "/viewer/" }); res.end(); return; }
  const isViewer = requested.startsWith("/viewer/");
  const root = isViewer ? VIEWER_DIR : PUBLIC_DIR;
  const relativePath = isViewer ? requested.slice("/viewer".length) : requested;
  const relative = relativePath === "/" ? "/index.html" : relativePath;
  const file = path.normalize(path.join(root, relative));
  if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404); res.end("Not found"); return;
  }
  const types = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
  };
  res.writeHead(200, { "Content-Type": types[path.extname(file)] || "application/octet-stream", "Cache-Control": "no-store" });
  fs.createReadStream(file).pipe(res);
}

function isCompanionFresh(member, maxAge = STALE_VIEWER_MS) {
  return Boolean(member.companionTokenHash && member.companionLastSeen && member.companionLastSeen >= Date.now() - maxAge);
}

function publicMember(member) {
  return {
    id: member.id,
    name: member.name,
    role: member.role,
    state: member.phase,
    phase: member.phase,
    filterPreference: member.filterPreference,
    gameId: member.gameId,
    worker: member.worker,
    roundId: member.roundId,
    catchUpRoundId: member.catchUpRoundId,
    viewerConnected: member.socket?.readyState === WebSocket.OPEN,
    companionConnected: isCompanionFresh(member),
  };
}

function roomSnapshot(room) {
  const votes = [...room.votes.entries()].map(([memberId, lobby]) => ({ memberId, lobby }));
  const regroupWaiting = [...room.members].filter((member) => member.catchUpRoundId && member.phase !== "ready").length;
  return {
    code: room.code,
    revision: room.revision,
    isPublic: room.isPublic,
    decisionMode: room.decisionMode,
    selectedLobby: room.selectedLobby,
    hoveredLobbyId: room.hoveredLobbyId,
    roundId: room.roundId,
    regroupWaiting,
    currentLaunch: room.currentLaunch ? {
      roundId: room.currentLaunch.roundId,
      lobby: room.currentLaunch.lobby,
      attendance: room.currentLaunch.attendance,
      participantIds: [...room.currentLaunch.participantIds],
      leftBehindIds: [...room.currentLaunch.leftBehindIds],
      acknowledgedIds: [...room.currentLaunch.acknowledgedIds],
      issuedAt: room.currentLaunch.issuedAt,
      expiresAt: room.currentLaunch.expiresAt,
    } : null,
    votes,
    members: [...room.members].map(publicMember),
  };
}

function snapshotMessage(room) {
  return { v: 1, type: "group.snapshot", room: roomSnapshot(room) };
}

function sendError(member, message) {
  send(member.socket, { v: 1, type: "group.error", message });
}

function broadcast(room) {
  const message = snapshotMessage(room);
  for (const member of room.members) send(member.socket, message);
}

function collectCompanionEvents(member, cursor) {
  return member.events.filter((event) => event.cursor > cursor || (event.persistent && !event.acknowledged));
}

function respondToPoll(member, waiter) {
  clearTimeout(waiter.timer);
  member.pollWaiters.delete(waiter);
  if (waiter.res.writableEnded) return;
  const events = collectCompanionEvents(member, waiter.cursor);
  const cursor = Math.max(waiter.cursor, member.eventCursor);
  json(waiter.res, 200, {
    cursor,
    revision: member.room?.revision || 0,
    serverTime: Date.now(),
    room: member.room ? roomSnapshot(member.room) : null,
    events,
  });
}

function flushMemberPolls(member) {
  for (const waiter of [...member.pollWaiters]) respondToPoll(member, waiter);
}

function bump(room) {
  room.revision += 1;
  broadcast(room);
  for (const member of room.members) flushMemberPolls(member);
}

function queueEvent(member, type, payload = {}, options = {}) {
  const event = {
    eventId: crypto.randomUUID(),
    cursor: ++member.eventCursor,
    type,
    createdAt: Date.now(),
    persistent: options.persistent === true,
    acknowledged: false,
    ...payload,
  };
  member.events.push(event);
  if (member.events.length > 100) {
    const removable = member.events.findIndex((item) => !item.persistent || item.acknowledged);
    member.events.splice(removable >= 0 ? removable : 0, 1);
  }
  send(member.socket, { v: 1, type, event });
  flushMemberPolls(member);
  return event;
}

function revokeCompanion(member) {
  if (member.companionTokenHash) companionTokens.delete(member.companionTokenHash);
  member.companionTokenHash = null;
  member.companionLastSeen = 0;
  for (const waiter of [...member.pollWaiters]) {
    clearTimeout(waiter.timer);
    member.pollWaiters.delete(waiter);
    if (!waiter.res.writableEnded) json(waiter.res, 401, { error: "Companion session ended." });
  }
}

function rotateViewerSession(member) {
  if (member.resumeToken) sessions.delete(member.resumeToken);
  member.resumeToken = randomToken();
  sessions.set(member.resumeToken, member);
  return member.resumeToken;
}

function removeMember(member, destroyViewerSession = false) {
  const room = member.room;
  if (room) {
    room.members.delete(member);
    room.votes.delete(member.id);
    member.room = null;
    if (!room.members.size) rooms.delete(room.code);
    else {
      if (member.role === "leader") {
        const successor = [...room.members].sort((a, b) => a.connectedAt - b.connectedAt)[0];
        successor.role = "leader";
      }
      recomputeDemocracy(room);
      bump(room);
    }
  }
  for (const [hash, ticket] of companionTickets) if (ticket.member === member) companionTickets.delete(hash);
  revokeCompanion(member);
  member.viewerDetachedAt = null;
  if (destroyViewerSession && member.resumeToken) {
    sessions.delete(member.resumeToken);
    member.resumeToken = null;
  }
}

function detachViewer(member) {
  if (!member.room || member.viewerDetachedAt) return;
  member.viewerDetachedAt = Date.now();
  member.socket = null;
  bump(member.room);
}

function cleanFilterPreference(value) {
  const summary = cleanText(value?.summary, 100) || "All public lobbies";
  const matchingLobbyIds = Array.isArray(value?.matchingLobbyIds)
    ? [...new Set(value.matchingLobbyIds.map((id) => cleanText(id, 64)).filter(Boolean))].slice(0, 100)
    : [];
  return { summary, matchingLobbyIds };
}

function recomputeDemocracy(room) {
  if (room.decisionMode !== "democracy") return;
  const activeIds = new Set([...room.members].map((member) => member.id));
  for (const memberId of room.votes.keys()) if (!activeIds.has(memberId)) room.votes.delete(memberId);
  const counts = new Map();
  for (const lobby of room.votes.values()) {
    const entry = counts.get(lobby.id) || { lobby, count: 0 };
    entry.count += 1;
    counts.set(lobby.id, entry);
  }
  const ranked = [...counts.values()].sort((a, b) => b.count - a.count || a.lobby.id.localeCompare(b.lobby.id));
  const winner = ranked[0];
  const runnerUp = ranked[1];
  const hasMajority = winner && winner.count > room.members.size / 2;
  const allVotedWithClearWinner = winner && room.votes.size === room.members.size && winner.count > (runnerUp?.count || 0);
  room.selectedLobby = hasMajority || allVotedWithClearWinner ? winner.lobby : null;
}

function validLobby(value) {
  if (!value || typeof value !== "object") return null;
  const id = cleanText(value.id, 64);
  const name = cleanText(value.name, 64);
  const map = cleanText(value.map, 64);
  const mode = cleanText(value.mode, 80);
  const server = cleanText(value.server, 8);
  const players = Number(value.players);
  const capacity = Number(value.capacity);
  const startsAt = value.startsAt == null ? null : Number(value.startsAt);
  if (!id || !name || !/^w\d+$/.test(server) || !Number.isInteger(players) || !Number.isInteger(capacity) || players < 0 || capacity < 1 || players > capacity || capacity > 1000) return null;
  if (startsAt !== null && (!Number.isFinite(startsAt) || startsAt < 0)) return null;
  return { id, name, map, mode, server, players, capacity, startsAt };
}

function lobbyKey(lobby) {
  return `${lobby.server}:${lobby.id}`;
}

function freshLobbyObservation(room, lobby, maxAge = MAX_LOBBY_OBSERVATION_AGE_MS) {
  const observation = room.lobbyObservations.get(lobbyKey(lobby));
  if (!observation || observation.receivedAt < Date.now() - maxAge) return null;
  return observation;
}

function canFollowLobbyNow(room, lobby) {
  const observation = freshLobbyObservation(room, lobby);
  if (!observation) return false;
  const current = observation.lobby;
  if (current.players >= current.capacity) return false;
  if (current.startsAt !== null && current.startsAt <= Date.now() + MIN_LOBBY_START_LEAD_MS) return false;
  return true;
}

function makeMember(socket) {
  const member = {
    id: crypto.randomUUID(),
    socket,
    room: null,
    name: "",
    role: "member",
    phase: "watching",
    filterPreference: { summary: "All public lobbies", matchingLobbyIds: [] },
    gameId: null,
    worker: null,
    roundId: 0,
    catchUpRoundId: null,
    connectedAt: Date.now(),
    lastSeen: Date.now(),
    viewerDetachedAt: null,
    resumeToken: null,
    companionTokenHash: null,
    companionLastSeen: 0,
    hits: [],
    eventCursor: 0,
    events: [],
    pollWaiters: new Set(),
  };
  rotateViewerSession(member);
  return member;
}

function createRoom(member, name, options = {}) {
  let code;
  do { code = roomCode(); } while (rooms.has(code));
  const room = {
    code,
    members: new Set(),
    isPublic: options.isPublic !== false,
    decisionMode: options.decisionMode === "democracy" ? "democracy" : "dictator",
    votes: new Map(),
    selectedLobby: null,
    hoveredLobbyId: null,
    currentLaunch: null,
    lobbyObservations: new Map(),
    roundId: 0,
    revision: 0,
  };
  rooms.set(code, room);
  joinRoom(member, room, name, "leader");
}

function joinRoom(member, room, name, role = "member") {
  if (member.room) removeMember(member);
  member.name = cleanText(name, 24) || "Player";
  member.role = role;
  member.phase = "watching";
  member.filterPreference = { summary: "All public lobbies", matchingLobbyIds: [] };
  member.gameId = null;
  member.worker = null;
  member.roundId = room.roundId;
  member.catchUpRoundId = null;
  member.viewerDetachedAt = null;
  member.room = room;
  room.members.add(member);
  recomputeDemocracy(room);
  bump(room);
}

function allowed(member, type) {
  const room = member.room;
  if (!room) { sendError(member, "Join or create a group first."); return false; }
  const leaderOnly = [
    "leader.select_lobby", "leader.hover_lobby", "leader.clear_hover", "leader.transfer",
    "leader.set_decision_mode", "leader.set_visibility", "leader.launch", "companion.ticket.create",
  ];
  if (leaderOnly.includes(type) && type !== "companion.ticket.create" && member.role !== "leader") {
    sendError(member, "Only the group leader can do that."); return false;
  }
  return true;
}

function issueCompanionTicket(member) {
  const ticket = randomToken();
  const expiresAt = Date.now() + COMPANION_TICKET_MS;
  companionTickets.set(tokenHash(ticket), { member, expiresAt });
  send(member.socket, { v: 1, type: "companion.ticket", ticket, expiresAt });
}

function issueJoinCommand(member, launch, expiresAt = launch.expiresAt) {
  const commandId = crypto.randomUUID();
  return queueEvent(member, "join.command", {
    commandId,
    roundId: launch.roundId,
    worker: launch.lobby.server,
    gameId: launch.lobby.id,
    lobby: launch.lobby,
    issuedAt: Date.now(),
    expiresAt,
  });
}

function launchParty(member, message) {
  if (!allowed(member, "leader.launch")) return;
  const room = member.room;
  const attendance = message.attendance === "ready" ? "ready" : "all";
  const requestedLobby = validLobby(message.lobby);
  if (!requestedLobby || !room.selectedLobby || requestedLobby.id !== room.selectedLobby.id || requestedLobby.server !== room.selectedLobby.server) {
    return sendError(member, "Select a current lobby before launching the party.");
  }
  const observation = freshLobbyObservation(room, requestedLobby);
  if (!observation) return sendError(member, "The lobby observation is stale. Wait for the next live lobby update.");
  const lobby = observation.lobby;
  if (lobby.startsAt !== null && lobby.startsAt <= Date.now() + MIN_LOBBY_START_LEAD_MS) {
    return sendError(member, "That lobby is starting too soon for a coordinated launch.");
  }

  const readyMembers = [...room.members].filter((item) => item.phase === "ready" && isCompanionFresh(item));
  if (!readyMembers.length) return sendError(member, "No party members are Ready with a connected companion.");
  if (attendance === "all" && readyMembers.length !== room.members.size) {
    return sendError(member, "Some members are still playing, not Ready, or missing the companion. Choose Launch ready members to split the party.");
  }

  const participants = attendance === "all" ? [...room.members] : readyMembers;
  const reserve = Math.max(2, Math.ceil(participants.length * 0.25));
  const openSlots = lobby.capacity - lobby.players;
  if (openSlots < participants.length + reserve) return sendError(member, `The lobby needs ${participants.length + reserve} open slots for this launch.`);
  const joinWindowSeconds = message.joinWindowSeconds == null ? null : Number(message.joinWindowSeconds);
  if (joinWindowSeconds !== null && (!Number.isFinite(joinWindowSeconds) || joinWindowSeconds < 12)) return sendError(member, "The estimated join window is too short for a coordinated launch.");

  const now = Date.now();
  const launch = {
    roundId: ++room.roundId,
    lobby,
    attendance,
    participantIds: new Set(participants.map((item) => item.id)),
    leftBehindIds: new Set([...room.members].filter((item) => !participants.includes(item)).map((item) => item.id)),
    acknowledgedIds: new Set(),
    issuedAt: now,
    expiresAt: now + JOIN_COMMAND_MS,
    movementTimer: null,
    movedNotified: false,
  };
  room.currentLaunch = launch;
  room.votes.clear();
  room.selectedLobby = null;
  room.hoveredLobbyId = null;

  for (const participant of participants) {
    participant.phase = "opening";
    participant.gameId = lobby.id;
    participant.worker = lobby.server;
    participant.roundId = launch.roundId;
    if (participant.catchUpRoundId && participant.catchUpRoundId <= launch.roundId) participant.catchUpRoundId = null;
    issueJoinCommand(participant, launch);
  }
  bump(room);
  send(member.socket, { v: 1, type: "launch.accepted", roundId: launch.roundId, participants: participants.length, leftBehind: launch.leftBehindIds.size });
}

function finalizeMovement(room, launch) {
  launch.movementTimer = null;
  if (room.currentLaunch !== launch || launch.movedNotified || !launch.acknowledgedIds.size) return;
  launch.movedNotified = true;
  const movedMembers = [...room.members].filter((item) => launch.acknowledgedIds.has(item.id)).map(publicMember);
  const remainingMembers = [...room.members].filter((item) => launch.leftBehindIds.has(item.id)).map(publicMember);
  for (const remaining of [...room.members].filter((item) => launch.leftBehindIds.has(item.id))) {
    queueEvent(remaining, "party.moved", {
      roundId: launch.roundId,
      lobby: launch.lobby,
      movedMembers,
      remainingMembers,
      expiresAt: launch.expiresAt,
      canFollowNow: Date.now() < launch.expiresAt && canFollowLobbyNow(room, launch.lobby),
    }, { persistent: true });
  }
  bump(room);
}

function recordLaunchAcknowledgement(member) {
  const room = member.room;
  const launch = room?.currentLaunch;
  if (!launch || member.roundId !== launch.roundId || !launch.participantIds.has(member.id)) return;
  if (!["in_lobby", "in_game"].includes(member.phase)) return;
  launch.acknowledgedIds.add(member.id);
  if (!launch.movementTimer && !launch.movedNotified) launch.movementTimer = setTimeout(() => finalizeMovement(room, launch), 600);
}

function updateMemberState(member, value) {
  if (!member.room) return false;
  const phases = new Set(["watching", "opening", "in_lobby", "in_game", "finished", "ready", "failed"]);
  const phase = cleanText(value.phase || value.state, 24);
  if (!phases.has(phase)) return false;
  const wasReady = member.phase === "ready";
  member.phase = phase;
  member.gameId = cleanText(value.gameId, 64) || null;
  member.worker = cleanText(value.worker, 8) || null;
  const reportedRound = Number(value.roundId);
  if (Number.isInteger(reportedRound) && reportedRound >= 0) member.roundId = reportedRound;
  recordLaunchAcknowledgement(member);
  if (phase === "ready" && !wasReady && member.catchUpRoundId) {
    for (const other of member.room.members) {
      if (other !== member) queueEvent(other, "member.ready_for_regroup", {
        member: publicMember(member),
        waiting: [...member.room.members].filter((item) => item.catchUpRoundId && item.phase === "ready").length,
      });
    }
  }
  bump(member.room);
  return true;
}

function acknowledgeMovedEvent(member, event, action) {
  if (!member.room || event.type !== "party.moved" || event.acknowledged) return { status: 409, error: "This party notification is no longer active." };
  const allowedActions = new Set(["follow_next", "leave_follow", "stay"]);
  if (!allowedActions.has(action)) return { status: 400, error: "Unknown party action." };
  const room = member.room;
  const launch = room.currentLaunch;
  if (action === "follow_next") member.catchUpRoundId = event.roundId + 1;
  if (action === "stay") member.catchUpRoundId = null;
  if (action === "leave_follow") {
    if (!event.canFollowNow || event.expiresAt <= Date.now() || !launch || launch.roundId !== event.roundId || !canFollowLobbyNow(room, event.lobby)) {
      return { status: 409, error: "That lobby can no longer accept a safe follow attempt." };
    }
    member.phase = "opening";
    member.gameId = event.lobby.id;
    member.worker = event.lobby.server;
    member.roundId = event.roundId;
    launch.participantIds.add(member.id);
    launch.leftBehindIds.delete(member.id);
    issueJoinCommand(member, launch, Date.now() + JOIN_COMMAND_MS);
  }
  event.acknowledged = true;
  bump(room);
  return { status: 200, action, room: roomSnapshot(room) };
}

function bearerMember(req) {
  const header = String(req.headers.authorization || "");
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (!match) return null;
  return companionTokens.get(tokenHash(match[1])) || null;
}

async function handleCompanionApi(req, res, url) {
  if (req.method === "OPTIONS") { json(res, 204, {}); return true; }
  if (url.pathname === "/api/companion/claim" && req.method === "POST") {
    const body = await readJson(req);
    const ticket = cleanText(body.ticket, 64);
    const hash = tokenHash(ticket);
    const record = companionTickets.get(hash);
    companionTickets.delete(hash);
    if (!record || record.expiresAt < Date.now() || !record.member.room) {
      json(res, 410, { error: "This companion link has expired or was already used." }); return true;
    }
    const member = record.member;
    revokeCompanion(member);
    const token = randomToken();
    const companionHash = tokenHash(token);
    member.companionTokenHash = companionHash;
    member.companionLastSeen = Date.now();
    companionTokens.set(companionHash, member);
    bump(member.room);
    json(res, 200, { companionToken: token, memberId: member.id, cursor: member.eventCursor, revision: member.room.revision, room: roomSnapshot(member.room) });
    return true;
  }
  if (!url.pathname.startsWith("/api/companion/")) return false;
  const member = bearerMember(req);
  if (!member?.room) { json(res, 401, { error: "Companion authorization is missing or expired." }); return true; }
  member.companionLastSeen = Date.now();

  if (url.pathname === "/api/companion/events" && req.method === "GET") {
    const cursor = Math.max(0, Number(url.searchParams.get("cursor")) || 0);
    const revision = Math.max(0, Number(url.searchParams.get("revision")) || 0);
    const events = collectCompanionEvents(member, cursor);
    if (events.length || member.room.revision > revision) {
      json(res, 200, { cursor: Math.max(cursor, member.eventCursor), revision: member.room.revision, serverTime: Date.now(), room: roomSnapshot(member.room), events });
      return true;
    }
    const waiter = { res, cursor, revision, timer: null };
    waiter.timer = setTimeout(() => respondToPoll(member, waiter), LONG_POLL_MS);
    member.pollWaiters.add(waiter);
    req.on("close", () => {
      if (!member.pollWaiters.has(waiter)) return;
      clearTimeout(waiter.timer);
      member.pollWaiters.delete(waiter);
    });
    return true;
  }
  if (url.pathname === "/api/companion/state" && req.method === "POST") {
    const body = await readJson(req);
    if (!updateMemberState(member, body)) { json(res, 400, { error: "Unknown or invalid companion phase." }); return true; }
    json(res, 200, { ok: true, room: roomSnapshot(member.room) });
    return true;
  }
  if (url.pathname === "/api/companion/action" && req.method === "POST") {
    const body = await readJson(req);
    const event = member.events.find((item) => item.eventId === cleanText(body.eventId, 64));
    if (!event) { json(res, 404, { error: "Party notification was not found." }); return true; }
    const result = acknowledgeMovedEvent(member, event, cleanText(body.action, 24));
    json(res, result.status, result.status === 200 ? result : { error: result.error });
    return true;
  }
  json(res, 404, { error: "Unknown companion endpoint." });
  return true;
}

async function handleRequest(req, res) {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  if (await handleCompanionApi(req, res, url)) return;
  if (url.pathname === "/api/groups") {
    const groups = [...rooms.values()]
      .filter((room) => room.isPublic)
      .map((room) => {
        const leader = [...room.members].find((member) => member.role === "leader");
        return {
          code: room.code,
          leader: leader?.name || "Unknown",
          members: room.members.size,
          decisionMode: room.decisionMode,
          selectedLobby: room.selectedLobby ? { name: room.selectedLobby.name, mode: room.selectedLobby.mode, players: room.selectedLobby.players, capacity: room.selectedLobby.capacity } : null,
        };
      })
      .sort((a, b) => b.members - a.members || a.code.localeCompare(b.code));
    json(res, 200, { groups }); return;
  }
  if (url.pathname === "/api/lobbies") { json(res, 200, { source: "demo", updatedAt: new Date().toISOString(), lobbies: demoLobbies }); return; }
  serveFile(req, res);
}

const server = http.createServer((req, res) => {
  handleRequest(req, res).catch((error) => {
    if (res.writableEnded) return;
    json(res, error.status || 500, { error: error.status ? error.message : "Internal relay error." });
  });
});

const wss = new WebSocketServer({ server, maxPayload: MAX_MESSAGE_BYTES });

wss.on("connection", (socket) => {
  let member = makeMember(socket);
  send(socket, { v: 1, type: "session.welcome", clientId: member.id, resumeToken: member.resumeToken, heartbeatMs: HEARTBEAT_MS });

  socket.on("message", (buffer) => {
    member.lastSeen = Date.now();
    member.hits = member.hits.filter((time) => time > Date.now() - 10_000);
    if (member.hits.length >= 30) return sendError(member, "Too many requests; wait a moment.");
    member.hits.push(Date.now());
    let message;
    try { message = JSON.parse(buffer.toString("utf8")); }
    catch { return sendError(member, "Message must be valid JSON."); }
    if (!message || message.v !== 1 || typeof message.type !== "string") return sendError(member, "Unsupported protocol message.");

    if (message.type === "session.resume") {
      const target = sessions.get(cleanText(message.resumeToken, 64));
      if (!target || !target.room || target === member) return send(socket, { v: 1, type: "session.resume_failed", resumeToken: member.resumeToken });
      const provisional = member;
      sessions.delete(provisional.resumeToken);
      provisional.resumeToken = null;
      if (target.socket?.readyState === WebSocket.OPEN) target.socket.close(4001, "Session resumed elsewhere");
      target.socket = socket;
      target.viewerDetachedAt = null;
      target.lastSeen = Date.now();
      member = target;
      rotateViewerSession(member);
      send(socket, { v: 1, type: "session.resumed", clientId: member.id, resumeToken: member.resumeToken, heartbeatMs: HEARTBEAT_MS });
      return bump(member.room);
    }
    if (message.type === "group.create") return createRoom(member, message.name, { isPublic: message.isPublic !== false, decisionMode: message.decisionMode });
    if (message.type === "group.join") {
      const room = rooms.get(cleanText(message.code, 6).toUpperCase());
      if (!room) return sendError(member, "That group code does not exist or has expired.");
      return joinRoom(member, room, message.name);
    }
    if (message.type === "group.leave") return removeMember(member);
    if (message.type === "member.heartbeat") return;
    if (message.type === "member.state") {
      if (!allowed(member, message.type)) return;
      const aliases = { "opening-game": "opening", "in-game": "in_game", "wants-to-join": "ready", away: "watching", left: "watching" };
      const state = cleanText(message.state, 24);
      return updateMemberState(member, { ...message, phase: aliases[state] || state }) || sendError(member, "Unknown member state.");
    }
    if (message.type === "member.filters") {
      if (!allowed(member, message.type)) return;
      member.filterPreference = cleanFilterPreference(message.filterPreference);
      return bump(member.room);
    }
    if (message.type === "member.observe_lobby") {
      if (!allowed(member, message.type)) return;
      const lobby = validLobby(message.lobby);
      const observedAt = Number(message.observedAt);
      if (!lobby || !Number.isFinite(observedAt) || Math.abs(Date.now() - observedAt) > MAX_LOBBY_OBSERVATION_AGE_MS) {
        return sendError(member, "Ignored an invalid or stale lobby observation.");
      }
      member.room.lobbyObservations.set(lobbyKey(lobby), {
        lobby,
        receivedAt: Date.now(),
        observedAt,
        memberId: member.id,
      });
      return;
    }
    if (message.type === "member.vote_lobby") {
      if (!allowed(member, message.type)) return;
      if (member.room.decisionMode !== "democracy") return sendError(member, "Voting is only available in Democracy mode.");
      const lobby = validLobby(message.lobby);
      if (!lobby) return sendError(member, "Vote for a lobby from the current lobby feed.");
      member.room.votes.set(member.id, lobby);
      recomputeDemocracy(member.room);
      for (const item of member.room.members) send(item.socket, { v: 1, type: "group.lobby_vote", lobby, voter: publicMember(member) });
      return bump(member.room);
    }
    if (message.type === "leader.set_decision_mode") {
      if (!allowed(member, message.type)) return;
      const decisionMode = cleanText(message.decisionMode, 16);
      if (!new Set(["dictator", "democracy"]).has(decisionMode)) return sendError(member, "Unknown decision mode.");
      if (member.room.decisionMode === decisionMode) return;
      member.room.decisionMode = decisionMode;
      member.room.votes.clear();
      member.room.selectedLobby = null;
      member.room.hoveredLobbyId = null;
      return bump(member.room);
    }
    if (message.type === "leader.set_visibility") {
      if (!allowed(member, message.type)) return;
      const isPublic = message.isPublic === true;
      if (member.room.isPublic === isPublic) return;
      member.room.isPublic = isPublic;
      return bump(member.room);
    }
    if (message.type === "member.suggest_lobby") {
      if (!allowed(member, message.type)) return;
      const lobby = validLobby(message.lobby);
      if (!lobby) return sendError(member, "Suggest a lobby from the current lobby feed.");
      for (const item of member.room.members) send(item.socket, { v: 1, type: "group.lobby_suggestion", lobby, proposer: publicMember(member), selected: false });
      return;
    }
    if (message.type === "leader.select_lobby") {
      if (!allowed(member, message.type)) return;
      if (member.room.decisionMode !== "dictator") return sendError(member, "Use voting to choose a lobby in Democracy mode.");
      const lobby = validLobby(message.lobby);
      if (!lobby) return sendError(member, "Select a lobby from the current lobby feed.");
      member.room.selectedLobby = lobby;
      for (const item of member.room.members) send(item.socket, { v: 1, type: "group.lobby_suggestion", lobby, proposer: publicMember(member), selected: true });
      return bump(member.room);
    }
    if (message.type === "leader.hover_lobby") {
      if (!allowed(member, message.type)) return;
      const lobby = validLobby(message.lobby);
      if (!lobby) return sendError(member, "Hover a current public lobby.");
      if (member.room.hoveredLobbyId === lobby.id) return;
      member.room.hoveredLobbyId = lobby.id;
      return bump(member.room);
    }
    if (message.type === "leader.clear_hover") {
      if (!allowed(member, message.type)) return;
      if (member.room.hoveredLobbyId === null) return;
      member.room.hoveredLobbyId = null;
      return bump(member.room);
    }
    if (message.type === "leader.transfer") {
      if (!allowed(member, message.type)) return;
      const target = [...member.room.members].find((item) => item.id === message.memberId);
      if (!target || target === member) return sendError(member, "Choose another current member.");
      member.role = "member";
      target.role = "leader";
      return bump(member.room);
    }
    if (message.type === "companion.ticket.create") {
      if (!allowed(member, message.type)) return;
      return issueCompanionTicket(member);
    }
    if (message.type === "leader.launch") return launchParty(member, message);
    sendError(member, "Unknown message type.");
  });

  socket.on("close", () => {
    if (member.socket !== socket) return;
    if (member.room) detachViewer(member);
    else removeMember(member, true);
  });
});

setInterval(() => {
  const now = Date.now();
  for (const [hash, ticket] of companionTickets) if (ticket.expiresAt < now) companionTickets.delete(hash);
  for (const room of [...rooms.values()]) {
    for (const member of [...room.members]) {
      if (member.socket && member.lastSeen < now - STALE_VIEWER_MS) member.socket.terminate();
      const viewerGone = member.viewerDetachedAt && member.viewerDetachedAt < now - VIEWER_RECONNECT_GRACE_MS;
      const companionGone = !member.companionTokenHash || member.companionLastSeen < now - COMPANION_GRACE_MS;
      if (viewerGone && companionGone) removeMember(member, true);
    }
  }
}, HEARTBEAT_MS);

server.listen(PORT, HOST, () => console.log(`OpenFront pre-lobby available at http://${HOST}:${PORT}`));
