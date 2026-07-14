// ==UserScript==
// @name         OpenFront Party Companion
// @namespace    openfront-party-coordinator
// @version      0.4.0
// @description  Keeps an opt-in party connected and shares finalized match summaries with the party history.
// @match        https://openfront.io/*
// @run-at       document-start
// @noframes
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_addStyle
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// @connect      localhost
// @connect      127.0.0.1
// @connect      *
// ==/UserScript==

(() => {
  "use strict";

  const STORAGE_KEY = "openfront-party-companion-session";
  const POSITION_KEY = "openfront-party-companion-position";
  const PROCESSED_KEY = "openfront-party-processed-commands";
  const TELEMETRY_KEY = "openfront-party-match-telemetry-v1";
  const DEFAULT_RELAY = "http://localhost:3030";
  const phaseLabels = {
    watching: "Lobby board",
    opening: "Opening lobby",
    in_lobby: "In lobby",
    in_game: "In game",
    finished: "Finished",
    ready: "Ready",
    failed: "Needs attention",
  };

  let credential = GM_getValue(STORAGE_KEY, null);
  let cursor = 0;
  let revision = 0;
  let room = null;
  let connected = false;
  let polling = false;
  let lastReported = "";
  let detected = { phase: "watching", gameId: null, worker: null };
  let manualReadyKey = null;
  let pendingCommand = null;
  let collapsed = true;
  let root;
  let body;
  let telemetry = null;
  let telemetryClientId = null;
  let telemetryPlayerId = null;
  let uploadingTelemetry = false;
  let pendingBuilds = [];
  const seenUnitIds = new Set();
  const persistentEvents = new Map();
  const acknowledgedEventIds = new Set();
  const processedCommands = new Set(GM_getValue(PROCESSED_KEY, []));

  const updateTypes = Object.freeze({ unit: 1, player: 2, win: 10, donate: 24 });
  const trackedUnits = new Map([
    ["Port", "portsBuilt"],
    ["Factory", "factoriesBuilt"],
    ["Atom Bomb", "atomBombsBuilt"],
    ["Hydrogen Bomb", "hydrogenBombsBuilt"],
  ]);

  function decimal(value) {
    try { return BigInt(value ?? 0).toString(); }
    catch { return "0"; }
  }

  function addDecimal(left, right) {
    try { return (BigInt(left || 0) + BigInt(right || 0)).toString(); }
    catch { return decimal(left); }
  }

  function telemetryStore() {
    const stored = GM_getValue(TELEMETRY_KEY, {});
    return stored && typeof stored === "object" && !Array.isArray(stored) ? stored : {};
  }

  function beginTelemetry(gameId) {
    if (!gameId) return;
    const store = telemetryStore();
    telemetry = store[gameId] || {
      gameId,
      startedAt: Date.now(),
      updatedAt: Date.now(),
      donatedTroops: "0",
      donatedGold: "0",
      portsBuilt: 0,
      factoriesBuilt: 0,
      atomBombsBuilt: 0,
      hydrogenBombsBuilt: 0,
      atomBombGoldSpent: "0",
      hydrogenBombGoldSpent: "0",
      goldGenerated: null,
      goldBreakdown: null,
      finalized: false,
    };
    telemetryClientId = telemetry.clientId || null;
    telemetryPlayerId = Number.isInteger(telemetry.playerId) ? telemetry.playerId : null;
  }

  function saveTelemetry() {
    if (!telemetry?.gameId) return;
    telemetry.updatedAt = Date.now();
    telemetry.clientId = telemetryClientId;
    telemetry.playerId = telemetryPlayerId;
    const store = telemetryStore();
    store[telemetry.gameId] = telemetry;
    const entries = Object.entries(store).sort((a, b) => Number(b[1]?.updatedAt || 0) - Number(a[1]?.updatedAt || 0));
    GM_setValue(TELEMETRY_KEY, Object.fromEntries(entries.slice(0, 20)));
    render();
  }

  function sumDecimals(values) {
    return (values || []).reduce((total, value) => addDecimal(total, value), "0");
  }

  function winnerIncludesClient(winner) {
    if (!Array.isArray(winner) || !telemetryClientId) return null;
    if (winner[0] === "player") return winner.slice(1).includes(telemetryClientId);
    if (winner[0] === "team" || winner[0] === "nation") return winner.slice(2).includes(telemetryClientId);
    return null;
  }

  function historyPayload(match) {
    return {
      gameId: match.gameId,
      finalized: true,
      startedAt: match.startedAt,
      endedAt: match.endedAt,
      won: match.won,
      finalTiles: match.finalTiles || 0,
      attackTroops: match.attackTroops || "0",
      donatedTroops: match.donatedTroops || "0",
      donatedGold: match.donatedGold || "0",
      goldGenerated: match.goldGenerated || "0",
      nukeGoldSpent: addDecimal(match.atomBombGoldSpent, match.hydrogenBombGoldSpent),
      portsBuilt: match.portsBuilt || 0,
      factoriesBuilt: match.factoriesBuilt || 0,
      atomBombs: match.atomBombsBuilt || 0,
      atomBombsLanded: match.atomBombsLanded || 0,
      hydrogenBombs: match.hydrogenBombsBuilt || 0,
      hydrogenBombsLanded: match.hydrogenBombsLanded || 0,
    };
  }

  async function uploadFinalizedTelemetry() {
    if (!credential || uploadingTelemetry || !telemetry?.finalized || telemetry.uploadedAt) return;
    uploadingTelemetry = true;
    try {
      await api("/api/companion/matches", { method: "POST", data: historyPayload(telemetry), timeout: 10_000 });
      telemetry.uploadedAt = Date.now();
      telemetry.uploadError = null;
      saveTelemetry();
    } catch (error) {
      telemetry.uploadError = error.message;
      saveTelemetry();
    } finally {
      uploadingTelemetry = false;
    }
  }

  function finalizeTelemetry(allPlayersStats, winner) {
    if (!telemetry || !telemetryClientId || !allPlayersStats) return;
    const stats = allPlayersStats[telemetryClientId];
    if (!stats) return;
    const gold = (stats.gold || []).map(decimal);
    telemetry.goldBreakdown = {
      workers: gold[0] || "0",
      conquest: gold[1] || "0",
      tradeShips: gold[2] || "0",
      capturedTrade: gold[3] || "0",
      ownTrains: gold[4] || "0",
      otherTrains: gold[5] || "0",
    };
    telemetry.goldGenerated = sumDecimals(Object.values(telemetry.goldBreakdown));
    telemetry.finalTiles = Number(stats.finalTiles || 0);
    telemetry.attackTroops = decimal(stats.attacks?.[0]);
    telemetry.portsBuilt = Number(stats.units?.port?.[0] || telemetry.portsBuilt || 0);
    telemetry.factoriesBuilt = Number(stats.units?.fact?.[0] || telemetry.factoriesBuilt || 0);
    telemetry.atomBombsBuilt = Number(stats.bombs?.abomb?.[0] || telemetry.atomBombsBuilt || 0);
    telemetry.hydrogenBombsBuilt = Number(stats.bombs?.hbomb?.[0] || telemetry.hydrogenBombsBuilt || 0);
    telemetry.atomBombsLanded = Number(stats.bombs?.abomb?.[1] || 0);
    telemetry.hydrogenBombsLanded = Number(stats.bombs?.hbomb?.[1] || 0);
    telemetry.atomBombGoldSpent = telemetry.infiniteGold ? "0" : (BigInt(telemetry.atomBombsBuilt) * 750_000n).toString();
    telemetry.hydrogenBombGoldSpent = telemetry.infiniteGold ? "0" : (BigInt(telemetry.hydrogenBombsBuilt) * 5_000_000n).toString();
    telemetry.won = winnerIncludesClient(winner);
    telemetry.endedAt = Date.now();
    telemetry.finalized = true;
    saveTelemetry();
    void uploadFinalizedTelemetry();
  }

  function processTurn(turn) {
    if (!telemetryClientId || !turn?.intents) return;
    for (const intent of turn.intents) {
      if (intent.clientID !== telemetryClientId || intent.type !== "build_unit" || !trackedUnits.has(intent.unit)) continue;
      pendingBuilds.push({ unit: intent.unit, turn: Number(turn.turnNumber) || 0 });
    }
  }

  function processServerMessage(message) {
    if (!message || typeof message !== "object") return;
    if (message.type === "start") {
      const gameId = message.gameStartInfo?.gameID || gameRoute().gameId;
      beginTelemetry(gameId);
      telemetryClientId = message.myClientID || telemetryClientId;
      telemetry.infiniteGold = Boolean(message.gameStartInfo?.config?.infiniteGold);
      telemetry.hostInfiniteGold = Boolean(message.gameStartInfo?.config?.hostCheats?.infiniteGold);
      for (const turn of message.turns || []) processTurn(turn);
      saveTelemetry();
    } else if (message.type === "turn") {
      processTurn(message.turn);
    }
  }

  function confirmBuiltUnit(update) {
    if (!telemetry || telemetryPlayerId === null || update?.ownerID !== telemetryPlayerId || !trackedUnits.has(update.unitType)) return;
    if (seenUnitIds.has(update.id)) return;
    seenUnitIds.add(update.id);
    const pendingIndex = pendingBuilds.findIndex((item) => item.unit === update.unitType);
    if (pendingIndex === -1) return;
    pendingBuilds.splice(pendingIndex, 1);
    const metric = trackedUnits.get(update.unitType);
    telemetry[metric] = Number(telemetry[metric] || 0) + 1;
    if (!telemetry.infiniteGold && update.unitType === "Atom Bomb") telemetry.atomBombGoldSpent = addDecimal(telemetry.atomBombGoldSpent, 750_000);
    if (!telemetry.infiniteGold && update.unitType === "Hydrogen Bomb") telemetry.hydrogenBombGoldSpent = addDecimal(telemetry.hydrogenBombGoldSpent, 5_000_000);
    saveTelemetry();
  }

  function processGameUpdate(update) {
    const groups = update?.updates;
    if (!groups) return;
    for (const player of groups[updateTypes.player] || []) {
      if (player.clientID && player.clientID === telemetryClientId) {
        telemetryPlayerId = player.id;
        if (player.isLobbyCreator && telemetry?.hostInfiniteGold) telemetry.infiniteGold = true;
      }
    }
    for (const donation of groups[updateTypes.donate] || []) {
      if (!telemetry || telemetryPlayerId === null || donation.senderId !== telemetryPlayerId) continue;
      const key = donation.donationType === "troops" ? "donatedTroops" : "donatedGold";
      telemetry[key] = addDecimal(telemetry[key], donation.amount);
      saveTelemetry();
    }
    for (const unit of groups[updateTypes.unit] || []) confirmBuiltUnit(unit);
    for (const win of groups[updateTypes.win] || []) finalizeTelemetry(win.allPlayersStats, win.winner);
    const tick = Number(update.tick) || 0;
    pendingBuilds = pendingBuilds.filter((item) => tick - item.turn <= 20);
  }

  function processWorkerMessage(data) {
    if (data?.type !== "game_update_batch" || !Array.isArray(data.gameUpdates)) return;
    for (const update of data.gameUpdates) processGameUpdate(update);
  }

  function installTelemetryHooks() {
    const page = typeof unsafeWindow === "object" ? unsafeWindow : window;
    const OriginalWebSocket = page.WebSocket;
    if (OriginalWebSocket && !OriginalWebSocket.__openFrontPartyTelemetry) {
      const WrappedWebSocket = new Proxy(OriginalWebSocket, {
        construct(target, args, newTarget) {
          const socket = Reflect.construct(target, args, newTarget);
          const url = String(args[0] || "");
          if (/\/w\d+(?:\?|$)/.test(url) && !/\/lobbies(?:\?|$)/.test(url)) {
            socket.addEventListener("message", (event) => {
              try { processServerMessage(JSON.parse(event.data)); } catch {}
            });
            const send = socket.send;
            socket.send = function (data) {
              try {
                const message = JSON.parse(data);
                if (message.type === "winner") finalizeTelemetry(message.allPlayersStats, message.winner);
              } catch {}
              return send.call(this, data);
            };
          }
          return socket;
        },
      });
      Object.defineProperty(WrappedWebSocket, "__openFrontPartyTelemetry", { value: true });
      page.WebSocket = WrappedWebSocket;
    }

    const OriginalWorker = page.Worker;
    if (OriginalWorker && !OriginalWorker.__openFrontPartyTelemetry) {
      const WrappedWorker = new Proxy(OriginalWorker, {
        construct(target, args, newTarget) {
          const worker = Reflect.construct(target, args, newTarget);
          worker.addEventListener("message", (event) => processWorkerMessage(event.data));
          return worker;
        },
      });
      Object.defineProperty(WrappedWorker, "__openFrontPartyTelemetry", { value: true });
      page.Worker = WrappedWorker;
    }
  }

  function safeRelay(value) {
    try {
      const url = new URL(value || DEFAULT_RELAY);
      if (!new Set(["http:", "https:"]).has(url.protocol)) throw new Error("Unsupported relay protocol");
      return url.origin;
    } catch {
      return DEFAULT_RELAY;
    }
  }

  function safeViewer(value) {
    try {
      const url = new URL(value || "");
      if (!new Set(["http:", "https:"]).has(url.protocol)) return null;
      return url.href;
    } catch {
      return null;
    }
  }

  function request({ method = "GET", url, data, token, timeout = 25_000 }) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method,
        url,
        timeout,
        headers: {
          Accept: "application/json",
          ...(data ? { "Content-Type": "application/json" } : {}),
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        data: data ? JSON.stringify(data) : undefined,
        onload(response) {
          let payload = {};
          try { payload = response.responseText ? JSON.parse(response.responseText) : {}; }
          catch { reject(new Error("Relay returned invalid JSON.")); return; }
          if (response.status < 200 || response.status >= 300) {
            const error = new Error(payload.error || `Relay request failed (${response.status}).`);
            error.status = response.status;
            reject(error);
            return;
          }
          resolve(payload);
        },
        onerror: () => reject(new Error("Party relay is unreachable.")),
        ontimeout: () => reject(new Error("Party relay request timed out.")),
      });
    });
  }

  function api(path, options = {}) {
    if (!credential) return Promise.reject(new Error("Companion is not linked."));
    return request({
      ...options,
      url: `${credential.relayOrigin}${path}`,
      token: credential.companionToken,
    });
  }

  function currentMember() {
    return room?.members?.find((member) => member.id === credential?.memberId) || null;
  }

  function gameRoute() {
    const match = location.pathname.match(/^\/(?:((?:w\d+))\/)?game\/([^/]+)/);
    return match ? { worker: match[1] || null, gameId: match[2] } : { worker: null, gameId: null };
  }

  beginTelemetry(gameRoute().gameId);
  installTelemetryHooks();

  function openFrontLobbyAcknowledged(route) {
    if (!route.gameId) return false;
    const modal = document.querySelector("join-lobby-modal");
    if (!modal) return false;
    return String(modal.currentLobbyId || "") === route.gameId && Boolean(modal.currentClientID);
  }

  function winSurfaceVisible() {
    if (location.search.includes("replay")) return true;
    const modal = document.querySelector("win-modal");
    if (!modal) return false;
    if (modal.isVisible === true) return true;
    if (!modal.textContent.trim()) return false;
    const rect = modal.getBoundingClientRect();
    const style = getComputedStyle(modal);
    return style.display !== "none" && style.visibility !== "hidden" && (rect.width > 0 || rect.height > 0);
  }

  function detectPhase() {
    const route = gameRoute();
    const contextKey = route.gameId || "watching";
    let phase;
    if (manualReadyKey === contextKey) phase = "ready";
    else if (winSurfaceVisible()) phase = "finished";
    else if (document.body?.classList.contains("in-game")) phase = "in_game";
    else if (openFrontLobbyAcknowledged(route)) phase = "in_lobby";
    else if (route.gameId) phase = "opening";
    else phase = "watching";
    const next = { phase, gameId: route.gameId, worker: route.worker };
    const changed = JSON.stringify(next) !== JSON.stringify(detected);
    detected = next;
    if (changed) {
      if (phase === "finished") collapsed = false;
      reportState();
      render();
    }
  }

  async function reportState(force = false) {
    if (!credential) return;
    const member = currentMember();
    const payload = {
      phase: detected.phase,
      gameId: detected.gameId,
      worker: detected.worker || member?.worker || null,
      roundId: member?.roundId || room?.roundId || 0,
    };
    const signature = JSON.stringify(payload);
    if (!force && signature === lastReported) return;
    lastReported = signature;
    try {
      const response = await api("/api/companion/state", { method: "POST", data: payload, timeout: 8_000 });
      if (response.room) room = response.room;
      connected = true;
      render();
      void uploadFinalizedTelemetry();
    } catch (error) {
      connected = false;
      if (error.status === 401) unlink(false);
      render(error.message);
    }
  }

  function rememberCommand(commandId) {
    processedCommands.add(commandId);
    while (processedCommands.size > 40) processedCommands.delete(processedCommands.values().next().value);
    GM_setValue(PROCESSED_KEY, [...processedCommands]);
  }

  function officialGameUrl(event) {
    const workerPath = /^w\d+$/.test(String(event.worker || "")) ? String(event.worker) : "w0";
    return `https://openfront.io/${encodeURIComponent(workerPath)}/game/${encodeURIComponent(event.gameId)}`;
  }

  async function handleJoinCommand(event) {
    if (!event.commandId || processedCommands.has(event.commandId)) return;
    if (Number(event.expiresAt) <= Date.now()) {
      rememberCommand(event.commandId);
      return;
    }
    if (detected.phase !== "ready") {
      pendingCommand = event;
      collapsed = false;
      render();
      return;
    }
    pendingCommand = null;
    rememberCommand(event.commandId);
    detected.phase = "opening";
    await reportState(true);
    location.href = officialGameUrl(event);
  }

  function ingestEvents(events = []) {
    for (const event of events) {
      if (event.type === "join.command") void handleJoinCommand(event);
      if (event.type === "party.moved" && !event.acknowledged && !acknowledgedEventIds.has(event.eventId)) {
        persistentEvents.set(event.eventId, event);
        collapsed = false;
      }
      if (event.type === "member.ready_for_regroup") {
        collapsed = false;
        transientNotice(`${event.member?.name || "A party member"} is ready to regroup.`);
      }
    }
  }

  async function poll() {
    if (!credential || polling) return;
    polling = true;
    while (credential) {
      try {
        const response = await api(`/api/companion/events?cursor=${cursor}&revision=${revision}`);
        cursor = Number(response.cursor) || cursor;
        revision = Number(response.revision) || revision;
        room = response.room;
        connected = true;
        ingestEvents(response.events);
        detectPhase();
        render();
        void uploadFinalizedTelemetry();
      } catch (error) {
        connected = false;
        render(error.message);
        if (error.status === 401) { unlink(false); break; }
        await new Promise((resolve) => setTimeout(resolve, 2_000));
      }
    }
    polling = false;
  }

  async function claimTicket(ticket, relayOrigin, viewerUrl) {
    try {
      const response = await request({
        method: "POST",
        url: `${relayOrigin}/api/companion/claim`,
        data: { ticket },
        timeout: 10_000,
      });
      credential = {
        relayOrigin,
        viewerUrl: safeViewer(viewerUrl),
        companionToken: response.companionToken,
        memberId: response.memberId,
      };
      cursor = Number(response.cursor) || 0;
      revision = Number(response.revision) || 0;
      room = response.room;
      connected = true;
      GM_setValue(STORAGE_KEY, credential);
      collapsed = false;
      render();
      detectPhase();
      await reportState(true);
      void uploadFinalizedTelemetry();
      void poll();
    } catch (error) {
      credential = null;
      GM_deleteValue(STORAGE_KEY);
      render(error.message);
    }
  }

  function consumeConnectFragment() {
    const params = new URLSearchParams(location.hash.replace(/^#/, ""));
    const ticket = params.get("party-connect");
    if (!ticket) return false;
    const relayOrigin = safeRelay(params.get("party-relay"));
    const viewerUrl = safeViewer(params.get("party-viewer"));
    params.delete("party-connect");
    params.delete("party-relay");
    params.delete("party-viewer");
    const remaining = params.toString();
    history.replaceState(null, "", `${location.pathname}${location.search}${remaining ? `#${remaining}` : ""}`);
    void claimTicket(ticket, relayOrigin, viewerUrl);
    return true;
  }

  function unlink(renderAfter = true) {
    credential = null;
    room = null;
    connected = false;
    cursor = 0;
    revision = 0;
    persistentEvents.clear();
    GM_deleteValue(STORAGE_KEY);
    if (renderAfter) render();
  }

  async function movedAction(event, action) {
    if (action === "leave_follow" && !confirm("Leave the current game and follow the party now?")) return;
    try {
      await api("/api/companion/action", { method: "POST", data: { eventId: event.eventId, action }, timeout: 8_000 });
      acknowledgedEventIds.add(event.eventId);
      persistentEvents.delete(event.eventId);
      if (action === "follow_next") manualReadyKey = null;
      render();
    } catch (error) {
      render(error.message);
    }
  }

  function markReady() {
    manualReadyKey = detected.gameId || "watching";
    detected.phase = "ready";
    pendingCommand && Number(pendingCommand.expiresAt) > Date.now()
      ? void handleJoinCommand(pendingCommand)
      : void reportState(true);
    render();
  }

  function transientNotice(message) {
    if (!root) return;
    const notice = document.createElement("div");
    notice.className = "ofpc-transient";
    notice.textContent = message;
    root.append(notice);
    setTimeout(() => notice.remove(), 5_000);
  }

  function button(label, onClick, className = "") {
    const node = document.createElement("button");
    node.type = "button";
    node.className = className;
    node.textContent = label;
    node.addEventListener("click", onClick);
    return node;
  }

  function compactNumber(value) {
    let amount;
    try { amount = BigInt(value ?? 0); } catch { return "0"; }
    const units = [[1_000_000_000n, "B"], [1_000_000n, "M"], [1_000n, "K"]];
    for (const [size, suffix] of units) {
      if (amount < size) continue;
      const whole = amount / size;
      const decimalPart = (amount % size) * 10n / size;
      return `${whole}${decimalPart ? `.${decimalPart}` : ""}${suffix}`;
    }
    return amount.toString();
  }

  function renderTelemetry(container) {
    if (!telemetry || telemetry.gameId !== gameRoute().gameId) return;
    const card = document.createElement("section");
    card.className = "ofpc-telemetry";
    const title = document.createElement("strong");
    title.textContent = `MATCH DATA · ${telemetry.gameId}`;
    const grid = document.createElement("div");
    const metrics = [
      ["Troops donated", compactNumber(telemetry.donatedTroops)],
      ["Gold donated", compactNumber(telemetry.donatedGold)],
      ["Ports", String(telemetry.portsBuilt || 0)],
      ["Factories", String(telemetry.factoriesBuilt || 0)],
      ["Atom bombs", String(telemetry.atomBombsBuilt || 0)],
      ["Hydrogen bombs", String(telemetry.hydrogenBombsBuilt || 0)],
      ["Nuke gold spent", compactNumber(addDecimal(telemetry.atomBombGoldSpent, telemetry.hydrogenBombGoldSpent))],
      ["Gold generated", telemetry.finalized ? compactNumber(telemetry.goldGenerated) : "Finalizing…"],
    ];
    for (const [label, value] of metrics) {
      const item = document.createElement("div");
      const name = document.createElement("small");
      const number = document.createElement("b");
      name.textContent = label;
      number.textContent = value;
      item.append(name, number);
      grid.append(item);
    }
    const note = document.createElement("p");
    note.textContent = telemetry.finalized
      ? (telemetry.uploadedAt ? "Final values shared with Match History and stored locally." : "Final values stored locally; Match History upload is pending.")
      : "Live local counters. Total generated gold is confirmed when the match ends.";
    card.append(title, grid, note);
    container.append(card);
  }

  function renderMovedEvent(container, event) {
    const card = document.createElement("section");
    card.className = "ofpc-moved";
    const moved = event.movedMembers?.length || 0;
    const remaining = event.remainingMembers?.length || 1;
    const heading = document.createElement("strong");
    heading.textContent = "PARTY MOVED";
    const text = document.createElement("p");
    text.textContent = `${moved} party member${moved === 1 ? "" : "s"} started ${event.lobby?.name || "a new match"}. ${remaining} remain in the previous game.`;
    const actions = document.createElement("div");
    actions.append(
      button("Follow next round", () => movedAction(event, "follow_next"), "primary"),
      button("Leave and follow now", () => movedAction(event, "leave_follow")),
      button("Stay", () => movedAction(event, "stay")),
    );
    const followNow = actions.children[1];
    followNow.disabled = !event.canFollowNow || Number(event.expiresAt) <= Date.now();
    card.append(heading, text, actions);
    container.append(card);
  }

  function render(error = "") {
    if (!root || !body) return;
    root.classList.toggle("collapsed", collapsed);
    body.replaceChildren();
    const member = currentMember();

    if (!credential) {
      const empty = document.createElement("p");
      empty.className = "ofpc-empty";
      empty.textContent = error || "Open the party viewer and choose Connect OpenFront.";
      body.append(empty);
      return;
    }

    if (error) {
      const problem = document.createElement("div");
      problem.className = "ofpc-error";
      problem.textContent = error;
      body.append(problem);
    }
    for (const event of persistentEvents.values()) renderMovedEvent(body, event);

    const summary = document.createElement("div");
    summary.className = "ofpc-summary";
    summary.innerHTML = `<span>${connected ? "●" : "○"} ${connected ? "Connected" : "Reconnecting"}</span><strong>${room?.members?.length || 0} members</strong><small>${phaseLabels[detected.phase] || detected.phase}</small>`;
    body.append(summary);

    renderTelemetry(body);

    if (pendingCommand && detected.phase !== "ready") {
      const pending = document.createElement("div");
      pending.className = "ofpc-pending";
      pending.textContent = `Party selected ${pendingCommand.lobby?.name || "a lobby"}. Mark Ready before the command expires.`;
      body.append(pending);
    }

    const squad = document.createElement("section");
    squad.className = "ofpc-squad";
    const label = document.createElement("strong");
    label.textContent = `SQUAD · ROUND ${room?.roundId || 0}`;
    squad.append(label);
    for (const item of room?.members || []) {
      const row = document.createElement("div");
      row.innerHTML = `<span class="dot ${item.phase}"></span><b>${item.name}</b><small>${phaseLabels[item.phase] || item.phase}${item.roundId ? ` · R${item.roundId}` : ""}</small>`;
      squad.append(row);
    }
    body.append(squad);

    const actions = document.createElement("div");
    actions.className = "ofpc-actions";
    if (["watching", "finished", "failed"].includes(detected.phase)) actions.append(button("Ready for next game", markReady, "primary"));
    if (detected.phase === "ready") {
      const ready = button("Ready", () => {}, "primary");
      ready.disabled = true;
      actions.append(ready);
    }
    const board = document.createElement("a");
    board.href = credential.viewerUrl || `${credential.relayOrigin}/viewer/`;
    board.target = "_blank";
    board.rel = "noreferrer";
    board.textContent = "Open party board";
    actions.append(board, button("Unlink", () => unlink()));
    body.append(actions);

    if (member?.catchUpRoundId) {
      const regroup = document.createElement("p");
      regroup.className = "ofpc-regroup";
      regroup.textContent = `Regroup requested for round ${member.catchUpRoundId}.`;
      body.append(regroup);
    }
  }

  function installUi() {
    if (root || !document.body) return;
    root = document.createElement("aside");
    root.id = "openfront-party-companion";
    root.className = "collapsed";
    const header = document.createElement("header");
    const title = document.createElement("div");
    title.innerHTML = `<span class="ofpc-status"></span><strong>PARTY</strong><small>COMPANION</small>`;
    const collapse = button("⌄", () => { collapsed = !collapsed; render(); }, "ofpc-collapse");
    header.append(title, collapse);
    body = document.createElement("div");
    body.className = "ofpc-body";
    root.append(header, body);
    document.body.append(root);

    const saved = GM_getValue(POSITION_KEY, null);
    if (saved && Number.isFinite(saved.left) && Number.isFinite(saved.top)) {
      root.style.left = `${saved.left}px`;
      root.style.top = `${saved.top}px`;
      root.style.transform = "none";
    }
    let drag = null;
    header.addEventListener("pointerdown", (event) => {
      if (event.target.closest("button")) return;
      const rect = root.getBoundingClientRect();
      drag = { x: event.clientX - rect.left, y: event.clientY - rect.top };
      header.setPointerCapture(event.pointerId);
    });
    header.addEventListener("pointermove", (event) => {
      if (!drag) return;
      const left = Math.max(4, Math.min(innerWidth - root.offsetWidth - 4, event.clientX - drag.x));
      const top = Math.max(4, Math.min(innerHeight - 46, event.clientY - drag.y));
      root.style.left = `${left}px`;
      root.style.top = `${top}px`;
      root.style.transform = "none";
    });
    header.addEventListener("pointerup", () => {
      if (!drag) return;
      drag = null;
      const rect = root.getBoundingClientRect();
      GM_setValue(POSITION_KEY, { left: rect.left, top: rect.top });
    });
    render();
  }

  GM_addStyle(`
    #openfront-party-companion { all: initial; position: fixed; top: 14px; left: 50%; z-index: 2147483000; width: min(380px, calc(100vw - 24px)); color: #e7f1ff; background: rgba(11,20,33,.97); border: 1px solid rgba(98,176,255,.4); border-radius: 12px; box-shadow: 0 16px 46px rgba(0,0,0,.55); transform: translateX(-50%); font-family: Inter,system-ui,sans-serif; font-size: 12px; }
    #openfront-party-companion * { box-sizing: border-box; }
    #openfront-party-companion > header { display:flex; align-items:center; gap:10px; height:42px; padding:0 10px; border-bottom:1px solid rgba(148,163,184,.18); cursor:move; user-select:none; }
    #openfront-party-companion > header > div { display:flex; align-items:center; gap:7px; margin-right:auto; }
    #openfront-party-companion > header strong { font-size:12px; letter-spacing:.08em; }
    #openfront-party-companion > header small { padding:2px 5px; border-radius:99px; color:#9fb2c9; background:#172438; font:700 8px ui-monospace,monospace; }
    #openfront-party-companion .ofpc-status { width:8px; height:8px; border-radius:50%; background:#4ade80; box-shadow:0 0 9px rgba(74,222,128,.7); }
    #openfront-party-companion button, #openfront-party-companion a { min-height:30px; padding:6px 9px; border:1px solid rgba(148,163,184,.28); border-radius:7px; color:#e7f1ff; background:#18283d; font:700 10px Inter,system-ui,sans-serif; text-align:center; text-decoration:none; cursor:pointer; }
    #openfront-party-companion button:hover, #openfront-party-companion a:hover { background:#213750; }
    #openfront-party-companion button:disabled { cursor:default; opacity:.55; }
    #openfront-party-companion button.primary { border-color:rgba(74,222,128,.55); color:#dcffe9; background:rgba(20,83,45,.78); }
    #openfront-party-companion .ofpc-collapse { min-width:28px; min-height:26px; padding:2px; font-size:16px; }
    #openfront-party-companion.collapsed .ofpc-body { display:none; }
    #openfront-party-companion.collapsed > header { border-bottom:0; }
    #openfront-party-companion .ofpc-body { display:grid; gap:9px; max-height:min(560px,calc(100vh - 70px)); padding:10px; overflow:auto; }
    #openfront-party-companion .ofpc-summary { display:grid; grid-template-columns:1fr auto; gap:3px 8px; padding:8px; border:1px solid rgba(148,163,184,.18); border-radius:8px; }
    #openfront-party-companion .ofpc-summary span { color:#74e9a0; font-weight:700; }
    #openfront-party-companion .ofpc-summary small { grid-column:1/-1; color:#9fb2c9; }
    #openfront-party-companion .ofpc-telemetry { display:grid; gap:7px; padding:8px; border:1px solid rgba(98,176,255,.24); border-radius:8px; background:rgba(12,27,44,.72); }
    #openfront-party-companion .ofpc-telemetry > strong { color:#62b0ff; font-size:9px; letter-spacing:.1em; }
    #openfront-party-companion .ofpc-telemetry > div { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:5px; }
    #openfront-party-companion .ofpc-telemetry > div > div { display:grid; gap:2px; min-width:0; padding:6px; border-radius:6px; background:rgba(20,31,48,.82); }
    #openfront-party-companion .ofpc-telemetry small { overflow:hidden; color:#9fb2c9; font-size:8px; text-overflow:ellipsis; white-space:nowrap; }
    #openfront-party-companion .ofpc-telemetry b { color:#edf6ff; font:700 12px ui-monospace,monospace; }
    #openfront-party-companion .ofpc-telemetry p { margin:0; color:#8298b2; font-size:8px; line-height:1.4; }
    #openfront-party-companion .ofpc-moved { padding:10px; border:1px solid rgba(251,191,36,.58); border-radius:9px; background:rgba(71,49,8,.48); animation:ofpc-slide .22s ease-out; }
    #openfront-party-companion .ofpc-moved > strong { color:#ffd66e; font-size:10px; letter-spacing:.1em; }
    #openfront-party-companion .ofpc-moved p { margin:5px 0 9px; color:#f5e7c2; line-height:1.45; }
    #openfront-party-companion .ofpc-moved > div { display:grid; grid-template-columns:1fr 1fr auto; gap:5px; }
    #openfront-party-companion .ofpc-squad { display:grid; gap:5px; padding:8px; border:1px solid rgba(148,163,184,.18); border-radius:8px; }
    #openfront-party-companion .ofpc-squad > strong { color:#62b0ff; font-size:9px; letter-spacing:.1em; }
    #openfront-party-companion .ofpc-squad > div { display:grid; grid-template-columns:auto 1fr auto; align-items:center; gap:7px; min-width:0; padding:6px; border-radius:6px; background:rgba(20,31,48,.8); }
    #openfront-party-companion .ofpc-squad b { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    #openfront-party-companion .ofpc-squad small { color:#9fb2c9; font-size:9px; }
    #openfront-party-companion .dot { width:7px; height:7px; border-radius:50%; background:#718096; }
    #openfront-party-companion .dot.ready { background:#4ade80; } #openfront-party-companion .dot.in_game, #openfront-party-companion .dot.in_lobby, #openfront-party-companion .dot.opening { background:#62b0ff; } #openfront-party-companion .dot.finished { background:#fbbf24; }
    #openfront-party-companion .ofpc-actions { display:flex; flex-wrap:wrap; gap:6px; }
    #openfront-party-companion .ofpc-actions > * { flex:1 1 auto; }
    #openfront-party-companion .ofpc-error, #openfront-party-companion .ofpc-pending, #openfront-party-companion .ofpc-regroup, #openfront-party-companion .ofpc-empty { margin:0; padding:8px; border-radius:7px; color:#ffd0d3; background:rgba(127,29,29,.28); line-height:1.4; }
    #openfront-party-companion .ofpc-pending, #openfront-party-companion .ofpc-regroup { color:#ffe4a3; background:rgba(91,63,10,.32); }
    #openfront-party-companion .ofpc-transient { position:absolute; top:48px; right:8px; left:8px; padding:8px; border:1px solid rgba(98,176,255,.42); border-radius:7px; color:#ddecff; background:#122238; box-shadow:0 8px 24px rgba(0,0,0,.38); }
    @keyframes ofpc-slide { from { opacity:0; transform:translateY(-10px); } }
    @media (max-width:520px) { #openfront-party-companion .ofpc-moved > div { grid-template-columns:1fr; } }
  `);

  const boot = () => {
    installUi();
    const connecting = consumeConnectFragment();
    if (credential && !connecting) {
      credential.relayOrigin = safeRelay(credential.relayOrigin);
      credential.viewerUrl = safeViewer(credential.viewerUrl);
      void poll();
    }
    detectPhase();
    const observer = new MutationObserver(() => detectPhase());
    observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ["class", "style"] });
    setInterval(detectPhase, 1_000);
  };

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot, { once: true });
  else boot();
})();
