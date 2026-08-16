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
  assert.match(indexHtml, /els\.cardGrid\.addEventListener\("wheel", handleCustomLobbyWheel, \{ passive: false \}\)/);
  assert.match(indexHtml, /CUSTOM_LOBBY_GESTURE_HOLD_MS = 220/);
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
  assert.match(source, /els\.cardGrid\.addEventListener\("wheel", handleCustomLobbyWheel, \{ passive: false \}\)/);
  assert.doesNotMatch(source, /const atStart = delta < 0/);
  assert.doesNotMatch(source, /const atEnd = delta > 0/);
});

// Runs the viewer's own wheel helpers against a stand-in row, so the handover
// rules between the row and the page are exercised instead of pattern-matched.
function customLobbyWheelHarness({ scrollWidth = 3000, clientWidth = 1000, insideRow = true } = {}) {
  const source = fs.readFileSync(path.join(root, "viewer", "index.html"), "utf8");
  const start = source.indexOf("function customLobbyWheelDelta(");
  const end = source.indexOf("// Build the lobby column shells once.");
  assert.ok(start >= 0 && end > start, "Custom Lobby wheel helpers should be present");

  class Element {}
  const sandbox = Function(
    "WheelEvent",
    "Element",
    "prefersReducedMotion",
    "requestAnimationFrame",
    "cancelAnimationFrame",
    `"use strict";
     ${source.slice(start, end)}
     return { handleCustomLobbyWheel, CUSTOM_LOBBY_GESTURE_HOLD_MS };`,
  )(
    { DOM_DELTA_LINE: 1, DOM_DELTA_PAGE: 2 },
    Element,
    () => true,                                   // reduced motion: land on the target at once
    () => 0,
    () => {},
  );

  const host = { scrollWidth, clientWidth, scrollLeft: 0 };
  const column = { querySelector: () => host };
  const target = Object.assign(Object.create(Element.prototype), {
    closest: () => (insideRow ? column : null),
  });

  return {
    host,
    holdMs: sandbox.CUSTOM_LOBBY_GESTURE_HOLD_MS,
    wheel(deltaY, extra = {}) {
      const event = {
        deltaY,
        deltaX: 0,
        deltaMode: 0,
        ctrlKey: false,
        timeStamp: 0,
        target,
        prevented: false,
        preventDefault() { this.prevented = true; },
        ...extra,
      };
      sandbox.handleCustomLobbyWheel(event);
      return event;
    },
  };
}

test("wheel over a sideways Custom Lobby row scrolls the row instead of the page", () => {
  const row = customLobbyWheelHarness();

  const first = row.wheel(100, { timeStamp: 0 });
  assert.equal(first.prevented, true, "the row takes the wheel over");
  assert.equal(row.host.scrollLeft, 100);

  const second = row.wheel(100, { timeStamp: 40 });
  assert.equal(second.prevented, true);
  assert.equal(row.host.scrollLeft, 200, "deltas accumulate along the row");

  const back = row.wheel(-50, { timeStamp: 80 });
  assert.equal(back.prevented, true);
  assert.equal(row.host.scrollLeft, 150, "wheeling up walks the row back");
});

test("Custom Lobby hands the wheel back to the page at both ends of the row", () => {
  const row = customLobbyWheelHarness();

  assert.equal(row.wheel(-100, { timeStamp: 0 }).prevented, false, "already parked at the start");
  assert.equal(row.host.scrollLeft, 0);

  row.host.scrollLeft = 2000;                     // parked against the end
  assert.equal(row.wheel(100, { timeStamp: 500 }).prevented, false, "already parked at the end");
  assert.equal(row.host.scrollLeft, 2000);
});

test("a flick that lands on the end of the Custom Lobby row keeps its grip", () => {
  const row = customLobbyWheelHarness();

  row.host.scrollLeft = 0;
  assert.equal(row.wheel(1900, { timeStamp: 1000 }).prevented, true);
  assert.equal(row.host.scrollLeft, 1900);

  assert.equal(row.wheel(400, { timeStamp: 1030 }).prevented, true, "the flick lands on the end, not on the page");
  assert.equal(row.host.scrollLeft, 2000, "the row stops at its end");

  assert.equal(
    row.wheel(400, { timeStamp: 1040 + row.holdMs }).prevented,
    false,
    "once the flick is over the page scrolls again",
  );
});

test("Custom Lobby leaves gestures it has no business taking", () => {
  const fits = customLobbyWheelHarness({ scrollWidth: 900 });
  assert.equal(fits.wheel(100).prevented, false, "a row that fits never takes the wheel");

  const row = customLobbyWheelHarness();
  assert.equal(row.wheel(100, { ctrlKey: true }).prevented, false, "pinch-to-zoom stays a zoom");
  assert.equal(row.wheel(20, { deltaX: -90 }).prevented, false, "a sideways trackpad swipe scrolls natively");
  assert.equal(row.wheel(0).prevented, false, "no vertical delta, nothing to convert");
  assert.equal(row.host.scrollLeft, 0);

  const outside = customLobbyWheelHarness({ insideRow: false });
  assert.equal(outside.wheel(100).prevented, false, "wheeling over the other columns scrolls the page");
});

test("Custom Lobby re-aims after the row is scrolled by other means", () => {
  const row = customLobbyWheelHarness();

  assert.equal(row.wheel(300, { timeStamp: 0 }).prevented, true);
  assert.equal(row.host.scrollLeft, 300);

  row.host.scrollLeft = 1200;                     // scrollbar drag / touch swipe
  row.wheel(100, { timeStamp: 60 });
  assert.equal(row.host.scrollLeft, 1300, "the next wheel continues from where the row actually sits");
});

test("Custom Lobby wheel deltas respect the browser's delta mode", () => {
  const lines = customLobbyWheelHarness();
  lines.wheel(3, { deltaMode: 1 });
  assert.equal(lines.host.scrollLeft, 48, "line deltas are scaled to pixels");

  const pages = customLobbyWheelHarness();
  pages.wheel(1, { deltaMode: 2 });
  assert.equal(pages.host.scrollLeft, 1000, "page deltas move one row width");
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
