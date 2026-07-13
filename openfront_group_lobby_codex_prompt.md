# OpenFront party coordinator — current plan

Verified against the OpenFrontIO `main` branch on 2026-07-13.

## Product model

The lobby board is the primary party surface. Once a party exists, players stay on the board:

- each card shows how many party members' Filters include that lobby;
- Democracy shows votes per total members and lets every member cast one vote;
- Dictator lets the leader choose the party lobby;
- the selected card is highlighted and exposes the explicit join action;
- the Party modal is reserved for Squad, personal Filters and collapsed party settings.

The relay owns only temporary coordination state. It never receives OpenFront cookies, account tokens, Turnstile responses or gameplay messages.

## Verified OpenFront integration facts

### Public lobby feed

OpenFront's `PublicLobbySocket` connects to `/{worker}/lobbies`. A new connection receives a full snapshot; subsequent messages can contain player-count-only deltas. `MasterLobbyService` broadcasts lobby state every 500 ms.

Sources:

- <https://github.com/openfrontio/OpenFrontIO/blob/main/src/client/LobbySocket.ts>
- <https://github.com/openfrontio/OpenFrontIO/blob/main/src/server/WorkerLobbyService.ts>
- <https://github.com/openfrontio/OpenFrontIO/blob/main/src/server/MasterLobbyService.ts>

This is sufficient for measuring lobby fill velocity without connecting to individual games.

### Official join path

A game URL has the form `/{worker}/game/{gameID}`. OpenFront parses this URL, checks that the game exists and dispatches its own `join-lobby` event. Its client then obtains the user's settings, authentication/play token and a Turnstile token when required before sending the official join message.

Sources:

- <https://github.com/openfrontio/OpenFrontIO/blob/main/src/client/Main.ts>
- <https://github.com/openfrontio/OpenFrontIO/blob/main/src/client/JoinLobbyModal.ts>
- <https://github.com/openfrontio/OpenFrontIO/blob/main/src/client/ClientGameRunner.ts>
- <https://github.com/openfrontio/OpenFrontIO/blob/main/src/client/Transport.ts>

The companion must navigate to the official URL and let OpenFront own this process. It must not reproduce join packets or access authentication material.

### Capacity behavior

OpenFront rechecks `activeClients.length >= maxPlayers` on every join attempt and rejects full lobbies. The public lobby count is therefore an observation, not a reservation: several party members can race other players for the remaining slots.

Source: <https://github.com/openfrontio/OpenFrontIO/blob/main/src/server/GameServer.ts>

### Multi-game continuity

OpenFront already has a `new_lobby`/`NewLobbyEvent` flow for a reused private lobby. That flow does not provide a general persistent public-game party. A separate companion or an upstream OpenFront feature is needed for our relay party to remain connected while the player is on `openfront.io` and to coordinate the next public match.

Sources:

- <https://github.com/openfrontio/OpenFrontIO/blob/main/src/server/GameServer.ts>
- <https://github.com/openfrontio/OpenFrontIO/blob/main/src/client/ClientGameRunner.ts>

## Join-window telemetry

For every lobby, retain a bounded rolling series of `(timestamp, playerCount)` samples. The first UI version uses a 30-second window and shows:

- `Match A/B`: members whose Filters include the lobby;
- `Votes V/B`: current Democracy votes;
- `N slots`: current free capacity;
- `~Ns window`: estimated time until there is no longer room for the whole party.

The prototype estimate is:

```text
fillRate = positivePlayerDelta / elapsedSeconds
partyMargin = openSlots - connectedPartyMembers
joinWindowSeconds = partyMargin / fillRate
```

Before automatic joining, replace the simple rate with a smoothed rate and add a safety reserve for feed latency, simultaneous outside joins and OpenFront initialization time. Never treat the estimate as a reservation.

## Companion architecture

The preferred production path is either an upstream OpenFront contribution or a small browser extension. A userscript is acceptable for an early opt-in prototype.

```text
Lobby viewer                         OpenFront tab
────────────                         ─────────────
votes + filter matches               official game client
fill-window estimator                official auth + Turnstile
          │                                   │
          └──── ephemeral party relay ────────┘
                     │
                companion bridge
          receives selected game ID
          navigates to official game URL
          reports lobby/in-game/finished state
```

Required relay additions:

1. Per-member resume token so identity survives page changes and WebSocket reconnects.
2. A room lifetime independent of the viewer tab, with a bounded reconnect grace period.
3. Join phases: `watching`, `armed`, `opening`, `in_lobby`, `in_game`, `finished`, `failed`.
4. A versioned `join.command` containing only game ID, worker and expiry.
5. Member acknowledgements so the leader sees who actually reached the lobby.

Required companion behavior:

1. Explicit per-user opt-in for automatic navigation.
2. Connect to the party relay using the resume token, never OpenFront credentials.
3. On a fresh, non-stale `join.command`, navigate the current OpenFront tab to the official game URL.
4. Let OpenFront perform its normal existence check, token acquisition and join.
5. Report coarse state back to the relay without reading or transmitting secrets.
6. Stop and show the user when the lobby is full, the feed is stale, Turnstile needs interaction or the official client rejects the join.

## Delivery order

1. **Board-first UI and telemetry** — current phase.
2. **Reliable readiness model** — collect real fill traces and tune reserve/lead-time thresholds.
3. **Resume protocol** — keep party identity through navigation and reconnects.
4. **Opt-in companion prototype** — official URL navigation and coarse state reporting only.
5. **Multi-game loop** — return finished members to `watching`, vote again and issue the next expiring join command.
6. **Upstream proposal** — prefer a native OpenFront event/API over long-term DOM automation.

## Non-negotiable boundaries

- No credential, cookie, play-token or Turnstile-token collection.
- No undocumented OpenFront join packets.
- No bypass of capacity, account, IP, anti-abuse or allowlist checks.
- No automatic navigation without explicit opt-in and a visible armed state.
- No join command based on stale lobby data.
