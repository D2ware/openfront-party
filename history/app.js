(() => {
  "use strict";

  const config = window.OPENFRONT_TRACKER_CONFIG || {};
  const relay = new URL(config.relayOrigin || location.origin, location.href).origin;
  const selectedProfileId = new URLSearchParams(location.search).get("player") || "";
  const colors = ["#66e2a2", "#70c2ff", "#a78bfa", "#f0c86b", "#f17972", "#55d6be", "#f59e58"];

  const el = Object.fromEntries([
    "profileName", "profileId", "profileUpdated", "profileStats", "formSummary", "formDots",
    "modeFilter", "mapFilter", "resultFilter", "refresh", "matchFeed", "topMaps",
    "playerSearch", "playerSearchInput", "searchResults", "installScript",
  ].map((id) => [id, document.getElementById(id)]));

  const state = { payload: null, expanded: new Set(), loading: false };

  if (el.installScript) el.installScript.href = new URL(config.userscriptPath || "../openfront-party-companion.user.js", location.href).href;

  function node(tag, className, text) {
    const item = document.createElement(tag);
    if (className) item.className = className;
    if (text !== undefined) item.textContent = text;
    return item;
  }

  function titleCase(value) {
    return String(value || "")
      .replace(/([a-z])([A-Z])/g, "$1 $2")
      .replace(/[_-]+/g, " ")
      .replace(/\b\w/g, (letter) => letter.toUpperCase()) || "OpenFront match";
  }

  function compact(value) {
    let amount;
    try { amount = BigInt(value || 0); } catch { return "0"; }
    for (const [size, suffix] of [[1_000_000_000n, "B"], [1_000_000n, "M"], [1_000n, "K"]]) {
      if (amount < size) continue;
      const tenth = (amount % size) * 10n / size;
      return `${amount / size}${tenth ? `.${tenth}` : ""}${suffix}`;
    }
    return amount.toString();
  }

  function dateLabel(value) {
    if (!value) return "Time unavailable";
    const date = new Date(value);
    const distance = Date.now() - date.getTime();
    if (distance >= 0 && distance < 60_000) return "Just now";
    if (distance >= 0 && distance < 3_600_000) return `${Math.max(1, Math.round(distance / 60_000))}m ago`;
    if (distance >= 0 && distance < 86_400_000) return `${Math.round(distance / 3_600_000)}h ago`;
    return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(date);
  }

  function duration(match) {
    const seconds = Math.max(0, Math.round(((match.endedAt || 0) - (match.startedAt || 0)) / 1000));
    if (!seconds) return "Duration unavailable";
    return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
  }

  function mapSlug(value) {
    return String(value || "world").toLowerCase().replace(/[^a-z0-9]+/g, "");
  }

  function mapImage(value) {
    return `https://raw.githubusercontent.com/openfrontio/OpenFrontIO/main/map-generator/assets/maps/${mapSlug(value)}/image.png`;
  }

  function reportFor(match) {
    return selectedProfileId
      ? match.players.find((player) => player.profileId === selectedProfileId) || match.players[0] || {}
      : match.players[0] || {};
  }

  function outcomeOf(report) {
    if (report.outcome) return report.outcome;
    return report.won === true ? "victory" : report.won === false ? "defeat" : "unknown";
  }

  function outcomeLabel(outcome) {
    return ({ victory: "Victory", defeat: "Defeat", eliminated: "Eliminated", likely_defeat: "Likely defeat", unknown: "Reported" })[outcome] || "Reported";
  }

  function resultNote(report) {
    if (report.outcome === "likely_defeat") return "Left before the result was confirmed";
    if (report.outcome === "eliminated") return "OpenFront confirmed the player was eliminated";
    if (report.resultConfidence === "confirmed") return "Result confirmed from the OpenFront match stream";
    return "Result reported by the userscript";
  }

  function metric(label, value, className = "") {
    const item = node("div", `metric ${className}`.trim());
    item.append(node("span", "", label), node("strong", "", value));
    return item;
  }

  function placementMetric(report, match) {
    const item = node("div", "metric placement");
    item.append(node("span", "", report.mode === "ffa" || match.mode === "ffa" ? "FFA finish" : "Result field"));
    const value = node("div", "placementValue");
    const position = Number(report.finishPosition || 0);
    const field = Number(report.playerCount || match.playerCount || 0);
    value.append(node("b", "", position ? `#${position}` : "—"), node("small", "", field ? `of ${field}` : "field unavailable"));
    const track = node("div", "placementTrack");
    const marker = node("i");
    const ratio = position > 0 && field > 1 ? ((position - 1) / (field - 1)) * 100 : 50;
    track.style.setProperty("--placement", `${Math.min(100, Math.max(0, ratio))}%`);
    track.append(marker);
    item.append(value, track);
    return item;
  }

  function playerTable(match) {
    const table = node("table", "playerTable");
    const head = node("thead");
    const headingRow = node("tr");
    for (const label of ["Player", "Result", "Territory", "Gold", "Attacks", "Donated"]) headingRow.append(node("th", "", label));
    head.append(headingRow);
    const body = node("tbody");
    match.players.forEach((player, index) => {
      const row = node("tr", player.profileId === selectedProfileId ? "me" : "");
      const identity = node("td");
      const name = node("span", "playerName");
      const dot = node("i");
      dot.style.setProperty("--player-color", colors[index % colors.length]);
      name.append(dot, document.createTextNode(player.name || "OpenFront player"));
      identity.append(name);
      row.append(
        identity,
        node("td", "confidence", outcomeLabel(outcomeOf(player))),
        node("td", "", Number(player.finalTiles || 0).toLocaleString()),
        node("td", "", compact(player.goldGenerated)),
        node("td", "", compact(player.attackTroops)),
        node("td", "", compact(player.donatedTroops)),
      );
      body.append(row);
    });
    table.append(head, body);
    return table;
  }

  function matchCard(match) {
    const report = reportFor(match);
    const outcome = outcomeOf(report);
    const card = node("article", `matchCard ${outcome}`);
    const summary = node("div", "matchSummary");
    const thumbnail = node("div", "mapThumb");
    const image = node("img");
    image.src = mapImage(match.map);
    image.alt = "";
    image.loading = "lazy";
    image.addEventListener("error", () => image.remove());
    thumbnail.append(image);
    const identity = node("div", "matchIdentity");
    const result = node("div", "resultLabel");
    result.append(node("i"), document.createTextNode(outcomeLabel(outcome)));
    identity.append(
      result,
      node("h3", "", titleCase(match.map)),
      node("p", "", `${titleCase(match.mode || report.mode || "OpenFront")} · ${duration(match)}`),
      node("small", "", `${dateLabel(match.endedAt)} · ${match.gameId}`),
    );
    const metrics = node("div", "matchMetrics");
    metrics.append(
      placementMetric(report, match),
      metric("Territory", Number(report.finalTiles || 0).toLocaleString()),
      metric("Gold generated", compact(report.goldGenerated)),
      metric("Attack sent", compact(report.attackTroops)),
      metric("Donated", compact(report.donatedTroops)),
    );
    const expand = node("button", "expandMatch", state.expanded.has(match.gameId) ? "⌃" : "⌄");
    expand.type = "button";
    expand.setAttribute("aria-label", `${state.expanded.has(match.gameId) ? "Collapse" : "Expand"} ${titleCase(match.map)} match`);
    expand.setAttribute("aria-expanded", String(state.expanded.has(match.gameId)));
    expand.addEventListener("click", () => {
      state.expanded.has(match.gameId) ? state.expanded.delete(match.gameId) : state.expanded.add(match.gameId);
      renderMatches();
    });
    summary.append(thumbnail, identity, metrics, expand);
    card.append(summary);
    if (state.expanded.has(match.gameId)) {
      const detail = node("div", "matchDetail");
      const note = node("p", "detailNote");
      note.append(node("i"), document.createTextNode(resultNote(report)));
      detail.append(note, playerTable(match));
      card.append(detail);
    }
    return card;
  }

  function filteredMatches() {
    const matches = state.payload?.matches || [];
    return matches.filter((match) => {
      const report = reportFor(match);
      const mode = String(report.mode || match.mode || "").toLowerCase();
      return (el.modeFilter.value === "all" || mode === el.modeFilter.value)
        && (el.mapFilter.value === "all" || match.map === el.mapFilter.value)
        && (el.resultFilter.value === "all" || outcomeOf(report) === el.resultFilter.value);
    });
  }

  function renderMatches() {
    el.matchFeed.replaceChildren();
    const matches = filteredMatches();
    el.matchFeed.setAttribute("aria-busy", "false");
    if (!matches.length) {
      const empty = node("article", "feedMessage");
      empty.append(node("h3", "", "No matching reports"), node("p", "", "Change the filters or play a match with the userscript active."));
      el.matchFeed.append(empty);
      return;
    }
    matches.forEach((match) => el.matchFeed.append(matchCard(match)));
  }

  function renderProfile() {
    const { profile, summary, matches = [] } = state.payload;
    el.profileName.textContent = profile?.name || "OpenFront Tracker";
    el.profileId.textContent = profile ? `#${profile.id}` : "All reported matches";
    el.profileUpdated.textContent = profile?.lastReportAt ? `Last report ${dateLabel(profile.lastReportAt)}` : `${matches.length} public reports`;
    const values = profile && summary ? [
      [summary.ffa.averageFinish ? `#${summary.ffa.averageFinish.toFixed(1)}` : "—", summary.ffa.averageField ? `of ${summary.ffa.averageField.toFixed(0)} players` : "confirmed FFA games"],
      [summary.ffa.top10Rate !== null ? `${Math.round(summary.ffa.top10Rate * 100)}%` : "—", "of the starting field"],
      [summary.ffa.winIndex !== null ? `${summary.ffa.winIndex.toFixed(1)}×` : "—", "versus expected wins"],
      [summary.team.winRate !== null ? `${Math.round(summary.team.winRate * 100)}%` : "—", `${summary.team.matches} team games`],
    ] : [["—", "Select a player"], ["—", "Select a player"], ["—", "Select a player"], ["—", "Select a player"]];
    [...el.profileStats.children].forEach((item, index) => {
      item.querySelector("strong").textContent = values[index][0];
      item.querySelector("small").textContent = values[index][1];
    });
    const reports = matches.map(reportFor).filter(Boolean).slice(0, 12);
    el.formDots.replaceChildren();
    reports.forEach((report) => {
      const outcome = outcomeOf(report);
      const dot = node("i", outcome, outcome === "victory" ? "W" : outcome === "likely_defeat" ? "?" : "L");
      dot.title = outcomeLabel(outcome);
      el.formDots.append(dot);
    });
    el.formSummary.textContent = reports.length ? `${reports.filter((report) => outcomeOf(report) === "victory").length} wins in ${reports.length}` : "Waiting for reports";
  }

  function renderMapFilter() {
    const selected = el.mapFilter.value;
    const maps = [...new Set((state.payload?.matches || []).map((match) => match.map).filter(Boolean))].sort();
    el.mapFilter.replaceChildren(node("option", "", "All maps"));
    el.mapFilter.firstChild.value = "all";
    maps.forEach((map) => {
      const option = node("option", "", titleCase(map));
      option.value = map;
      el.mapFilter.append(option);
    });
    el.mapFilter.value = maps.includes(selected) ? selected : "all";
  }

  function renderTopMaps() {
    const totals = new Map();
    for (const match of state.payload?.matches || []) totals.set(match.map, (totals.get(match.map) || 0) + 1);
    el.topMaps.querySelector(".contextEmpty, .mapRows")?.remove();
    if (!totals.size) {
      el.topMaps.append(node("div", "contextEmpty", "Map totals appear after the first report."));
      return;
    }
    const rows = node("div", "mapRows");
    [...totals].sort((a, b) => b[1] - a[1]).slice(0, 5).forEach(([map, games]) => {
      const row = node("div", "mapRow");
        row.append(node("strong", "", titleCase(map)), node("small", "", games === 1 ? "one report" : `${games} reports`), node("b", "", games));
      rows.append(row);
    });
    el.topMaps.append(rows);
  }

  function render() {
    renderProfile();
    renderMapFilter();
    renderTopMaps();
    if (state.payload.matches?.length && !state.expanded.size) state.expanded.add(state.payload.matches[0].gameId);
    renderMatches();
  }

  async function load() {
    if (state.loading) return;
    state.loading = true;
    el.refresh.disabled = true;
    try {
      const query = new URLSearchParams({ limit: "60" });
      if (selectedProfileId) query.set("player", selectedProfileId);
      const response = await fetch(`${relay}/api/tracker/overview?${query}`, { cache: "no-store" });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "Match history is unavailable.");
      state.payload = payload;
      render();
    } catch (error) {
      el.matchFeed.replaceChildren();
      const message = node("article", "feedMessage");
      message.append(node("h3", "", "Tracker feed unavailable"), node("p", "", error.message));
      el.matchFeed.append(message);
      el.matchFeed.setAttribute("aria-busy", "false");
    } finally {
      state.loading = false;
      el.refresh.disabled = false;
    }
  }

  async function searchPlayers(query) {
    if (!query.trim()) { el.searchResults.hidden = true; return; }
    try {
      const response = await fetch(`${relay}/api/tracker/profiles?q=${encodeURIComponent(query.trim())}`, { cache: "no-store" });
      const payload = await response.json();
      el.searchResults.replaceChildren();
      if (!payload.profiles?.length) {
        el.searchResults.append(node("div", "contextEmpty", "No tracked players found."));
      } else {
        payload.profiles.forEach((profile) => {
          const link = node("a");
          link.href = `?player=${encodeURIComponent(profile.id)}`;
          link.append(node("b", "", profile.name), node("small", "", `#${profile.id}`), node("span", "", "→"));
          el.searchResults.append(link);
        });
      }
      el.searchResults.hidden = false;
    } catch { el.searchResults.hidden = true; }
  }

  for (const control of [el.modeFilter, el.mapFilter, el.resultFilter]) control.addEventListener("change", renderMatches);
  el.refresh.addEventListener("click", load);
  el.playerSearch.addEventListener("submit", (event) => { event.preventDefault(); void searchPlayers(el.playerSearchInput.value); });
  el.playerSearchInput.addEventListener("input", () => { if (!el.playerSearchInput.value) el.searchResults.hidden = true; });
  document.addEventListener("click", (event) => { if (!el.playerSearch.contains(event.target)) el.searchResults.hidden = true; });
  void load();
})();
