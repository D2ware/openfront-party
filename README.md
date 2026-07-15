# OpenFront Tracker & Party Coordinator

An independent userscript, public match tracker and optional party coordinator for [OpenFront](https://openfront.io/).

## What is published

- `/history/` is the standalone player profile and match history site.
- `/viewer/` is the optional lobby and party coordinator.
- `/openfront-party-companion.user.js` is the supported companion for every userscript-capable browser.
- `moss.nonekode.fi` provides the tracker, profile and party APIs over HTTPS/WSS.

Browser extensions are not part of the GitHub Pages release. The userscript is the single supported browser integration.

## Run locally

```powershell
npm install
npm start
```

Open <http://localhost:3030/history/> for the tracker or <http://localhost:3030/viewer/> for the lobby board. The relay binds to `127.0.0.1` by default. Set `HOST` explicitly only when another binding is required.

## Install the userscript

Install a userscript manager such as Tampermonkey or Violentmonkey, then open the published `openfront-party-companion.user.js` URL. The userscript runs only on `https://openfront.io/*`.

Match tracking does not require a Party. On its first run, the script creates a random tracker credential and a public profile link. It then reports:

- player name, match, map, mode, field size and team count;
- confirmed wins from OpenFront's final `WinUpdate`;
- confirmed eliminations from the same `isAlive === false && hasSpawned` state used by OpenFront's death modal;
- an inferred likely defeat when the browser returns to the OpenFront home screen before a result was seen;
- final or last observed territory and the calculated match metrics already shown by the companion.

The last 20 local summaries are retained so failed uploads can be retried. Raw game streams, OpenFront cookies, credentials, play tokens, Turnstile responses and chat are not uploaded.

## FFA statistics

A raw win percentage is misleading when a public FFA can contain roughly 100 players. The profile therefore keeps FFA and team performance separate and emphasizes:

- finish position and starting field size;
- average FFA finish;
- top-10% finish rate;
- expected wins, calculated as the sum of `1 / playerCount` for confirmed FFA matches;
- win index, calculated as `actual wins / expected wins`.

For example, one win in one 100-player FFA has a 1% raw win rate denominator but a `100×` win index for that single match. The index becomes meaningful over a larger sample, while placement describes the non-winning games.

## Party flow

The lobby board works without the userscript. Users can create or join a temporary party, mark Ready, vote for or select a lobby and open it manually. Linking the userscript adds coordinated launches and keeps a member present while the lobby board tab is closed. Party linking does not enable or disable match tracking.

The public lobby feed is an observation, not a reservation. OpenFront remains authoritative and may reject a join if the lobby fills or starts.

## GitHub Pages

Build the Pages artifact with the public relay origin:

```powershell
$env:PARTY_RELAY_ORIGIN = "https://moss.nonekode.fi"
npm run build:pages
```

The output in `_site` is subpath-safe and contains the tracker, lobby board and relay-configured userscript. The repository's Pages workflow publishes pushes to `main`; set the repository variable `PARTY_RELAY_ORIGIN` and choose GitHub Actions as the Pages source.

## API and persistence

Tracker endpoints:

- `POST /api/tracker/register`
- `POST /api/tracker/matches` with the tracker bearer token
- `GET /api/tracker/overview?player={profileId}`
- `GET /api/tracker/profiles?q={name}`

The relay persists a rolling maximum of 2,000 matches and tracker profiles in `data/match-history.json`. Tracker bearer tokens are stored only as SHA-256 hashes. Temporary parties remain in memory and do not survive a relay restart.

The public privacy notice is available at `/viewer/privacy.html`. OpenFront map images and companion metric icons come from [OpenFrontIO](https://github.com/openfrontio/OpenFrontIO) and are used under [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/).
