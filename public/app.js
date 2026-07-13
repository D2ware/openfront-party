const $ = (selector) => document.querySelector(selector);
const ui = { name: $("#name-input"), code: $("#code-input"), create: $("#create-button"), join: $("#join-button"), start: $("#start-panel"), group: $("#group-panel"), groupCode: $("#group-code"), members: $("#member-list"), selection: $("#selection-panel"), state: $("#state-select"), leave: $("#leave-button"), grid: $("#lobby-grid"), template: $("#lobby-template"), toast: $("#toast"), connection: $(".connection"), connectionLabel: $("#connection-label"), parties: $("#party-list") };
let socket; let session = null; let room = null; let lobbies = []; let reconnectTimer; let toastTimer;
const savedName = localStorage.getItem("openfront-prelobby-name"); if (savedName) ui.name.value = savedName;

function showToast(message) { ui.toast.textContent = message; ui.toast.classList.add("show"); clearTimeout(toastTimer); toastTimer = setTimeout(() => ui.toast.classList.remove("show"), 3600); }
function send(type, payload = {}) { if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ v: 1, type, ...payload })); else showToast("The relay connection is unavailable."); }
function setConnection(online) { ui.connection.classList.toggle("online", online); ui.connectionLabel.textContent = online ? "Live" : "Connecting"; }
function connect() {
  const protocol = location.protocol === "https:" ? "wss" : "ws";
  socket = new WebSocket(`${protocol}://${location.host}`);
  socket.addEventListener("open", () => setConnection(true));
  socket.addEventListener("close", () => { setConnection(false); clearTimeout(reconnectTimer); reconnectTimer = setTimeout(connect, 1800); });
  socket.addEventListener("message", ({ data }) => { const msg = JSON.parse(data); handleMessage(msg); });
}
function handleMessage(msg) {
  if (msg.type === "session.welcome") { session = msg; setInterval(() => send("member.heartbeat"), msg.heartbeatMs); return; }
  if (msg.type === "group.error") return showToast(msg.message);
  if (msg.type === "group.snapshot") { room = msg.room; renderGroup(); }
}
function myMember() { return room?.members.find((member) => member.id === session?.clientId); }
function renderGroup() {
  const me = myMember(); const active = Boolean(me);
  ui.start.classList.toggle("hidden", active); ui.group.classList.toggle("hidden", !active);
  if (!active) return;
  ui.groupCode.textContent = room.code;
  ui.members.replaceChildren(...room.members.map((member) => { const el = document.createElement("span"); el.className = `member ${member.role}`; el.textContent = member.name; const small = document.createElement("small"); small.textContent = member.role === "leader" ? "johtaja" : stateLabel(member.state); el.append(small); return el; }));
  ui.state.value = me.state;
  renderSelection(); renderLobbies();
}
function stateLabel(state) { return ({ ready:"ready", "opening-game":"opening game", "in-game":"in game", left:"left", away:"away" })[state] || state; }
function renderSelection() {
  const lobby = room?.selectedLobby;
  ui.selection.replaceChildren(); const eyebrow = document.createElement("p"); eyebrow.className = "eyebrow"; eyebrow.textContent = "JOHTAJAN VALINTA"; ui.selection.append(eyebrow);
  if (!lobby) { const empty = document.createElement("p"); empty.className = "empty-selection"; empty.textContent = "No lobby selected yet."; ui.selection.append(empty); return; }
  const title = document.createElement("h3"); title.textContent = lobby.name; const detail = document.createElement("p"); detail.textContent = `${lobby.mode} · ${lobby.players}/${lobby.capacity} · ${lobby.server}`; const open = document.createElement("a"); open.className = "join-leader"; open.href = "https://openfront.io/"; open.target = "_blank"; open.rel = "noreferrer"; open.textContent = "Open OpenFront"; open.addEventListener("click", () => send("member.state", { state:"opening-game" })); ui.selection.append(title, detail, open);
}
function renderLobbies() {
  const leader = myMember()?.role === "leader"; ui.grid.replaceChildren(...lobbies.map((lobby) => { const node = ui.template.content.cloneNode(true); node.querySelector(".map-tag").textContent = lobby.map; node.querySelector(".eta").textContent = lobby.eta; node.querySelector(".lobby-name").textContent = lobby.name; node.querySelector(".lobby-meta").textContent = lobby.mode; node.querySelector(".server").textContent = lobby.server; node.querySelector(".players").textContent = `${lobby.players}/${lobby.capacity}`; const button = node.querySelector("button"); button.disabled = !leader; button.textContent = leader ? "Select lobby" : "Leader selects"; button.addEventListener("click", () => send("leader.select_lobby", { lobby })); return node; }));
}
async function loadLobbies() { try { const data = await fetch("/api/lobbies", { cache:"no-store" }).then((r) => r.json()); lobbies = data.lobbies; $("#source-note").textContent = data.source === "demo" ? "Demo feed · live adapter pending" : "Public lobby feed"; renderLobbies(); } catch { showToast("The lobby feed could not be loaded."); } }
async function loadParties() { try { const data = await fetch("/api/groups", { cache:"no-store" }).then((r) => r.json()); ui.parties.replaceChildren(); if (!data.groups.length) { const empty = document.createElement("p"); empty.className = "directory-empty"; empty.textContent = "No open parties right now. Create the first one."; return ui.parties.append(empty); } for (const party of data.groups) { const card = document.createElement("article"); card.className = "party-card"; const details = document.createElement("div"); const code = document.createElement("span"); code.className = "party-code"; code.textContent = party.code; const leader = document.createElement("strong"); leader.textContent = `${party.leader}'s party`; const meta = document.createElement("p"); meta.textContent = party.selectedLobby ? `Heading to ${party.selectedLobby.name} · ${party.selectedLobby.players}/${party.selectedLobby.capacity}` : "Choosing a lobby"; const count = document.createElement("span"); count.className = "party-count"; count.textContent = `${party.members} member${party.members === 1 ? "" : "s"}`; const button = document.createElement("button"); button.className = "join-party"; button.textContent = "Join party"; button.addEventListener("click", () => { ui.code.value = party.code; ui.code.focus(); showToast("Party code loaded. Enter your callsign and join."); }); details.append(code, leader, meta); card.append(details, count, button); ui.parties.append(card); } } catch { /* The party directory is supplementary. */ } }
function groupName() { const name = ui.name.value.trim(); if (!name) { showToast("Enter your callsign first."); ui.name.focus(); return null; } localStorage.setItem("openfront-prelobby-name", name); return name; }
ui.create.addEventListener("click", () => { const name = groupName(); if (name) send("group.create", { name }); });
ui.join.addEventListener("click", () => { const name = groupName(); const code = ui.code.value.trim(); if (!code) return showToast("Enter a party code."); if (name) send("group.join", { name, code }); });
ui.code.addEventListener("keydown", (event) => { if (event.key === "Enter") ui.join.click(); });
ui.leave.addEventListener("click", () => { send("group.leave"); room = null; renderGroup(); });
ui.state.addEventListener("change", () => send("member.state", { state:ui.state.value }));
$("#copy-code").addEventListener("click", async () => { await navigator.clipboard.writeText(room.code); showToast("Party code copied."); });
connect(); loadLobbies(); loadParties(); setInterval(loadLobbies, 30_000); setInterval(loadParties, 5_000);
