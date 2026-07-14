# OpenFront Party Coordinator

An independent party coordinator for choosing public OpenFront lobbies together and keeping the party connected while members are playing.

## Run locally

```powershell
npm install
npm start
```

Open <http://localhost:3030/viewer/>. Create or join a party. Players can mark **Ready** and open the selected lobby manually without installing anything.

For automatic launches and match reports, build and install the browser extension:

```powershell
npm run build:extensions
```

The build creates separate Chromium and Firefox packages in `dist/`. It also creates `openfront-party-firefox-source-<version>.zip`, the human-readable source archive for AMO review. The former Tampermonkey userscript remains available temporarily for migration, but the WebExtension is the supported companion.

The relay binds to `127.0.0.1` by default. This keeps port 3030 off other network interfaces and works with an outbound Cloudflare Tunnel. Set `HOST` explicitly only when another local binding is required.

Match History and companion metric icons are from [OpenFrontIO](https://github.com/openfrontio/OpenFrontIO/tree/main/resources/images) and are used under [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/).

Choose **Link OpenFront** after installing it. The viewer creates a one-use, 60-second handoff ticket and opens the official OpenFront page. The extension claims the ticket and keeps that party member present while the viewer tab is closed.

Before the handoff, the viewer shows an explicit data disclosure and requires affirmative consent. The public privacy policy is available at `/viewer/privacy.html`. Linking is optional; the lobby board continues to work without the extension.

### Install a development build

- Chrome, Edge, Brave and other Chromium browsers: extract `dist/openfront-party-chrome.zip`, open the browser's extensions page, enable Developer mode, choose **Load unpacked**, and select `dist/chrome`.
- Firefox 128 or newer: open `about:debugging#/runtime/this-firefox`, choose **Load Temporary Add-on**, and select `dist/firefox/manifest.json`. The generated `.xpi` requires Mozilla signing before permanent distribution.

Chrome uses an MV3 service worker. Firefox uses an MV3 background script, a stable Gecko extension ID, and its own AMO data-collection declaration. Both packages share the same companion version and functionality.

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
5. Ready members can open OpenFront's `/game/{gameId}` URL manually, or let the companion navigate there when connected. OpenFront derives the owning worker from the game ID.
6. OpenFront performs its own lobby existence, capacity, authentication and Turnstile checks.
7. The companion reports `in_lobby` only after OpenFront has received lobby information with the member's client ID, or `in_game` after `body.in-game` appears.

The public lobby feed is an observation, not a reservation. OpenFront remains authoritative and may reject a join if outside players fill the lobby during the launch window.

## GitHub Pages prototype

GitHub Pages hosts the static viewer and browser-extension downloads. The Node relay must remain on a separate public HTTPS/WSS origin, such as a Cloudflare Tunnel during testing.

Build the Pages artifact locally with:

```powershell
$env:PARTY_RELAY_ORIGIN = "https://your-relay.example.com"
npm run build:pages
```

The generated `_site` directory contains:

- `/viewer/` — the lobby viewer configured for the relay;
- `/extensions/openfront-party-chrome.zip` — the Chromium development package;
- `/extensions/openfront-party-firefox.xpi` — the unsigned Firefox development package;
- `/extensions/openfront-party-firefox-source.zip` — the matching source package for Mozilla review;
- `/openfront-party-companion.user.js` — the temporary migration userscript;
- `/index.html` — a relative redirect that also works under `username.github.io/repository/`.

The repository includes a `.github/workflows/pages.yml` workflow that deploys pushes to `main` and can also be started manually. Before running it:

1. create the GitHub repository and push this project;
2. set repository variable `PARTY_RELAY_ORIGIN` to the public HTTPS relay origin;
3. choose **Settings → Pages → Source: GitHub Actions**;
4. push `main` or run **Deploy GitHub Pages prototype** from the Actions tab.

The Discord profile buttons in the viewer header are retained as the original creator credits.

## Companion behavior

The extension runs only on `https://openfront.io/*`. It observes the official URL and confirmed local game telemetry to report coarse phases. It shows a draggable party panel and navigates to an official game URL only when the user has explicitly selected **Ready for next game**.

Companion 0.4 also records an opt-in match summary. It identifies the local player from OpenFront's game-server `start` message, confirms builds and donations from game-worker updates, and replaces cumulative build and income totals with OpenFront's own final `WinUpdate` statistics. The latest 20 summaries remain in browser extension storage. When the companion is linked to a party, finalized calculated summaries are also uploaded to the relay and shown in **Match history**; raw gameplay messages are never uploaded.

For production, deploy the relay behind public HTTPS/WSS and build the extensions for that exact origin. The background script rejects relay requests to origins outside the build manifest.

## Security boundaries

- The relay and extension never read or transmit OpenFront cookies, credentials, play tokens, or Turnstile responses.
- A small `MAIN`-world bridge observes only the OpenFront fields needed for the companion. Party credentials stay in the isolated content script, and cross-origin relay requests are performed by the extension background process.
- The extension sends only party state and finalized calculated metrics to the configured relay while linked; raw gameplay messages, OpenFront credentials, and party codes are not stored in match history.
- Companion credentials are random bearer tokens; only their SHA-256 hashes are retained by the relay.
- Handoff tickets are one-use and expire after 60 seconds.
- Join commands contain only a worker, game ID, round ID, and short expiry.
- Active players are never navigated automatically.
- Rooms remain in memory and do not survive a relay process restart.
