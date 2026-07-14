# OpenFront Party Coordinator

An independent party coordinator for choosing public OpenFront lobbies together and keeping the party connected while members are playing.

## Run locally

```powershell
npm install
npm start
```

Open <http://localhost:3030/viewer/>. Create or join a party. Players can mark **Ready** and open the selected lobby manually without installing anything.

For optional auto-open behavior, install Tampermonkey and open the companion userscript from:

<http://localhost:3030/openfront-party-companion.user.js>

The relay binds to `127.0.0.1` by default. This keeps port 3030 off other network interfaces and works with an outbound Cloudflare Tunnel. Set `HOST` explicitly only when another local binding is required.

Choose **Connect OpenFront** after installing it. The viewer creates a one-use, 60-second handoff ticket and opens the official OpenFront page. The userscript claims the ticket and keeps that party member present while the viewer tab is closed.

## Party flow

- Lobby cards show filter matches, Democracy votes, free capacity, and an estimated join window.
- The selected card exposes **Launch party** to the leader.
- **Wait for everyone** launches only when every member is Ready.
- **Launch ready members** starts a split round and leaves active members in their current game.
- Once a launched member confirms that OpenFront reached the lobby or game, remaining members receive a persistent **PARTY MOVED** notification.
- Remaining members can follow the next round, explicitly leave and follow while the lobby is still safe, or stay in their current match.

## Verified launch pipeline

1. The viewer reads OpenFront's public `/{worker}/lobbies` WebSocket feed.
2. The leader's viewer sends a current observation of the selected lobby to the relay.
3. The relay accepts a launch only while that observation is fresh, the lobby has room and its start is not imminent.
4. Members marked **Ready** are included in the launch; connected companions also receive `join.command`.
5. Ready members can open OpenFront's official `/{worker}/game/{gameId}` URL manually, or let the companion navigate there when connected.
6. OpenFront performs its own lobby existence, capacity, authentication and Turnstile checks.
7. The companion reports `in_lobby` only after OpenFront has received lobby information with the member's client ID, or `in_game` after `body.in-game` appears.

The public lobby feed is an observation, not a reservation. OpenFront remains authoritative and may reject a join if outside players fill the lobby during the launch window.

## GitHub Pages prototype

GitHub Pages hosts only the static viewer and userscript. The Node relay must remain on a separate public HTTPS/WSS origin, such as a Cloudflare Tunnel during testing.

Build the Pages artifact locally with:

```powershell
$env:PARTY_RELAY_ORIGIN = "https://your-relay.example.com"
npm run build:pages
```

The generated `_site` directory contains:

- `/viewer/` — the lobby viewer configured for the relay;
- `/openfront-party-companion.user.js` — the optional userscript;
- `/index.html` — a relative redirect that also works under `username.github.io/repository/`.

The repository includes a `.github/workflows/pages.yml` workflow that deploys pushes to `main` and can also be started manually. Before running it:

1. create the GitHub repository and push this project;
2. set repository variable `PARTY_RELAY_ORIGIN` to the public HTTPS relay origin;
3. choose **Settings → Pages → Source: GitHub Actions**;
4. push `main` or run **Deploy GitHub Pages prototype** from the Actions tab.

The Discord profile buttons in the viewer header are retained as the original creator credits.

## Companion behavior

The userscript runs only on `https://openfront.io/*`. It observes the official URL, `body.in-game`, and `win-modal` to report coarse phases. It shows a draggable party panel and navigates to an official game URL only when the user has explicitly selected **Ready for next game**.

For production, deploy the relay behind public HTTPS/WSS and use that origin when opening the viewer. The userscript accepts the relay origin only through the one-use connection fragment.

## Security boundaries

- The relay and userscript never read or transmit OpenFront cookies, credentials, play tokens, Turnstile responses, or gameplay messages.
- Companion credentials are random bearer tokens; only their SHA-256 hashes are retained by the relay.
- Handoff tickets are one-use and expire after 60 seconds.
- Join commands contain only a worker, game ID, round ID, and short expiry.
- Active players are never navigated automatically.
- Rooms remain in memory and do not survive a relay process restart.
