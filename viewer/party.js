(() => {
  const byId = (id) => document.getElementById(id);
  const el = {
    toggle: byId("partyToggle"),
    toggleCount: byId("partyToggleCount"),
    backdrop: byId("partyBackdrop"),
    panel: byId("partyPanel"),
    close: byId("partyClose"),
    connectionDot: byId("partyConnectionDot"),
    headerStatus: byId("partyHeaderStatus"),
    hint: byId("partyHint"),
    start: byId("partyStart"),
    live: byId("partyLive"),
    name: byId("partyName"),
    code: byId("partyCode"),
    create: byId("partyCreate"),
    join: byId("partyJoin"),
    directory: byId("partyDirectoryList"),
    codeValue: byId("partyCodeValue"),
    copy: byId("partyCopy"),
    leave: byId("partyLeave"),
    liveCount: byId("partyLiveCount"),
    launchNotice: byId("partyLaunchNotice"),
    launchNoticeTitle: byId("partyLaunchNoticeTitle"),
    launchNoticeStatus: byId("partyLaunchNoticeStatus"),
    openLaunch: byId("partyOpenLaunch"),
    members: byId("partyMembers"),
    memberCount: byId("partyMemberCount"),
    modeHelp: byId("partyModeHelp"),
    settingsSummary: byId("partySettingsSummary"),
    filterSummary: byId("partyFilterSummary"),
    editFilters: byId("partyEditFilters"),
    companionStatus: byId("partyCompanionStatus"),
    installCompanion: byId("partyInstallCompanion"),
    connectOpenFront: byId("partyConnectOpenFront"),
    readyLine: byId("partyReadyLine"),
    readyStatus: byId("partyReadyStatus"),
    readyToggle: byId("partyReadyToggle"),
    selectionBar: byId("partySelectionBar"),
    selectionTitle: byId("partySelectionTitle"),
    selectionHint: byId("partySelectionHint"),
    selectionCancel: byId("partySelectionCancel"),
    toastStack: byId("partyToastStack"),
  };

  let socket;
  let session;
  let room;
  let previousRoom;
  let lastGames = [];
  let worker = "";
  let reconnectTimer;
  let heartbeatTimer;
  let hoverTimer;
  let lastHoverId = "";
  let selectingLobby = false;
  let reopenAfterSelection = false;
  let lastFocusedElement;
  let lastErrorToast = { message: "", at: 0 };
  let lastSuggestion = { lobbyId: "", at: 0 };
  let createVisibility = "public";
  let createDecisionMode = "dictator";
  let currentFilterPreference = { summary: "All public lobbies", matchingLobbyIds: [] };
  let lastFilterPreferenceSignature = "";
  let lastLobbyFeedAt = 0;
  let lastObservationAt = 0;
  let lastObservationSignature = "";
  let pendingCompanionWindow = null;
  let openFrontWindow = window.OPENFRONT_PARTY_OPENFRONT_WINDOW || null;
  const lobbySamples = new Map();
  const acknowledgedRequestIds = new Set();
  const resumeStorageKey = "openfront-party-resume-token";
  const openedLaunchStorageKey = "openfront-party-opened-launch";
  const openFrontWindowName = "openfront-party-game";

  const savedName = localStorage.getItem("openfront-party-name");
  if (savedName) el.name.value = savedName;

  const deploymentConfig = window.OPENFRONT_PARTY_CONFIG || {};

  function httpOrigin(value) {
    const candidate = new URL(value || location.origin, location.href);
    if (!new Set(["http:", "https:"]).has(candidate.protocol)) throw new Error("Party relay must use HTTP or HTTPS.");
    return candidate.origin;
  }

  const relayHttpOrigin = httpOrigin(deploymentConfig.relayOrigin || window.OPENFRONT_PARTY_RELAY_ORIGIN);
  const relayUrl = relayHttpOrigin.replace(/^http:/, "ws:").replace(/^https:/, "wss:");
  const viewerUrl = new URL("./", location.href).href;
  if (el.installCompanion) {
    el.installCompanion.href = new URL(deploymentConfig.userscriptPath || "../openfront-party-companion.user.js", location.href).href;
  }

  const stateLabels = {
    watching: "Watching lobby board",
    opening: "Opening OpenFront",
    in_lobby: "In lobby",
    in_game: "In game",
    finished: "Finished",
    ready: "Ready",
    failed: "Needs attention",
  };

  function send(type, payload = {}) {
    if (socket?.readyState !== WebSocket.OPEN) {
      if (type !== "member.heartbeat" && type !== "leader.clear_hover") {
        showToast("Relay unavailable", "Wait for the party connection to recover.", "danger");
      }
      return false;
    }
    socket.send(JSON.stringify({ v: 1, type, ...payload }));
    return true;
  }

  function me() {
    return room?.members.find((member) => member.id === session?.clientId);
  }

  function isLeader() {
    return me()?.role === "leader";
  }

  function category(game) {
    return game?.raw?.__rawType || game?.raw?.publicGameType || "special";
  }

  function gameMode(game) {
    return String(game?.format || game?.raw?.format || ({ ffa: "FFA", team: "Teams", special: "Special" })[category(game)] || "Public lobby");
  }

  function toLobby(game) {
    return {
      id: String(game?.id || ""),
      name: String(game?.map || "Unknown"),
      map: String(game?.map || "Unknown"),
      mode: gameMode(game),
      players: Number(game?.joined || 0),
      capacity: Number(game?.maxPlayers || 1),
      server: worker,
      startsAt: game?.startsAt == null ? null : Number(game.startsAt),
    };
  }

  function officialGameUrl(lobby) {
    const workerPath = /^w\d+$/.test(String(lobby?.server || "")) ? String(lobby.server) : "w0";
    return `https://openfront.io/${encodeURIComponent(workerPath)}/game/${encodeURIComponent(lobby?.id || "")}`;
  }

  function prepareOpenFrontWindow() {
    if (openFrontWindow && !openFrontWindow.closed) return true;
    openFrontWindow = window.open("https://openfront.io/", openFrontWindowName);
    if (!openFrontWindow) return false;
    window.OPENFRONT_PARTY_OPENFRONT_WINDOW = openFrontWindow;
    return true;
  }

  function navigateOpenFrontWindow(lobby) {
    const url = officialGameUrl(lobby);
    if (!openFrontWindow || openFrontWindow.closed) {
      openFrontWindow = window.OPENFRONT_PARTY_OPENFRONT_WINDOW || null;
    }
    if (!openFrontWindow || openFrontWindow.closed) return false;
    openFrontWindow.location.href = url;
    window.OPENFRONT_PARTY_OPENFRONT_WINDOW = openFrontWindow;
    openFrontWindow.focus();
    return true;
  }

  function openUnlinkedLaunch(before, after) {
    const launch = after?.currentLaunch;
    if (!launch || before?.currentLaunch?.roundId === launch.roundId) return;
    const current = after.members.find((member) => member.id === session?.clientId);
    if (!current || current.companionConnected || !launch.participantIds?.includes(current.id)) return;

    const launchKey = `${after.code}:${launch.roundId}`;
    if (localStorage.getItem(openedLaunchStorageKey) === launchKey) return;
    if (!navigateOpenFrontWindow(launch.lobby)) {
      showToast("Party launched", "Open Party and choose Open lobby to join.", "info");
      return;
    }
    localStorage.setItem(openedLaunchStorageKey, launchKey);
    showToast("Opening selected lobby", `${launch.lobby.name || "OpenFront"} is opening in the OpenFront tab.`, "success");
  }

  function createText(parent, tag, value, className = "") {
    const node = document.createElement(tag);
    node.textContent = value;
    if (className) node.className = className;
    parent.append(node);
    return node;
  }

  function showToast(title, message, tone = "info") {
    while (el.toastStack.children.length >= 3) el.toastStack.firstElementChild.remove();
    const toast = document.createElement("div");
    toast.className = `partyToast ${tone}`;
    const copy = document.createElement("div");
    createText(copy, "strong", title);
    createText(copy, "span", message);
    const close = document.createElement("button");
    close.type = "button";
    close.setAttribute("aria-label", "Dismiss notification");
    close.textContent = "×";
    close.addEventListener("click", () => toast.remove());
    toast.append(copy, close);
    el.toastStack.append(toast);
    requestAnimationFrame(() => toast.classList.add("show"));
    setTimeout(() => {
      toast.classList.remove("show");
      setTimeout(() => toast.remove(), 220);
    }, 5200);
  }

  function connect() {
    clearTimeout(reconnectTimer);
    socket = new WebSocket(relayUrl);
    setConnectionState("connecting");

    socket.addEventListener("open", () => setConnectionState("online"));
    socket.addEventListener("message", ({ data }) => {
      let message;
      try {
        message = JSON.parse(data);
      } catch {
        return;
      }

      if (message.type === "session.welcome") {
        session = message;
        clearInterval(heartbeatTimer);
        heartbeatTimer = setInterval(() => send("member.heartbeat"), message.heartbeatMs);
        const savedToken = localStorage.getItem(resumeStorageKey);
        if (savedToken && savedToken !== message.resumeToken) {
          send("session.resume", { resumeToken: savedToken });
        } else if (message.resumeToken) {
          localStorage.setItem(resumeStorageKey, message.resumeToken);
        }
        return;
      }

      if (message.type === "session.resumed") {
        session = message;
        clearInterval(heartbeatTimer);
        heartbeatTimer = setInterval(() => send("member.heartbeat"), message.heartbeatMs);
        if (message.resumeToken) localStorage.setItem(resumeStorageKey, message.resumeToken);
        setConnectionState("online");
        showToast("Party restored", "You reconnected to the same party.", "success");
        return;
      }

      if (message.type === "session.resume_failed") {
        room = null;
        previousRoom = null;
        if (message.resumeToken) localStorage.setItem(resumeStorageKey, message.resumeToken);
        else localStorage.removeItem(resumeStorageKey);
        render();
        return;
      }

      if (message.type === "group.error") {
        el.hint.textContent = message.message;
        const now = Date.now();
        if (message.message !== lastErrorToast.message || now - lastErrorToast.at > 3500) {
          showToast("Party action failed", message.message, "danger");
          lastErrorToast = { message: message.message, at: now };
        }
        return;
      }

      if (message.type === "companion.ticket") {
        const target = new URL("https://openfront.io/");
        target.hash = new URLSearchParams({
          "party-connect": message.ticket,
          "party-relay": relayHttpOrigin,
          "party-viewer": viewerUrl,
        }).toString();
        if (pendingCompanionWindow && !pendingCompanionWindow.closed) pendingCompanionWindow.location.href = target.href;
        else showToast("Popup blocked", "Allow popups, then choose Connect OpenFront again.", "warning");
        pendingCompanionWindow = null;
        showToast("Companion link ready", "OpenFront will bind this browser to your party.", "success");
        return;
      }

      if (message.type === "launch.accepted") {
        showToast("Party launch started", `Opening the selected lobby for ${message.participants} ready member${message.participants === 1 ? "" : "s"}.`, "success");
        return;
      }

      if (message.type === "member.ready_for_regroup") {
        showToast("Ready to regroup", `${message.event?.member?.name || "A member"} is ready for the next match.`, "info");
        return;
      }

      if (message.type === "group.lobby_suggestion") {
        const ownSuggestion = message.proposer?.id === session?.clientId;
        const verb = message.selected ? "proposed" : "suggested";
        const title = ownSuggestion ? "Suggestion shared" : `${message.proposer?.name || "A party member"} ${verb} a lobby`;
        const detail = `${message.lobby?.name || "Unknown lobby"} · ${message.lobby?.mode || "Public lobby"}`;
        showToast(title, `${detail}. Review it in Party before opening OpenFront.`, message.selected ? "success" : "info");
        lastSuggestion = { lobbyId: String(message.lobby?.id || ""), at: Date.now() };
        return;
      }

      if (message.type === "group.lobby_vote") {
        const ownVote = message.voter?.id === session?.clientId;
        showToast(ownVote ? "Vote recorded" : `${message.voter?.name || "A party member"} voted`, `${message.lobby?.name || "Unknown lobby"} · ${message.lobby?.mode || "Public lobby"}`, "info");
        return;
      }

      if (message.type === "group.snapshot") {
        previousRoom = room;
        room = message.room;
        handleSnapshotNotifications(previousRoom, room);
        if (!previousRoom || previousRoom.code !== room.code) lastFilterPreferenceSignature = "";
        syncFilterPreference();
        publishLobbyObservation();
        render();
        openUnlinkedLaunch(previousRoom, room);
        if (reopenAfterSelection && room.selectedLobby) {
          reopenAfterSelection = false;
          toggleModal(true);
        }
      }
    });

    socket.addEventListener("close", () => {
      setConnectionState("offline");
      room = null;
      previousRoom = null;
      selectingLobby = false;
      el.selectionBar.hidden = true;
      document.body.classList.remove("party-selecting");
      render();
      loadOpenParties();
      reconnectTimer = setTimeout(connect, 1800);
    });
  }

  function setConnectionState(value) {
    el.connectionDot.dataset.state = value;
    el.headerStatus.textContent = value === "online" ? (room ? "Live" : "Connected") : value === "offline" ? "Reconnecting" : "Connecting";
  }

  function handleSnapshotNotifications(before, after) {
    const activeRequestIds = new Set(after.members.filter((member) => member.state === "wants-to-join").map((member) => member.id));
    for (const memberId of acknowledgedRequestIds) {
      if (!activeRequestIds.has(memberId)) acknowledgedRequestIds.delete(memberId);
    }
    if (!before || before.code !== after.code) return;

    const beforeRequests = new Set(before.members.filter((member) => member.state === "wants-to-join").map((member) => member.id));
    const newRequests = after.members.filter((member) => member.state === "wants-to-join" && !beforeRequests.has(member.id));
    if (isLeader()) {
      for (const member of newRequests) {
        showToast("Join request", `${member.name} wants to join ${after.selectedLobby?.name || "your lobby"}.`, "warning");
      }
    }

    const recentlyAnnounced = String(after.selectedLobby?.id || "") === lastSuggestion.lobbyId && Date.now() - lastSuggestion.at < 2500;
    if (!isLeader() && !recentlyAnnounced && before.selectedLobby?.id !== after.selectedLobby?.id && after.selectedLobby) {
      if (me()?.state === "wants-to-join") send("member.state", { state: "ready" });
      showToast(after.decisionMode === "democracy" ? "Party vote decided" : "Leader selected a lobby", `${after.selectedLobby.name} · ${after.selectedLobby.mode}`, "success");
    }

    const afterIds = new Set(after.members.map((member) => member.id));
    const departed = before.members.find((member) => !afterIds.has(member.id));
    if (departed) showToast("Member left", `${departed.name} disconnected from the party.`, "info");
  }

  function toggleModal(open = el.backdrop.hidden) {
    el.backdrop.hidden = !open;
    el.toggle.setAttribute("aria-expanded", String(open));
    el.toggle.classList.toggle("active", open || Boolean(room));
    if (open) {
      window.dispatchEvent(new CustomEvent("openfront:party-open"));
      lastFocusedElement = document.activeElement;
      loadOpenParties();
      requestAnimationFrame(() => el.panel.querySelector("input:not([hidden]), button:not([hidden])")?.focus());
    } else if (lastFocusedElement instanceof HTMLElement) {
      lastFocusedElement.focus();
    }
  }

  window.addEventListener("openfront:history-open", () => toggleModal(false));

  function setSelectingLobby(active) {
    const wasSelecting = selectingLobby;
    selectingLobby = active;
    el.selectionBar.hidden = !active;
    document.body.classList.toggle("party-selecting", active);
    if (!active && wasSelecting && isLeader() && room?.decisionMode === "dictator") {
      lastHoverId = "";
      send("leader.clear_hover");
    }
  }

  function startLobbySelection() {
    if (!room || (room.decisionMode === "dictator" && !isLeader())) return;
    toggleModal(false);
    el.selectionTitle.textContent = room.decisionMode === "democracy" ? "Vote for your preferred lobby" : "Selecting a lobby for your party";
    el.selectionHint.textContent = room.decisionMode === "democracy" ? "Click a card to cast or change your vote." : "Hover to preview. Click a card to propose.";
    setSelectingLobby(true);
    showToast(room.decisionMode === "democracy" ? "Voting active" : "Lobby selection active", room.decisionMode === "democracy" ? "Click a lobby card to cast or change your vote." : "Hover a card to preview it for your party, then click to propose it.", "info");
  }

  function lobbyAvailability(selected) {
    if (!lastGames.length) return { state: "checking", label: "Checking live feed", live: null };
    if (selected?.server && worker && selected.server !== worker) {
      return { state: "other-server", label: `On ${selected.server}`, live: null };
    }
    const live = lastGames.find((game) => String(game.id) === String(selected?.id));
    if (!live) return { state: "missing", label: "No longer in feed", live: null };
    const players = Number(live.joined || 0);
    const capacity = Number(live.maxPlayers || selected.capacity || 1);
    if (players >= capacity) return { state: "full", label: "Lobby full", live };
    if (live.startsAt && Number(live.startsAt) <= Date.now()) return { state: "started", label: "Started", live };
    return { state: "open", label: `${Math.max(0, capacity - players)} slots open`, live };
  }

  function voteTallies() {
    const tallies = new Map();
    for (const vote of room?.votes || []) {
      const entry = tallies.get(vote.lobby.id) || { lobby: vote.lobby, count: 0 };
      entry.count += 1;
      tallies.set(vote.lobby.id, entry);
    }
    return tallies;
  }

  function recordLobbySamples(games) {
    const now = Date.now();
    const liveIds = new Set();
    for (const game of games) {
      const id = String(game.id || "");
      if (!id) continue;
      liveIds.add(id);
      const samples = lobbySamples.get(id) || [];
      const joined = Number(game.joined || 0);
      const previous = samples.at(-1);
      if (!previous || previous.joined !== joined || now - previous.at >= 5000) samples.push({ at: now, joined });
      while (samples.length > 1 && samples[0].at < now - 30000) samples.shift();
      lobbySamples.set(id, samples);
    }
    for (const id of lobbySamples.keys()) if (!liveIds.has(id)) lobbySamples.delete(id);
  }

  function joinTelemetry(game) {
    const partySize = room?.members.length || 1;
    const openSlots = Math.max(0, Number(game.maxPlayers || 0) - Number(game.joined || 0));
    if (openSlots < partySize) return { tone: "blocked", label: `${openSlots}/${partySize} slots`, seconds: 0, openSlots };
    const samples = lobbySamples.get(String(game.id)) || [];
    const first = samples[0];
    const last = samples.at(-1);
    if (!first || !last || last.at - first.at < 3000 || last.joined <= first.joined) return { tone: "stable", label: `${openSlots} slots`, seconds: null, openSlots };
    const playersPerSecond = (last.joined - first.joined) / ((last.at - first.at) / 1000);
    const seconds = Math.max(0, (openSlots - partySize) / playersPerSecond);
    if (seconds <= 90) return { tone: seconds <= 20 ? "blocked" : "urgent", label: `~${Math.max(1, Math.ceil(seconds))}s window`, seconds, openSlots };
    return { tone: "stable", label: `${openSlots} slots`, seconds, openSlots };
  }

  function joinWindow(game) {
    return joinTelemetry(game);
  }

  function leadingVote() {
    return [...voteTallies().values()].sort((a, b) => b.count - a.count || a.lobby.id.localeCompare(b.lobby.id))[0] || null;
  }

  function syncFilterPreference() {
    if (!room) return;
    const signature = JSON.stringify(currentFilterPreference);
    if (signature === lastFilterPreferenceSignature) return;
    if (send("member.filters", { filterPreference: currentFilterPreference })) lastFilterPreferenceSignature = signature;
  }

  function renderPick() {
    el.selected.replaceChildren();
    el.selected.className = "partySection partyPick";
    const launched = room?.currentLaunch?.lobby;
    const chosen = room?.selectedLobby;
    const democracy = room?.decisionMode === "democracy";
    const voteLeader = democracy ? leadingVote() : null;
    const previewGame = !democracy && room?.hoveredLobbyId
      ? lastGames.find((game) => String(game.id) === String(room.hoveredLobbyId))
      : null;
    const active = launched || chosen || voteLeader?.lobby || (previewGame ? toLobby(previewGame) : null);
    const label = launched ? "Current launch" : democracy ? (chosen ? "Party choice" : "Democracy vote") : (chosen ? "Leader's pick" : previewGame ? "Leader preview" : "Leader's pick");
    createText(el.selected, "div", label, "groupLabel");

    if (!active) {
      createText(el.selected, "p", democracy ? "No votes yet. Choose a lobby from the board to cast the first vote." : (isLeader()
        ? "Choose a public lobby when your party is ready."
        : "Waiting for the leader to select a lobby."), "partyEmpty");
      if (democracy || isLeader()) {
        const choose = document.createElement("button");
        choose.type = "button";
        choose.className = "partyPrimaryAction";
        choose.textContent = democracy ? "Browse and vote" : "Choose from lobby board";
        choose.addEventListener("click", startLobbySelection);
        el.selected.append(choose);
      }
      return;
    }

    const availability = launched ? lobbyAvailability(launched) : chosen ? lobbyAvailability(chosen) : democracy
      ? { state: "preview", label: `${voteLeader.count}/${room.members.length} votes`, live: lastGames.find((game) => String(game.id) === String(active.id)) }
      : { state: "preview", label: "Previewing", live: previewGame };
    el.selected.classList.add(`is-${availability.state}`);
    const titleLine = document.createElement("div");
    titleLine.className = "partyPickTitle";
    createText(titleLine, "strong", active.name);
    createText(titleLine, "span", availability.label, `partyLobbyStatus ${availability.state}`);
    el.selected.append(titleLine);

    const currentPlayers = availability.live ? Number(availability.live.joined || 0) : active.players;
    const currentCapacity = availability.live ? Number(availability.live.maxPlayers || active.capacity) : active.capacity;
    createText(el.selected, "p", `${active.mode} · ${currentPlayers}/${currentCapacity} · ${active.server}`, "partyLobbyMeta");

    const actions = document.createElement("div");
    actions.className = "partyPickActions";

    if (democracy && !launched) {
      const vote = document.createElement("button");
      vote.type = "button";
      vote.className = "partySecondaryAction";
      vote.textContent = "Browse and vote";
      vote.addEventListener("click", startLobbySelection);
      actions.append(vote);
    } else if (isLeader() && !launched) {
      if (!chosen && previewGame) {
        const select = document.createElement("button");
        select.type = "button";
        select.textContent = "Select this lobby";
        select.addEventListener("click", () => send("leader.select_lobby", { lobby: toLobby(previewGame) }));
        actions.append(select);
      }
      const change = document.createElement("button");
      change.type = "button";
      change.className = "partySecondaryAction";
      change.textContent = chosen ? "Change lobby" : "Browse lobby board";
      change.addEventListener("click", startLobbySelection);
      actions.append(change);
    } else if (chosen && !launched) {
      const request = document.createElement("button");
      request.type = "button";
      request.textContent = me()?.state === "wants-to-join" ? "Leader notified" : "Notify leader I'm joining";
      request.disabled = me()?.state === "wants-to-join";
      request.addEventListener("click", () => {
        if (send("member.state", { state: "wants-to-join" })) {
          showToast("Leader notified", `You want to join ${chosen.name}.`, "success");
        }
      });
      actions.append(request);
    }

    if (democracy && chosen && !launched && !isLeader()) {
      const request = document.createElement("button");
      request.type = "button";
      request.textContent = me()?.state === "wants-to-join" ? "Party notified" : "I'm joining";
      request.disabled = me()?.state === "wants-to-join";
      request.addEventListener("click", () => send("member.state", { state: "wants-to-join" }));
      actions.append(request);
    }

    if ((chosen || launched) && ["open", "other-server", "checking"].includes(availability.state)) {
      const open = document.createElement("a");
      open.href = officialGameUrl(active);
      open.target = "_blank";
      open.rel = "noreferrer";
      open.textContent = "Open lobby";
      open.addEventListener("click", () => send("member.state", { state: "opening-game" }));
      actions.append(open);
    }

    el.selected.append(actions);
  }

  function renderRequests() {
    const requests = isLeader()
      ? room.members.filter((member) => member.state === "wants-to-join")
      : [];
    el.requestsWrap.hidden = requests.length === 0;
    el.requests.replaceChildren();
    el.requestCount.textContent = `${requests.length} waiting`;

    for (const member of requests) {
      const row = document.createElement("div");
      row.className = "partyRequest";
      const identity = document.createElement("div");
      createText(identity, "strong", member.name);
      createText(identity, "span", `wants to join ${room.selectedLobby?.name || "your next lobby"}`);
      const seen = document.createElement("button");
      seen.type = "button";
      const acknowledged = acknowledgedRequestIds.has(member.id);
      row.classList.toggle("acknowledged", acknowledged);
      seen.disabled = acknowledged;
      seen.textContent = acknowledged ? "Acknowledged" : "Seen";
      seen.addEventListener("click", () => {
        acknowledgedRequestIds.add(member.id);
        row.classList.add("acknowledged");
        seen.disabled = true;
        seen.textContent = "Acknowledged";
      });
      row.append(identity, seen);
      el.requests.append(row);
    }
  }

  function renderMembers() {
    el.members.replaceChildren();
    const presentMembers = room.members.filter((member) => member.viewerConnected || member.companionConnected);
    const reconnecting = room.members.length - presentMembers.length;
    el.memberCount.textContent = `${presentMembers.length} connected${reconnecting ? ` · ${reconnecting} reconnecting` : ""}`;
    el.liveCount.textContent = `${presentMembers.length} member${presentMembers.length === 1 ? "" : "s"}`;

    const ordered = [...room.members].sort((a, b) => Number(b.role === "leader") - Number(a.role === "leader"));
    for (const member of ordered) {
      const card = document.createElement("article");
      card.className = `partyMemberCard state-${member.state}`;
      const present = member.viewerConnected || member.companionConnected;
      card.classList.toggle("is-reconnecting", !present);
      const dot = document.createElement("span");
      dot.className = "partyMemberStateDot";
      const identity = document.createElement("div");
      identity.className = "partyMemberIdentity";
      createText(identity, "strong", member.name);
      const role = member.role === "leader" ? "Party leader" : "Party member";
      createText(identity, "span", `${role} · ${stateLabels[member.phase] || member.phase}`);
      const badges = document.createElement("div");
      badges.className = "partyMemberBadges";
      const ready = member.phase === "ready";
      const readiness = !present ? "Reconnecting" : ready ? (member.companionConnected ? "Ready + auto" : "Ready") : "Not ready";
      createText(badges, "span", readiness, `partyMemberLaunchState${present && ready ? " is-launchable" : ""}`);
      const preference = createText(badges, "span", member.filterPreference?.summary || "All public lobbies", "partyMemberPreference");
      preference.title = member.filterPreference?.summary || "All public lobbies";
      card.prepend(dot, identity);
      card.append(badges);
      el.members.append(card);
    }
  }

  function preferenceScores() {
    return room.members.reduce((scores, member) => {
      for (const lobbyId of member.filterPreference?.matchingLobbyIds || []) scores[lobbyId] = (scores[lobbyId] || 0) + 1;
      return scores;
    }, {});
  }

  function renderRadar() {
    el.radar.replaceChildren();
    const scores = preferenceScores();
    const ranked = [...lastGames]
      .sort((a, b) => (scores[String(b.id)] || 0) - (scores[String(a.id)] || 0) || Number(b.joined || 0) - Number(a.joined || 0))
      .slice(0, 3);
    const votes = voteTallies();

    if (!ranked.length) {
      createText(el.radar, "p", "Waiting for the public lobby feed.", "partyEmpty");
      return;
    }

    for (const game of ranked) {
      const row = document.createElement("button");
      row.type = "button";
      row.className = `radarRow ${category(game)}`;
      row.setAttribute("aria-label", `${game.map}, ${gameMode(game)}, ${game.joined || 0} of ${game.maxPlayers || "unknown"} players`);
      const dot = document.createElement("span");
      dot.className = "radarDot";
      createText(row, "strong", String(game.map || "Unknown"));
      createText(row, "span", gameMode(game), "radarMode");
      const voteCount = votes.get(String(game.id))?.count || 0;
      createText(row, "span", `${game.joined || 0}/${game.maxPlayers || "?"}${voteCount ? ` · ${voteCount} vote${voteCount === 1 ? "" : "s"}` : ""}`, "radarPlayers");
      row.prepend(dot);
      if (room.decisionMode === "democracy") {
        row.addEventListener("click", () => send("member.vote_lobby", { lobby: toLobby(game) }));
      } else if (isLeader()) {
        row.addEventListener("pointerenter", () => {
          if (room?.hoveredLobbyId !== String(game.id)) send("leader.hover_lobby", { lobby: toLobby(game) });
        });
        row.addEventListener("click", () => send("leader.select_lobby", { lobby: toLobby(game) }));
      } else row.addEventListener("click", () => send("member.suggest_lobby", { lobby: toLobby(game) }));
      el.radar.append(row);
    }
  }

  function renderHeader() {
    const current = me();
    const requests = current?.role === "leader"
      ? room.members.filter((member) => member.state === "wants-to-join").length
      : 0;
    el.toggle.classList.toggle("inParty", Boolean(current));
    el.toggle.classList.toggle("hasAlert", requests > 0);
    el.toggleCount.hidden = !current;
    el.toggleCount.textContent = requests > 0 ? String(requests) : String(room.members.length);
    el.headerStatus.textContent = `${current?.role === "leader" ? "Leader" : "Member"} · ${room.decisionMode === "democracy" ? "Democracy" : "Dictator"}`;
  }

  function render() {
    const current = me();
    el.start.hidden = Boolean(current);
    el.live.hidden = !current;

    if (!current) {
      el.toggle.classList.remove("inParty", "hasAlert");
      el.toggleCount.hidden = true;
      el.hint.textContent = "Coordinate before opening OpenFront.";
      setConnectionState(socket?.readyState === WebSocket.OPEN ? "online" : "offline");
      decorateCards();
      return;
    }

    el.hint.textContent = room.decisionMode === "democracy"
      ? "Every member gets one vote. A clear majority chooses the lobby."
      : current.role === "leader" ? "You propose and confirm the lobby for the party." : "The leader proposes and confirms the lobby.";
    el.codeValue.textContent = room.code;
    el.modeHelp.textContent = room.decisionMode === "democracy" ? "One vote per member. Change your vote by choosing another lobby." : "The leader proposes and confirms the lobby.";
    el.settingsSummary.textContent = `${room.isPublic ? "Listed" : "Private"} · ${room.decisionMode === "democracy" ? "Democracy" : "Dictator"}`;
    el.filterSummary.textContent = currentFilterPreference.summary;
    const launch = room.currentLaunch;
    const launchedWithParty = Boolean(launch?.participantIds?.includes(current.id));
    el.launchNotice.hidden = !launch;
    if (launch) {
      el.launchNotice.classList.toggle("is-left-behind", !launchedWithParty);
      el.launchNoticeTitle.textContent = `${launch.lobby.name || "Selected lobby"} · party launched`;
      el.launchNoticeStatus.textContent = launchedWithParty
        ? "Your browser did not move? Open the lobby here."
        : "You were not Ready and were left behind. You can still open the lobby manually.";
      el.openLaunch.textContent = launchedWithParty ? "Open lobby" : "Open lobby anyway";
    }
    el.companionStatus.textContent = current.companionConnected
      ? `Userscript linked · ${stateLabels[current.phase] || current.phase}`
      : "Optional. Install the userscript to make an OpenFront tab follow launches.";
    el.connectOpenFront.textContent = current.companionConnected ? "Relink OpenFront" : "Link OpenFront";
    const ready = current.phase === "ready";
    const canSetReady = ["watching", "finished", "failed", "ready"].includes(current.phase);
    el.readyLine.classList.toggle("is-ready", ready);
    el.readyLine.classList.toggle("is-launchable", ready);
    el.readyToggle.setAttribute("aria-pressed", String(ready));
    el.readyToggle.disabled = !canSetReady;
    el.readyToggle.textContent = ready ? "Set not ready" : canSetReady ? "I'm ready" : "In current game";
    el.readyStatus.textContent = ready
      ? "Ready. You will be included in the next launch."
      : canSetReady ? "Not ready for the next lobby." : `${stateLabels[current.phase] || current.phase} — finish before marking Ready.`;
    document.querySelectorAll("[data-room-mode]").forEach((button) => {
      const selected = button.dataset.roomMode === room.decisionMode;
      button.classList.toggle("active", selected);
      button.setAttribute("aria-pressed", String(selected));
      button.disabled = !isLeader();
    });
    document.querySelectorAll("[data-room-visibility]").forEach((button) => {
      const selected = button.dataset.roomVisibility === (room.isPublic ? "public" : "private");
      button.classList.toggle("active", selected);
      button.setAttribute("aria-pressed", String(selected));
      button.disabled = !isLeader();
    });
    renderHeader();
    renderMembers();
    decorateCards();
  }

  function showLaunchDialog(game) {
    if (!room || !isLeader()) return;
    document.querySelector(".partyLaunchDialog")?.remove();
    const readyMembers = room.members.filter((member) => member.phase === "ready");
    const notReadyMembers = room.members.filter((member) => member.phase !== "ready");
    const waitingMembers = notReadyMembers;
    const telemetry = joinTelemetry(game);
    const dialog = document.createElement("dialog");
    dialog.className = "partyLaunchDialog";
    const title = createText(dialog, "h2", "Launch party");
    title.id = "partyLaunchTitle";
    createText(dialog, "p", `${game.map || "Selected lobby"} · ${game.joined || 0}/${game.maxPlayers || "?"} · ${telemetry.label}`, "partyLaunchLobby");

    const groups = document.createElement("div");
    groups.className = "partyLaunchGroups";
    const ready = document.createElement("section");
    ready.className = "is-launchable";
    createText(ready, "strong", `Ready · ${readyMembers.length}`);
    createText(ready, "span", readyMembers.map((member) => member.name).join(", ") || "Nobody is ready yet");
    const waiting = document.createElement("section");
    createText(waiting, "strong", `Not ready · ${notReadyMembers.length}`);
    createText(waiting, "span", notReadyMembers.map((member) => member.name).join(", ") || "Everyone marked Ready");
    groups.append(ready, waiting);
    dialog.append(groups);

    const choices = document.createElement("div");
    choices.className = "partyLaunchChoices";
    const allChoice = document.createElement("label");
    allChoice.innerHTML = `<input type="radio" name="partyAttendance" value="all" checked><span><strong>Launch everyone together</strong><small>Available when every member is Ready.</small></span>`;
    const readyChoice = document.createElement("label");
    readyChoice.innerHTML = `<input type="radio" name="partyAttendance" value="ready"><span><strong>Launch ready members</strong><small>Launch only Ready members; notify everyone left behind.</small></span>`;
    choices.append(allChoice, readyChoice);
    dialog.append(choices);

    const warning = createText(dialog, "p", waitingMembers.length ? `${waitingMembers.length} member${waitingMembers.length === 1 ? "" : "s"} will be left in the current game.` : "Everyone can launch together.", "partyLaunchWarning");
    const actions = document.createElement("div");
    actions.className = "partyLaunchActions";
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.textContent = "Cancel";
    const launch = document.createElement("button");
    launch.type = "button";
    launch.className = "primary";
    launch.textContent = "Launch party";
    const refreshLaunchState = () => {
      const attendance = dialog.querySelector("input[name='partyAttendance']:checked")?.value || "all";
      const waitingForAll = attendance === "all" && waitingMembers.length > 0;
      launch.disabled = waitingForAll || !readyMembers.length || telemetry.tone === "blocked";
      launch.textContent = !readyMembers.length
        ? "Waiting for players"
        : attendance === "all"
          ? `Launch ${room.members.length} player${room.members.length === 1 ? "" : "s"}`
          : `Launch ${readyMembers.length} ready player${readyMembers.length === 1 ? "" : "s"}`;
      warning.textContent = waitingForAll
        ? `${notReadyMembers.length} member${notReadyMembers.length === 1 ? " is" : "s are"} not Ready. Choose Launch ready members to leave them behind.`
        : attendance === "ready" && waitingMembers.length
          ? `${waitingMembers.length} member${waitingMembers.length === 1 ? "" : "s"} will receive a PARTY MOVED notification.`
          : telemetry.tone === "blocked" ? "This lobby does not have a safe join window." : "Everyone can launch together.";
    };
    choices.addEventListener("change", refreshLaunchState);
    cancel.addEventListener("click", () => dialog.close());
    launch.addEventListener("click", () => {
      const attendance = dialog.querySelector("input[name='partyAttendance']:checked")?.value || "all";
      const lobby = toLobby(game);
      if (!me()?.companionConnected && !prepareOpenFrontWindow()) {
        showToast("OpenFront tab blocked", "Allow popups, then choose Launch party again.", "warning");
        return;
      }
      send("member.observe_lobby", { lobby, observedAt: Date.now() });
      send("leader.launch", {
        attendance,
        lobby,
        joinWindowSeconds: telemetry.seconds,
      });
      dialog.close();
    });
    dialog.addEventListener("close", () => dialog.remove());
    actions.append(cancel, launch);
    dialog.append(actions);
    document.body.append(dialog);
    refreshLaunchState();
    dialog.showModal();
  }

  function decorateCards() {
    document.querySelectorAll(".partySignal").forEach((node) => node.remove());
    document.querySelectorAll(".partyVoteBadge").forEach((node) => node.remove());
    document.querySelectorAll(".partyIntentStack, .partyCardJoin").forEach((node) => node.remove());
    document.querySelectorAll(".gameCard.partyLeaderHover").forEach((node) => node.classList.remove("partyLeaderHover"));
    document.querySelectorAll(".gameCard.partySelectedLobby").forEach((node) => node.classList.remove("partySelectedLobby"));
    document.querySelectorAll(".gameCard.partySuggestionCard").forEach((node) => {
      node.classList.remove("partySuggestionCard");
      node.setAttribute("role", "link");
      node.removeAttribute("aria-label");
    });
    if (!room) return;

    const scores = preferenceScores();
    const votes = voteTallies();
    const activeLobbyId = String(room.currentLaunch?.lobby?.id || room.selectedLobby?.id || "");
    const activeLaunchId = String(room.currentLaunch?.lobby?.id || "");
    for (const card of document.querySelectorAll(".gameCard[data-game-id]")) {
      const game = lastGames.find((item) => String(item.id) === card.dataset.gameId);
      if (!game) continue;
      card.classList.add("partySuggestionCard");
      card.setAttribute("role", "button");
      card.setAttribute("aria-label", `${room.decisionMode === "democracy" ? "Vote for" : isLeader() ? "Propose" : "Suggest"} ${game.map || "this lobby"}`);
      const mode = category(game);
      const count = scores[String(game.id)] || 0;
      const voteCount = votes.get(card.dataset.gameId)?.count || 0;
      const intent = document.createElement("div");
      intent.className = "partyIntentStack";
      const match = createText(intent, "span", `Match ${count}/${room.members.length}`, `partyIntentBadge match ${mode}`);
      match.title = `${count} of ${room.members.length} party members include this lobby in their filters`;
      if (room.decisionMode === "democracy") createText(intent, "span", `Votes ${voteCount}/${room.members.length}`, "partyIntentBadge votes");
      if (voteCount || activeLobbyId === card.dataset.gameId) {
        const windowState = joinWindow(game);
        if (windowState.tone !== "stable") createText(intent, "span", windowState.label, `partyIntentBadge window ${windowState.tone}`);
      }
      card.querySelector(".gameCardImage")?.append(intent);
      if (room.hoveredLobbyId === card.dataset.gameId) card.classList.add("partyLeaderHover");
      card.classList.toggle("partySelectedLobby", activeLobbyId === card.dataset.gameId);
      if (activeLobbyId === card.dataset.gameId) {
        const join = document.createElement("button");
        join.type = "button";
        join.className = "partyCardJoin";
        const canConfirmLaunch = isLeader() && activeLaunchId !== card.dataset.gameId;
        join.textContent = canConfirmLaunch ? "Launch party" : "Open lobby";
        join.addEventListener("click", (event) => {
          event.preventDefault();
          event.stopPropagation();
          if (canConfirmLaunch) {
            showLaunchDialog(game);
            return;
          }
          send("member.state", { state: "opening-game" });
          openFrontWindow = window.open(officialGameUrl(toLobby(game)), openFrontWindowName);
          window.OPENFRONT_PARTY_OPENFRONT_WINDOW = openFrontWindow;
        });
        card.querySelector(".gameCardInfo")?.append(join);
      }
    }
  }

  function partyName() {
    const name = el.name.value.trim();
    if (!name) {
      el.hint.textContent = "Enter your callsign first.";
      el.name.focus();
      return null;
    }
    localStorage.setItem("openfront-party-name", name);
    return name;
  }

  function joinParty(code = el.code.value.trim()) {
    const name = partyName();
    if (!name) return;
    if (!code) {
      el.hint.textContent = "Enter a party code.";
      el.code.focus();
      return;
    }
    send("group.join", { name, code });
  }

  async function loadOpenParties() {
    if (!el.directory || room || el.backdrop.hidden) return;
    try {
      const response = await fetch(`${relayHttpOrigin}/api/groups`, { cache: "no-store" });
      if (!response.ok) throw new Error("Directory request failed");
      const data = await response.json();
      el.directory.replaceChildren();

      if (!data.groups?.length) {
        createText(el.directory, "p", "No open parties right now. Create the first one.", "partyEmpty");
        return;
      }

      for (const party of data.groups.slice(0, 5)) {
        const row = document.createElement("article");
        row.className = "partyDirectoryRow";
        const identity = document.createElement("div");
        createText(identity, "strong", `${party.leader}'s party`);
        createText(identity, "span", `${party.decisionMode === "democracy" ? "Democracy" : "Dictator"} · ${party.selectedLobby ? `Heading to ${party.selectedLobby.name}` : "Choosing a lobby"}`, "partyDirectoryMeta");
        createText(row, "span", `${party.members} member${party.members === 1 ? "" : "s"}`, "partyCount");
        const join = document.createElement("button");
        join.type = "button";
        join.textContent = "Join";
        join.addEventListener("click", () => {
          el.code.value = party.code;
          if (el.name.value.trim()) joinParty(party.code);
          else {
            el.hint.textContent = `Enter your callsign to join ${party.leader}'s party.`;
            el.name.focus();
          }
        });
        row.prepend(identity);
        row.append(join);
        el.directory.append(row);
      }
    } catch {
      el.directory.replaceChildren();
      createText(el.directory, "p", "Open parties are unavailable while the relay reconnects.", "partyEmpty");
    }
  }

  el.toggle.addEventListener("click", () => toggleModal());
  el.close.addEventListener("click", () => toggleModal(false));
  el.backdrop.addEventListener("click", (event) => {
    if (event.target === el.backdrop) toggleModal(false);
  });
  el.create.addEventListener("click", () => {
    const name = partyName();
    if (name) send("group.create", { name, isPublic: createVisibility === "public", decisionMode: createDecisionMode });
  });
  el.join.addEventListener("click", () => joinParty());
  el.code.addEventListener("keydown", (event) => {
    if (event.key === "Enter") joinParty();
  });
  el.copy.addEventListener("click", async () => {
    await navigator.clipboard?.writeText(room?.code || "");
    el.hint.textContent = "Party code copied.";
    showToast("Party code copied", room?.code || "", "success");
  });
  el.leave.addEventListener("click", () => {
    localStorage.removeItem(resumeStorageKey);
    send("group.leave");
    room = null;
    previousRoom = null;
    setSelectingLobby(false);
    render();
    loadOpenParties();
  });
  el.selectionCancel.addEventListener("click", () => setSelectingLobby(false));

  document.querySelectorAll("[data-create-visibility]").forEach((button) => {
    button.addEventListener("click", () => {
      createVisibility = button.dataset.createVisibility;
      document.querySelectorAll("[data-create-visibility]").forEach((item) => item.setAttribute("aria-pressed", String(item === button)));
    });
  });
  document.querySelectorAll("[data-create-mode]").forEach((button) => {
    button.addEventListener("click", () => {
      createDecisionMode = button.dataset.createMode;
      document.querySelectorAll("[data-create-mode]").forEach((item) => item.setAttribute("aria-pressed", String(item === button)));
    });
  });
  document.querySelectorAll("[data-room-mode]").forEach((button) => {
    button.addEventListener("click", () => {
      if (isLeader()) send("leader.set_decision_mode", { decisionMode: button.dataset.roomMode });
    });
  });
  document.querySelectorAll("[data-room-visibility]").forEach((button) => {
    button.addEventListener("click", () => {
      if (isLeader()) send("leader.set_visibility", { isPublic: button.dataset.roomVisibility === "public" });
    });
  });
  el.editFilters.addEventListener("click", () => {
    toggleModal(false);
    const filters = document.getElementById("toggleFilters");
    if (!document.body.classList.contains("filters-open")) filters?.click();
    filters?.focus();
  });
  el.connectOpenFront.addEventListener("click", () => {
    if (!room) return;
    pendingCompanionWindow = window.open("about:blank", "_blank");
    if (pendingCompanionWindow) pendingCompanionWindow.document.title = "Connecting OpenFront companion...";
    if (!send("companion.ticket.create")) {
      pendingCompanionWindow?.close();
      pendingCompanionWindow = null;
    }
  });
  el.readyToggle.addEventListener("click", () => {
    const current = me();
    if (!current || !["watching", "finished", "failed", "ready"].includes(current.phase)) return;
    const next = current.phase === "ready" ? "watching" : "ready";
    if (send("member.state", { state: next })) {
      showToast(next === "ready" ? "Marked Ready" : "Marked not ready", next === "ready"
        ? "You will be included in the next launch."
        : "You will not be included until you mark Ready again.", next === "ready" ? "success" : "info");
    }
  });
  el.openLaunch.addEventListener("click", () => {
    const lobby = room?.currentLaunch?.lobby;
    if (!lobby) return;
    send("member.state", { state: "opening-game" });
    openFrontWindow = window.open(officialGameUrl(lobby), openFrontWindowName);
    window.OPENFRONT_PARTY_OPENFRONT_WINDOW = openFrontWindow;
    if (!openFrontWindow) showToast("OpenFront tab blocked", "Allow popups, then choose Open lobby again.", "warning");
  });

  document.addEventListener("pointerover", (event) => {
    if (!selectingLobby || !isLeader() || room?.decisionMode !== "dictator") return;
    const card = event.target.closest?.(".gameCard[data-game-id]");
    if (!card || lastHoverId === card.dataset.gameId) return;
    const game = lastGames.find((item) => String(item.id) === card.dataset.gameId);
    if (!game) return;
    clearTimeout(hoverTimer);
    lastHoverId = card.dataset.gameId;
    send("leader.hover_lobby", { lobby: toLobby(game) });
  });

  document.addEventListener("pointerout", (event) => {
    if (!selectingLobby || !isLeader() || room?.decisionMode !== "dictator") return;
    const card = event.target.closest?.(".gameCard[data-game-id]");
    if (!card || card.contains(event.relatedTarget)) return;
    clearTimeout(hoverTimer);
    hoverTimer = setTimeout(() => {
      lastHoverId = "";
      send("leader.clear_hover");
    }, 120);
  });

  function shareCardWithParty(event) {
    if (!room) return;
    if (event.type === "keydown" && event.key !== "Enter" && event.key !== " ") return;
    if (event.target.closest?.(".partyCardJoin")) return;
    const card = event.target.closest?.(".gameCard[data-game-id]");
    if (!card) return;
    const game = lastGames.find((item) => String(item.id) === card.dataset.gameId);
    if (!game) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (room.decisionMode === "democracy") {
      send("member.vote_lobby", { lobby: toLobby(game) });
      if (selectingLobby) {
        setSelectingLobby(false);
        toggleModal(true);
      }
    } else if (isLeader()) {
      reopenAfterSelection = selectingLobby;
      send("leader.select_lobby", { lobby: toLobby(game) });
      if (selectingLobby) setSelectingLobby(false);
    } else {
      send("member.suggest_lobby", { lobby: toLobby(game) });
    }
  }

  document.addEventListener("click", shareCardWithParty, true);
  document.addEventListener("keydown", shareCardWithParty, true);

  window.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      if (selectingLobby) setSelectingLobby(false);
      else if (!el.backdrop.hidden) toggleModal(false);
      return;
    }
    if (event.key !== "Tab" || el.backdrop.hidden) return;
    const focusable = [...el.panel.querySelectorAll("button:not(:disabled), input:not(:disabled), a[href]")].filter((node) => node.offsetParent !== null);
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  });

  window.addEventListener("openfront:lobbies-rendered", (event) => {
    lastGames = event.detail.allGames || event.detail.games || [];
    lastLobbyFeedAt = Date.now();
    recordLobbySamples(lastGames);
    worker = event.detail.worker || "";
    currentFilterPreference = event.detail.filterPreference || currentFilterPreference;
    if (room) {
      syncFilterPreference();
      publishLobbyObservation();
      render();
    }
  });

  function publishLobbyObservation(force = false) {
    if (!room || !isLeader()) return;
    const watchedId = String(room.currentLaunch?.lobby?.id || room.selectedLobby?.id || "");
    if (!watchedId) return;
    const game = lastGames.find((item) => String(item.id) === watchedId);
    if (!game) return;
    const lobby = toLobby(game);
    const signature = JSON.stringify(lobby);
    const now = Date.now();
    if (!force && signature === lastObservationSignature && now - lastObservationAt < 3000) return;
    if (send("member.observe_lobby", { lobby, observedAt: now })) {
      lastObservationAt = now;
      lastObservationSignature = signature;
    }
  }

  setInterval(loadOpenParties, 4000);
  connect();
})();
