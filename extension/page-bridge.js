(() => {
  "use strict";

  const PAGE_SOURCE = "openfront-party-page-bridge-v1";
  const EXTENSION_SOURCE = "openfront-party-extension-v1";
  let ready = false;
  let clientId = null;
  const queued = [];

  function post(kind, payload) {
    const message = { source: PAGE_SOURCE, kind, payload };
    if (!ready) {
      queued.push(message);
      if (queued.length > 200) queued.shift();
      return;
    }
    window.postMessage(message, location.origin);
  }

  function compactTurn(turn) {
    if (!turn || typeof turn !== "object") return turn;
    return {
      turnNumber: turn.turnNumber,
      intents: (turn.intents || []).filter((intent) => intent?.type === "build_unit"),
    };
  }

  function localStats(allPlayersStats) {
    if (!allPlayersStats || typeof allPlayersStats !== "object" || !clientId || !allPlayersStats[clientId]) {
      return allPlayersStats;
    }
    return { [clientId]: allPlayersStats[clientId] };
  }

  function compactServerMessage(message) {
    if (!message || typeof message !== "object") return null;
    if (message.type === "start") {
      clientId = message.myClientID || clientId;
      return {
        type: "start",
        myClientID: message.myClientID,
        gameStartInfo: {
          gameID: message.gameStartInfo?.gameID,
          config: message.gameStartInfo?.config,
        },
        turns: (message.turns || []).map(compactTurn),
      };
    }
    if (message.type === "turn") return { type: "turn", turn: compactTurn(message.turn) };
    return null;
  }

  function compactWorkerOutbound(message) {
    if (!message || typeof message !== "object") return null;
    if (message.type === "init") {
      clientId = message.clientID || clientId;
      return {
        type: "init",
        clientID: message.clientID,
        gameStartInfo: {
          gameID: message.gameStartInfo?.gameID,
          config: message.gameStartInfo?.config,
        },
      };
    }
    if (message.type === "turn") return { type: "turn", turn: compactTurn(message.turn) };
    return null;
  }

  function compactGameUpdate(gameUpdate) {
    const groups = gameUpdate?.updates;
    if (!groups || typeof groups !== "object") return null;
    const compact = {};
    for (const [key, updates] of Object.entries(groups)) {
      if (!Array.isArray(updates) || updates.length === 0) continue;
      const selected = updates.filter((update) => {
        if (!update || typeof update !== "object") return false;
        if (update.donationType === "troops" || update.donationType === "gold") return true;
        if (update.allPlayersStats && Array.isArray(update.winner)) return true;
        if (key === "1") return new Set(["Port", "Factory", "Atom Bomb", "Hydrogen Bomb"]).has(update.unitType);
        if (key === "2") return !clientId || update.clientID === clientId;
        return false;
      }).map((update) => update.allPlayersStats ? {
        ...update,
        allPlayersStats: localStats(update.allPlayersStats),
      } : update);
      if (selected.length) compact[key] = selected;
    }
    return { tick: gameUpdate.tick, updates: compact };
  }

  window.addEventListener("message", (event) => {
    if (event.source !== window || event.data?.source !== EXTENSION_SOURCE || event.data?.type !== "ready") return;
    ready = true;
    while (queued.length) window.postMessage(queued.shift(), location.origin);
  });

  const OriginalWebSocket = window.WebSocket;
  if (OriginalWebSocket && !OriginalWebSocket.__openFrontPartyExtension) {
    const WrappedWebSocket = new Proxy(OriginalWebSocket, {
      construct(target, args, newTarget) {
        const socket = Reflect.construct(target, args, newTarget);
        const url = String(args[0] || "");
        if (/\/w\d+(?:\?|$)/.test(url) && !/\/lobbies(?:\?|$)/.test(url)) {
          socket.addEventListener("message", (event) => {
            try {
              const compact = compactServerMessage(JSON.parse(event.data));
              if (compact) post("server", compact);
            } catch {}
          });
          const send = socket.send;
          socket.send = function (data) {
            try {
              const message = JSON.parse(data);
              if (message.type === "winner") {
                post("winner", { winner: message.winner, allPlayersStats: localStats(message.allPlayersStats) });
              }
            } catch {}
            return send.call(this, data);
          };
        }
        return socket;
      },
    });
    Object.defineProperty(WrappedWebSocket, "__openFrontPartyExtension", { value: true });
    window.WebSocket = WrappedWebSocket;
  }

  const OriginalWorker = window.Worker;
  if (OriginalWorker && !OriginalWorker.__openFrontPartyExtension) {
    const WrappedWorker = new Proxy(OriginalWorker, {
      construct(target, args, newTarget) {
        const worker = Reflect.construct(target, args, newTarget);
        worker.addEventListener("message", (event) => {
          const data = event.data;
          if (data?.type !== "game_update_batch" || !Array.isArray(data.gameUpdates)) return;
          const gameUpdates = data.gameUpdates.map(compactGameUpdate).filter(Boolean);
          if (gameUpdates.length) post("worker", { type: "game_update_batch", gameUpdates });
        });
        const postMessage = worker.postMessage;
        worker.postMessage = function (message, transfer) {
          try {
            const compact = compactWorkerOutbound(message);
            if (compact) post("worker-outbound", compact);
          } catch {}
          return transfer === undefined ? postMessage.call(this, message) : postMessage.call(this, message, transfer);
        };
        return worker;
      },
    });
    Object.defineProperty(WrappedWorker, "__openFrontPartyExtension", { value: true });
    window.Worker = WrappedWorker;
  }
})();
