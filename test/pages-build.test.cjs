const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const root = path.resolve(__dirname, "..");

test("GitHub Pages publishes the standalone OpenFront lobby board", () => {
  const result = spawnSync(process.execPath, ["scripts/build-pages.cjs"], {
    cwd: root,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);

  const output = path.join(root, "_site");
  const indexHtml = fs.readFileSync(path.join(output, "index.html"), "utf8");
  const styles = fs.readFileSync(path.join(output, "styles.css"), "utf8");

  assert.match(indexHtml, /id="cardGrid"/);
  assert.match(indexHtml, /href="https:\/\/discord\.com\/users\/1397288335290138734"/);
  assert.match(indexHtml, /<span class="discord-name">D_D<\/span>/);
  assert.match(indexHtml, /<span class="discordRoleLabel">Original Gangsters<\/span>/);
  assert.match(indexHtml, /<span class="discordRoleLabel">Site Host<\/span>/);
  assert.match(indexHtml, /aria-label="Original Gangsters"[\s\S]*Kale[\s\S]*Wonder[\s\S]*aria-label="Site Host"[\s\S]*D_D/);
  assert.match(indexHtml, /\{ key: "custom", label: "Custom Lobby" \}/);
  assert.match(indexHtml, /return publicType === "hosted";/);
  assert.doesNotMatch(indexHtml, /publicType === "hosted" \|\|/);
  assert.doesNotMatch(indexHtml, /startsAt === null/);
  assert.match(indexHtml, /isCustomLobby\(g\) \? "custom"/);
  assert.match(indexHtml, /function standardGameModifierDetails\(g\)/);
  assert.match(indexHtml, /function customGameModifierDetails\(g\)/);
  assert.match(indexHtml, /isCustomLobby\(g\)[\s\S]*customGameModifierDetails\(g\)[\s\S]*standardGameModifierDetails\(g\)/);
  assert.match(indexHtml, /class="cardBadge \$\{escapeHtml\(detail\.tone\)\}"/);
  assert.doesNotMatch(indexHtml, /class="gameCardSettings"/);
  assert.match(indexHtml, /Disabled Units:/);
  assert.match(indexHtml, /Host: Infinite Gold/);
  assert.match(indexHtml, /PVP Immunity Duration:/);
  assert.match(indexHtml, /function formatPvpImmunityDuration\(seconds\)/);
  assert.match(indexHtml, /`\$\{minutes\}min`/);
  assert.doesNotMatch(indexHtml, /Spawn Immunity:/);
  assert.doesNotMatch(indexHtml, /Start Delay:/);
  assert.doesNotMatch(indexHtml, /push\("Nations Disabled"\)/);
  assert.match(indexHtml, /href="styles\.css\?v=[a-f0-9]{12}"/);
  assert.match(styles, /data-cat="custom"/);
  assert.match(styles, /grid-template-columns: repeat\(3, minmax\(0, 1fr\)\)/);
  assert.match(styles, /grid-column: 1 \/ -1/);
  assert.match(styles, /grid-auto-flow: column/);
  assert.match(styles, /overflow-x: auto/);
  assert.match(styles, /\.discordRoleLabel/);
  assert.match(styles, /\.discordRoleButtons/);
  assert.doesNotMatch(styles, /max-height: 602px/);
  assert.match(indexHtml, /col\.key === "custom" \? 0 : COLUMN_MIN_SLOTS/);
  assert.match(indexHtml, /function handleCustomLobbyWheel\(event\)/);
  assert.match(indexHtml, /addEventListener\("wheel", handleCustomLobbyWheel, \{ passive: false \}\)/);
  assert.match(indexHtml, /function animateCustomLobbyScroll\(host, scrollState, start, target, startedAt, now\)/);
  assert.match(indexHtml, /CUSTOM_LOBBY_SCROLL_DURATION = 220/);
  assert.match(indexHtml, /const eased = 1 - Math\.pow\(1 - progress, 4\)/);
  assert.match(indexHtml, /cancelAnimationFrame\(scrollState\.frame\)/);
  assert.match(indexHtml, /requestAnimationFrame\(\(time\) => animateCustomLobbyScroll\(host, scrollState, start, scrollState\.target, startedAt, time\)\)/);
  assert.match(indexHtml, /function sortCustomLobbiesByPlayers\(games\)/);
  assert.match(indexHtml, /buckets\.custom = sortCustomLobbiesByPlayers\(buckets\.custom\)/);
  assert.match(indexHtml, /function captureViewportAnchor\(\)/);
  assert.match(indexHtml, /function restoreViewportAnchor\(anchor\)/);
  assert.match(indexHtml, /window\.scrollBy\(0, offset\)/);
  assert.match(indexHtml, /restoreViewportAnchor\(viewportAnchor\);[\s\S]*if \(prevRects\) flipCards\(prevRects\)/);
  assert.match(indexHtml, /CUSTOM_LOBBY_REFRESH_MS = 60_000/);
  assert.match(indexHtml, /data-card-revision=/);
  assert.match(indexHtml, /node\.dataset\.cardRevision !== cardRevision/);
  assert.match(indexHtml, /let entry = cache\.get\(id\)/);
  assert.match(indexHtml, /refreshCustomLobbyCards\(buckets\.custom\)/);
  assert.match(indexHtml, /setInterval\(scheduleRender, CUSTOM_LOBBY_REFRESH_MS\)/);
  assert.match(indexHtml, /column\.key === "custom" \? `@\$\{g\.cardRevision \?\? 0\}` : ""/);
  assert.match(styles, /\.cardBadge\.danger/);
  assert.doesNotMatch(indexHtml, /party|companion/i);
  assert.doesNotMatch(styles, /party|companion/i);
  assert.equal(fs.existsSync(path.join(output, "party.js")), false);
  assert.equal(fs.existsSync(path.join(output, "config.js")), false);
  assert.equal(fs.existsSync(path.join(output, "privacy.html")), false);
  assert.equal(fs.existsSync(path.join(output, "history")), false);
  assert.equal(fs.existsSync(path.join(output, "openfront-party-companion.user.js")), false);
});

test("only hosted games are routed to Custom Lobby", () => {
  const source = fs.readFileSync(path.join(root, "viewer", "index.html"), "utf8");
  const match = source.match(/function isCustomLobby\(g\) \{[\s\S]*?\n      \}/);
  assert.ok(match, "isCustomLobby should be present in the standalone viewer");

  const isCustomLobby = Function(`"use strict"; return (${match[0]});`)();
  const games = [
    { id: "ffa-open", startsAt: null, raw: { __rawType: "ffa" } },
    { id: "team-open", startsAt: null, raw: { __rawType: "team" } },
    { id: "special-open", startsAt: null, raw: { __rawType: "special" } },
    { id: "hosted-open", startsAt: null, raw: { __rawType: "hosted" } },
    { id: "hosted-timed", startsAt: Date.now() + 60_000, raw: { publicGameType: "hosted" } },
  ];
  const buckets = { ffa: [], team: [], special: [], custom: [] };

  for (const game of games) {
    const category = isCustomLobby(game)
      ? "custom"
      : (game.raw.__rawType || game.raw.publicGameType);
    buckets[category].push(game.id);
  }

  assert.deepEqual(buckets, {
    ffa: ["ffa-open"],
    team: ["team-open"],
    special: ["special-open"],
    custom: ["hosted-open", "hosted-timed"],
  });
  assert.equal(Object.values(buckets).flat().length, games.length);
});

test("Custom Lobby wheel scrolling uses duration-based easing", () => {
  const source = fs.readFileSync(path.join(root, "viewer", "index.html"), "utf8");
  assert.match(source, /CUSTOM_LOBBY_SCROLL_DURATION = 220/);
  assert.match(source, /const progress = Math\.min\(1, \(now - startedAt\) \/ CUSTOM_LOBBY_SCROLL_DURATION\)/);
  assert.match(source, /const eased = 1 - Math\.pow\(1 - progress, 4\)/);
  assert.match(source, /cancelAnimationFrame\(scrollState\.frame\)/);
  assert.match(source, /event\.preventDefault\(\);\n        const nextTarget/);
  assert.match(source, /if \(nextTarget === scrollState\.target\) return/);
  assert.doesNotMatch(source, /const atStart = delta < 0/);
  assert.doesNotMatch(source, /const atEnd = delta > 0/);
});

test("Custom Lobby cards stay ordered by player count with stable ties", () => {
  const source = fs.readFileSync(path.join(root, "viewer", "index.html"), "utf8");
  const match = source.match(/function sortCustomLobbiesByPlayers\(games\) \{[\s\S]*?\n      \}/);
  assert.ok(match, "Custom Lobby player-count sorter should be present");

  const sortCustomLobbiesByPlayers = Function(`"use strict"; return (${match[0]});`)();
  const games = [
    { id: "z-last", joined: 1 },
    { id: "b-tie", joined: 8 },
    { id: "a-tie", joined: 8 },
    { id: "top", joined: 12 },
  ];

  assert.deepEqual(sortCustomLobbiesByPlayers(games).map((game) => game.id), ["top", "a-tie", "b-tie", "z-last"]);
  assert.deepEqual(games.map((game) => game.id), ["z-last", "b-tie", "a-tie", "top"], "sorting does not mutate source data");
});

test("structural updates preserve the visible lobby column position", () => {
  const source = fs.readFileSync(path.join(root, "viewer", "index.html"), "utf8");
  const start = source.indexOf("function captureViewportAnchor()");
  const end = source.indexOf("function applyStructure(", start);
  assert.ok(start >= 0 && end > start, "viewport anchor helpers should be present");

  let targetTop = 100;
  const target = {
    isConnected: true,
    getBoundingClientRect() {
      return { top: targetTop, bottom: targetTop + 500 };
    },
  };
  const elements = [
    { getBoundingClientRect: () => ({ top: -500, bottom: -10 }) },
    target,
    { getBoundingClientRect: () => ({ top: 700, bottom: 1200 }) },
  ];
  const scrollCalls = [];
  const fakeWindow = {
    innerHeight: 800,
    scrollBy(x, y) { scrollCalls.push([x, y]); },
  };
  const helpers = Function(
    "els",
    "window",
    "document",
    `"use strict"; ${source.slice(start, end)}; return { captureViewportAnchor, restoreViewportAnchor };`
  )(
    { cardGrid: { querySelectorAll: () => elements } },
    fakeWindow,
    { documentElement: { clientHeight: 800 } }
  );

  const anchor = helpers.captureViewportAnchor();
  assert.equal(anchor.element, target);
  assert.equal(anchor.top, 100);

  targetTop = 260;
  helpers.restoreViewportAnchor(anchor);
  assert.deepEqual(scrollCalls, [[0, 160]]);
});

test("all custom lobby snapshot data refreshes immediately under the same game ID", () => {
  const source = fs.readFileSync(path.join(root, "viewer", "index.html"), "utf8");
  const start = source.indexOf("const CUSTOM_LOBBY_REFRESH_MS");
  const end = source.indexOf("function refreshCustomLobbyCards(", start);
  assert.ok(start >= 0 && end > start, "custom lobby revision helpers should be present");

  const { refreshCustomLobbyRevision } = Function(
    `"use strict"; ${source.slice(start, end)}; return { refreshCustomLobbyRevision };`
  )();
  const cache = new Map();
  const lobby = {
    id: "hosted-123",
    map: "Europe",
    kind: "ffa",
    format: null,
    teamCount: null,
    playersPerTeam: null,
    maxPlayers: 40,
    cfg: { startingGold: 5_000_000, randomSpawn: false },
    raw: {
      gameID: "hosted-123",
      numClients: 5,
      startsAt: 1_000,
      hostedBy: "first-host",
    },
  };

  assert.equal(refreshCustomLobbyRevision(cache, lobby, 0), 1);

  lobby.map = "North America";
  lobby.cfg = { randomSpawn: true, startingGold: 25_000_000 };
  assert.equal(refreshCustomLobbyRevision(cache, lobby, 1_000), 2, "map and settings refresh on the next snapshot");

  lobby.cfg = { startingGold: 25_000_000, randomSpawn: true };
  assert.equal(refreshCustomLobbyRevision(cache, lobby, 2_000), 2, "object key order does not create a false change");

  lobby.raw.hostedBy = "second-host";
  assert.equal(refreshCustomLobbyRevision(cache, lobby, 3_000), 3, "previously unknown raw fields can change");

  lobby.kind = "team";
  lobby.teamCount = 2;
  lobby.cfg.gameMode = "team";
  assert.equal(refreshCustomLobbyRevision(cache, lobby, 4_000), 4, "the displayed game type can change");

  lobby.raw.numClients = 12;
  lobby.raw.startsAt = 2_000;
  assert.equal(refreshCustomLobbyRevision(cache, lobby, 5_000), 4, "live player and countdown fields do not rebuild the card");
});
