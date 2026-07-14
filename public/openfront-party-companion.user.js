// ==UserScript==
// @name         OpenFront Party Companion
// @namespace    openfront-party-coordinator
// @version      0.2.0
// @description  Keeps an opt-in pre-lobby party connected while playing OpenFront.
// @match        https://openfront.io/*
// @run-at       document-start
// @noframes
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_addStyle
// @grant        GM_xmlhttpRequest
// @connect      localhost
// @connect      127.0.0.1
// @connect      *
// ==/UserScript==

(() => {
  "use strict";

  const STORAGE_KEY = "openfront-party-companion-session";
  const POSITION_KEY = "openfront-party-companion-position";
  const PROCESSED_KEY = "openfront-party-processed-commands";
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
  const persistentEvents = new Map();
  const acknowledgedEventIds = new Set();
  const processedCommands = new Set(GM_getValue(PROCESSED_KEY, []));

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
    return `https://openfront.io/game/${encodeURIComponent(event.gameId)}`;
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
