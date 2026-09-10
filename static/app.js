const $ = (id) => document.getElementById(id);
let steamId = "";
let selected = null;
let selectedProvider = "";

function message(text, isError = false) {
  const node = $("status");
  node.textContent = text;
  node.className = isError ? "error" : "";
}

async function jsonFetch(url, options = {}) {
  const response = await fetch(url, options);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.detail || `HTTP ${response.status}`);
  return data;
}

function escapeHtml(value) {
  return String(value ?? "—").replace(/[&<>"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[char]);
}

function renderMatches(matches, provider) {
  $("matchList").innerHTML = matches.map((match, index) => {
    const score = (match.team_scores || []).map((item) => item.score).join(" : ");
    const rawDate = match.finished_at || match.started_at;
    const timestamp = typeof rawDate === "number" && rawDate < 100000000000 ? rawDate * 1000 : rawDate;
    const date = rawDate ? new Date(timestamp).toLocaleString("ru-RU") : "дата неизвестна";
    const name = match.map_name || match.game_mode || "unknown map";
    const source = provider === "faceit" ? "FACEIT" : match.data_source;
    return `<button class="match" data-index="${index}"><strong>${escapeHtml(name)}</strong><span>${escapeHtml(source)} · ${score || "—"}</span><small>${date}</small></button>`;
  }).join("");
  $("matches").classList.remove("hidden");
  $("matchList").onclick = (event) => {
    const button = event.target.closest(".match");
    if (!button) return;
    selected = matches[Number(button.dataset.index)];
    selectedProvider = provider;
    document.querySelectorAll(".match").forEach((item) => item.classList.toggle("active", item === button));
    const selectedSource = provider === "faceit" ? "FACEIT" : selected.data_source;
    $("selectedMatch").textContent = `Выбрано: ${selected.map_name || selected.game_mode || "match"} · ${selectedSource} · ${selected.match_id || selected.data_source_match_id || selected.id}`;
    $("demoCard").classList.remove("hidden");
    const room = $("faceitRoom");
    if (provider === "faceit") {
      room.href = `https://www.faceit.com/en/cs2/room/${encodeURIComponent(selected.match_id || selected.id)}`;
      room.classList.remove("hidden");
      loadFaceitDemo(selected.match_id || selected.id);
    } else room.classList.add("hidden");
  };
}

async function loadFaceitDemo(matchId) {
  message("Проверяю, доступна ли FACEIT-демка…");
  try {
    const key = $("faceitKey").value.trim();
    const data = await jsonFetch(`/api/faceit/match/${encodeURIComponent(matchId)}/demo`, { headers: { "X-Faceit-Key": key } });
    const resource = data.demo_urls?.[0];
    if (resource) {
      $("demoUrl").value = resource;
      message("FACEIT вернул demo URL. Нажми «Скачать и разобрать».");
    } else message("У этого FACEIT-матча нет доступной демки. Выбери другой.", true);
  } catch (error) { message(error.message, true); }
}

$("findFaceit").onclick = async () => {
  const nick = $("faceitNick").value.trim(), key = $("faceitKey").value.trim();
  if (!nick || !key) return message("Введи FACEIT nickname и Data API key.", true);
  message("Запрашиваю последние CS2-матчи FACEIT…");
  try {
    const data = await jsonFetch(`/api/faceit/player/${encodeURIComponent(nick)}/matches`, { headers: { "X-Faceit-Key": key } });
    steamId = data.steam_id || "";
    if (!steamId) throw new Error("FACEIT не вернул SteamID64 игрока.");
    renderMatches(data.matches, "faceit");
    message(data.matches.length ? `Найден игрок ${data.nickname}. Выбери матч.` : "CS2-матчи не найдены.");
  } catch (error) { message(error.message, true); }
};

$("find").onclick = async () => {
  const raw = $("player").value.trim();
  if (!raw) return message("Введи SteamID или ссылку на профиль.", true);
  message("Запрашиваю публичную историю матчей…");
  try {
    let lookup = raw;
    if (!/^7656\d{13}$/.test(raw)) {
      const response = await jsonFetch(`/api/resolve?value=${encodeURIComponent(raw)}`);
      lookup = response.steam_id;
    }
    steamId = lookup;
    const key = $("apiKey").value.trim();
    const data = await jsonFetch(`/api/player/${steamId}/matches`, { headers: key ? { "X-Leetify-Key": key } : {} });
    renderMatches(data.matches, "leetify");
    message(data.matches.length ? "Выбери один матч." : "Публичных матчей не найдено.");
  } catch (error) { message(error.message, true); }
};

async function parseDemo(options) {
  if (!steamId) return message("Сначала найди игрока.", true);
  message("Загружаю и парсю демо. На больших файлах это займёт немного времени…");
  try {
    const result = await jsonFetch(options.url, options);
    drawResults(result);
    message("Готово. Временный файл демо удалён.");
  } catch (error) { message(error.message, true); }
}

$("parseUrl").onclick = async () => {
  const url = $("demoUrl").value.trim();
  if (!url) return message("Вставь прямую HTTPS-ссылку на .dem.", true);
  let finalUrl = url;
  const token = $("faceitDownloadToken").value.trim();
  if (selectedProvider === "faceit" && token) {
    message("Получаю короткоживущую ссылку FACEIT на демо…");
    try {
      const signed = await jsonFetch("/api/faceit/signed-demo", { method: "POST", headers: { "Content-Type": "application/json", "X-Faceit-Download-Token": token }, body: JSON.stringify({ resource_url: url }) });
      finalUrl = signed.download_url;
    } catch (error) { return message(error.message, true); }
  }
  parseDemo({ url: "/api/analyze-url", method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ steam_id: steamId, demo_url: finalUrl }) });
};

