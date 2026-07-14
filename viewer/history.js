(() => {
  const byId = (id) => document.getElementById(id);
  const el = {
    toggle: byId("matchHistoryToggle"), count: byId("matchHistoryCount"),
    backdrop: byId("matchHistoryBackdrop"), panel: byId("matchHistoryPanel"),
    close: byId("matchHistoryClose"), refresh: byId("matchHistoryRefresh"),
    summary: byId("matchHistorySummary"), list: byId("matchHistoryList"),
  };
  if (!el.toggle || !el.backdrop) return;

  const config = window.OPENFRONT_PARTY_CONFIG || {};
  const relay = new URL(config.relayOrigin || window.OPENFRONT_PARTY_RELAY_ORIGIN || location.origin, location.href).origin;
  const openFrontIconBase = "https://raw.githubusercontent.com/openfrontio/OpenFrontIO/main/resources/images/";
  const icons = Object.freeze({
    territory: `${openFrontIconBase}GridIconWhite.svg`,
    attack: `${openFrontIconBase}SwordIconWhite.svg`,
    troops: `${openFrontIconBase}DonateTroopIconWhite.svg`,
    donatedGold: `${openFrontIconBase}DonateGoldIconWhite.svg`,
    port: `${openFrontIconBase}PortIcon.svg`,
    factory: `${openFrontIconBase}FactoryIconWhite.svg`,
    atom: `${openFrontIconBase}NukeIconWhite.svg`,
    hydrogen: `${openFrontIconBase}MushroomCloudIconWhite.svg`,
    gold: `${openFrontIconBase}GoldCoinIcon.svg`,
  });
  let matches = [];
  let loaded = false;
  let loading = false;
  let lastFocus = null;

  function node(tag, className, text) {
    const item = document.createElement(tag);
    if (className) item.className = className;
    if (text !== undefined) item.textContent = text;
    return item;
  }

  function compact(value) {
    let amount;
    try { amount = BigInt(value || 0); } catch { return "0"; }
    for (const [size, suffix] of [[1_000_000_000n, "B"], [1_000_000n, "M"], [1_000n, "K"]]) {
      if (amount < size) continue;
      const decimal = (amount % size) * 10n / size;
      return `${amount / size}${decimal ? `.${decimal}` : ""}${suffix}`;
    }
    return amount.toString();
  }

  function sum(players, key) {
    return players.reduce((total, player) => {
      try { return total + BigInt(player[key] || 0); } catch { return total; }
    }, 0n).toString();
  }

  function dateLabel(value) {
    if (!value) return "Time unavailable";
    return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
  }

  function icon(name) {
    const image = node("img", "matchHistoryMetricIcon");
    image.src = icons[name];
    image.alt = "";
    image.loading = "lazy";
    return image;
  }

  function metric(label, value, iconName) {
    const item = node("div", "matchHistoryMetric");
    const heading = node("span", "matchHistoryMetricLabel");
    if (iconName) heading.append(icon(iconName));
    heading.append(document.createTextNode(label));
    item.append(heading, node("strong", "", value));
    return item;
  }

  function splitMetric(label, values) {
    const item = node("div", "matchHistoryMetric");
    item.append(node("span", "matchHistoryMetricLabel", label));
    const line = node("strong", "matchHistoryMetricParts");
    values.forEach(({ iconName, value }, index) => {
      const part = node("span", "");
      part.append(icon(iconName), document.createTextNode(value));
      line.append(part);
      if (index < values.length - 1) line.append(document.createTextNode("·"));
    });
    item.append(line);
    return item;
  }

  function playerRow(player) {
    const row = node("div", "matchHistoryPlayer");
    const identity = node("div", "matchHistoryIdentity");
    const result = node("span", `matchHistoryResult ${player.won === true ? "won" : player.won === false ? "lost" : "finished"}`, player.won === true ? "Victory" : player.won === false ? "Finished" : "Reported");
    identity.append(result, node("strong", "", player.name || "Party member"));
    row.append(
      identity,
      metric("Territory", Number(player.finalTiles || 0).toLocaleString(), "territory"),
      metric("Attack sent", compact(player.attackTroops), "attack"),
      splitMetric("Donated", [
        { iconName: "troops", value: compact(player.donatedTroops) },
        { iconName: "donatedGold", value: compact(player.donatedGold) },
      ]),
      splitMetric("Economy", [
        { iconName: "port", value: String(player.portsBuilt || 0) },
        { iconName: "factory", value: String(player.factoriesBuilt || 0) },
      ]),
      splitMetric("Nukes", [
        { iconName: "atom", value: `${player.atomBombs || 0}/${player.atomBombsLanded || 0}` },
        { iconName: "hydrogen", value: `${player.hydrogenBombs || 0}/${player.hydrogenBombsLanded || 0}` },
      ]),
      metric("Gold generated", compact(player.goldGenerated), "gold"),
    );
    return row;
  }

  function matchCard(match, index) {
    const details = node("details", "matchHistoryMatch");
    details.open = index === 0;
    const summary = node("summary", "matchHistoryMatchHead");
    const title = node("div", "matchHistoryMatchTitle");
    title.append(node("span", "", dateLabel(match.endedAt)), node("strong", "", match.map || "OpenFront match"), node("small", "", [match.mode, match.gameId].filter(Boolean).join(" · ")));
    const totalGold = sum(match.players || [], "goldGenerated");
    const rail = node("div", "matchHistoryRail");
    for (const [kind, label, value] of [
      ["map", "Battlefield", match.map || "OpenFront"],
      ["players", "Reports", `${match.players?.length || 0} player${match.players?.length === 1 ? "" : "s"}`],
      ["gold", "Generated", `${compact(totalGold)} gold`],
    ]) {
      const stop = node("span", `matchHistoryStop ${kind}`);
      stop.append(node("i", ""), node("small", "", label), node("b", "", value));
      rail.append(stop);
    }
    summary.append(title, rail, node("span", "matchHistoryChevron", "⌄"));
    const players = node("div", "matchHistoryPlayers");
    for (const player of match.players || []) players.append(playerRow(player));
    details.append(summary, players);
    return details;
  }

  function render() {
    el.list.replaceChildren();
    el.count.hidden = matches.length === 0;
    el.count.textContent = String(matches.length);
    const reports = matches.reduce((total, match) => total + (match.players?.length || 0), 0);
    el.summary.textContent = matches.length ? `${matches.length} completed matches · ${reports} player reports` : "No completed matches yet";
    if (!matches.length) {
      const empty = node("section", "matchHistoryEmpty");
      empty.append(node("span", "", "No reports"), node("h2", "", "Your first after-action report starts here"), node("p", "", "Link the OpenFront companion from Party, play a match, and the finalized player summary will appear here."));
      el.list.append(empty);
      return;
    }
    matches.forEach((match, index) => el.list.append(matchCard(match, index)));
  }

  async function load() {
    if (loading) return;
    loading = true;
    el.refresh.disabled = true;
    el.summary.textContent = "Loading completed matches...";
    try {
      const response = await fetch(`${relay}/api/matches?limit=50`, { cache: "no-store" });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "Match history is unavailable.");
      matches = Array.isArray(payload.matches) ? payload.matches : [];
      loaded = true;
      render();
    } catch (error) {
      el.summary.textContent = "Could not load match history";
      el.list.replaceChildren();
      const empty = node("section", "matchHistoryEmpty error");
      empty.append(node("span", "", "Relay unavailable"), node("h2", "", "Match history could not be loaded"), node("p", "", error.message));
      el.list.append(empty);
    } finally {
      loading = false;
      el.refresh.disabled = false;
    }
  }

  function toggle(open = el.backdrop.hidden) {
    el.backdrop.hidden = !open;
    el.toggle.classList.toggle("active", open);
    el.toggle.setAttribute("aria-expanded", String(open));
    if (open) {
      lastFocus = document.activeElement;
      window.dispatchEvent(new CustomEvent("openfront:history-open"));
      if (!loaded) void load();
      requestAnimationFrame(() => el.close.focus());
    } else if (lastFocus instanceof HTMLElement) lastFocus.focus();
  }

  el.toggle.addEventListener("click", () => toggle());
  el.close.addEventListener("click", () => toggle(false));
  el.refresh.addEventListener("click", load);
  el.backdrop.addEventListener("click", (event) => { if (event.target === el.backdrop) toggle(false); });
  window.addEventListener("openfront:party-open", () => toggle(false));
  window.addEventListener("keydown", (event) => { if (event.key === "Escape" && !el.backdrop.hidden) toggle(false); });
  if (new URLSearchParams(location.search).get("history") === "1") toggle(true);
})();