$("demoFile").onchange = async (event) => {
  const file = event.target.files[0];
  if (!file) return;
  parseDemo({ url: "/api/analyze-upload", method: "POST", headers: { "Content-Type": "application/octet-stream", "X-Steam-Id": steamId, "X-Filename": file.name }, body: file });
};

function color(alpha) { return `hsla(${190 - alpha * 150}, 95%, 57%, ${0.12 + alpha * 0.83})`; }
function drawHeatmap(canvas, points) {
  const ctx = canvas.getContext("2d");
  const width = canvas.width, height = canvas.height;
  ctx.fillStyle = "#0b111b"; ctx.fillRect(0, 0, width, height);
  if (!points.length) { ctx.fillStyle = "#8fa1b8"; ctx.font = "18px system-ui"; ctx.fillText("Нет точек", 24, 36); return; }
  const pad = 44;
  const minX = Math.min(...points.map((p) => p.x)), maxX = Math.max(...points.map((p) => p.x));
  const minY = Math.min(...points.map((p) => p.y)), maxY = Math.max(...points.map((p) => p.y));
  const scaleX = (width - pad * 2) / Math.max(1, maxX - minX);
  const scaleY = (height - pad * 2) / Math.max(1, maxY - minY);
  const cells = new Map(), columns = 32, rows = 29;
  for (const point of points) {
    const x = Math.min(columns - 1, Math.floor((point.x - minX) / Math.max(1, maxX - minX) * columns));
    const y = Math.min(rows - 1, Math.floor((point.y - minY) / Math.max(1, maxY - minY) * rows));
    const key = `${x}:${y}`; cells.set(key, (cells.get(key) || 0) + 1);
  }
  const maxCell = Math.max(...cells.values());
  ctx.strokeStyle = "rgba(143,161,184,.14)"; ctx.lineWidth = 1;
  for (let x = 0; x <= columns; x++) { const px = pad + (width - pad * 2) * x / columns; ctx.beginPath(); ctx.moveTo(px, pad); ctx.lineTo(px, height - pad); ctx.stroke(); }
  for (let y = 0; y <= rows; y++) { const py = pad + (height - pad * 2) * y / rows; ctx.beginPath(); ctx.moveTo(pad, py); ctx.lineTo(width - pad, py); ctx.stroke(); }
  for (const [key, count] of cells) {
    const [x, y] = key.split(":").map(Number); const a = count / maxCell;
    ctx.fillStyle = color(a); ctx.fillRect(pad + x * (width - pad * 2) / columns, pad + y * (height - pad * 2) / rows, (width - pad * 2) / columns + 1, (height - pad * 2) / rows + 1);
  }
  ctx.fillStyle = "#8fa1b8"; ctx.font = "12px ui-monospace"; ctx.fillText(`${Math.round(minX)} → ${Math.round(maxX)} X`, pad, height - 15); ctx.fillText(`${Math.round(minY)} → ${Math.round(maxY)} Y`, pad, 22);
}
function drawResults(result) {
  window.lastResult = result;
  $("results").classList.remove("hidden");
  const picker = $("playerSelect");
  picker.innerHTML = result.players.map((player) => `<option value="${player.steam_id}">${escapeHtml(player.name)}</option>`).join("");
  picker.value = result.steam_id;
  picker.onchange = () => selectDemoPlayer(picker.value);
  selectDemoPlayer(result.steam_id);
  $("results").scrollIntoView({ behavior: "smooth", block: "start" });
}
function selectDemoPlayer(steamId) {
  const result = window.lastResult;
  const player = result.players.find((item) => item.steam_id === steamId);
  if (!player) return;
  $("resultTitle").textContent = `${player.name} · ${result.map_name}`;
  $("counts").textContent = `T ${player.sides.T.length} · CT ${player.sides.CT.length} sampled positions`;
  drawHeatmap($("tCanvas"), player.sides.T); drawHeatmap($("ctCanvas"), player.sides.CT);
}
