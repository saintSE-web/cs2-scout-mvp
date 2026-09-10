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
  message("Загружаю и парсю демо. На больших файлах это займёт немного времени…");
  try {
    const result = await jsonFetch(options.url, options);
    drawResults(result);
    message("Готово. Временный файл демо удалён.");
  } catch (error) { message(error.message, true); }
}

function analysisHeaders(extra = {}) {
  return {
    "X-Stationary-Seconds": $("stationarySeconds").value,
    "X-Stationary-Radius": $("stationaryRadius").value,
    ...extra,
  };
}

const SPAWN_IGNORE_SECONDS = 22;

function stationarySpots(samples, minimumSeconds, radiusUnits) {
  if (!samples?.length) return [];
  const sorted = [...samples].sort((a, b) => a.round - b.round || a.time - b.time || a.tick - b.tick);
  const roundStarts = new Map();
  for (const sample of sorted) if (!roundStarts.has(sample.round)) roundStarts.set(sample.round, sample.time);
  const spots = [];
  let cluster = [];
  const commit = () => {
    if (cluster.length < 2) return;
    const first = cluster[0], last = cluster.at(-1);
    const duration = last.time - first.time;
    if (duration < minimumSeconds || first.time - roundStarts.get(first.round) < SPAWN_IGNORE_SECONDS) return;
    spots.push({
      x: Number((cluster.reduce((sum, point) => sum + point.x, 0) / cluster.length).toFixed(1)),
      y: Number((cluster.reduce((sum, point) => sum + point.y, 0) / cluster.length).toFixed(1)),
      round: first.round, duration: Number(duration.toFixed(1)),
    });
  };
  for (const sample of sorted) {
    if (!cluster.length) { cluster = [sample]; continue; }
    const previous = cluster.at(-1);
    const centerX = cluster.reduce((sum, point) => sum + point.x, 0) / cluster.length;
    const centerY = cluster.reduce((sum, point) => sum + point.y, 0) / cluster.length;
    const sameRound = sample.round === previous.round;
    const continuous = sample.time - previous.time <= 2;
    const withinRadius = Math.hypot(sample.x - centerX, sample.y - centerY) <= radiusUnits;
    if (sameRound && continuous && withinRadius) cluster.push(sample);
    else { commit(); cluster = [sample]; }
  }
  commit();
  return spots;
}

let filterRefreshTimer;
function refreshCurrentFilter() {
  const result = window.lastResult;
  if (!result || !result.players.every((player) => player.samples)) return;
  const seconds = Number($("stationarySeconds").value);
  const radius = Number($("stationaryRadius").value);
  if (!Number.isFinite(seconds) || seconds < 0 || !Number.isFinite(radius) || radius <= 0) return;
  for (const player of result.players) {
    player.sides = {
      T: stationarySpots(player.samples.T, seconds, radius),
      CT: stationarySpots(player.samples.CT, seconds, radius),
    };
  }
  result.min_stationary_seconds = seconds;
  result.stationary_radius_units = radius;
  selectDemoPlayer($("playerSelect").value || result.steam_id);
  message("Фильтр пересчитан без повторной загрузки демки.");
}

for (const inputId of ["stationarySeconds", "stationaryRadius"]) {
  $(inputId).addEventListener("input", () => {
    clearTimeout(filterRefreshTimer);
    filterRefreshTimer = setTimeout(refreshCurrentFilter, 160);
  });
}

$("showSources").onclick = () => {
  document.querySelectorAll(".source-card").forEach((card) => card.classList.remove("hidden"));
  $("showSources").classList.add("hidden");
  message("Поиск по FACEIT/Leetify раскрыт. Он нужен только когда демки ещё нет.");
};

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
  parseDemo({ url: "/api/analyze-url", method: "POST", headers: analysisHeaders({ "Content-Type": "application/json" }), body: JSON.stringify({ steam_id: steamId, demo_url: finalUrl }) });
};

$("demoFile").onchange = async (event) => {
  const file = event.target.files[0];
  if (!file) return;
  parseDemo({ url: "/api/analyze-upload", method: "POST", headers: analysisHeaders({ "Content-Type": "application/octet-stream", "X-Steam-Id": steamId, "X-Filename": file.name }), body: file });
};

const MAP_DATA_URL = "https://raw.githubusercontent.com/MurkyYT/cs2-map-icons/main/data/available.json";
let mapDataPromise;

function color(alpha) { return `hsla(${190 - alpha * 150}, 95%, 57%, ${0.12 + alpha * 0.83})`; }

async function getMapData(mapName) {
  try {
    mapDataPromise ||= fetch(MAP_DATA_URL).then((response) => {
      if (!response.ok) throw new Error("map data unavailable");
      return response.json();
    });
    return (await mapDataPromise).maps[mapName] || null;
  } catch { return null; }
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.crossOrigin = "anonymous";
    image.onload = () => resolve(image);
    image.onerror = reject;
    image.src = src;
  });
}

function pointOnRadar(point, info, width, height) {
  const scale = Number(info.scale);
  if (!Number.isFinite(scale) || !scale) return null;
  return {
    x: (point.x - Number(info.pos_x)) / scale * (width / 1024),
    y: (Number(info.pos_y) - point.y) / scale * (height / 1024),
  };
}

function heatStamp(size = 100) {
  const stamp = document.createElement("canvas");
  stamp.width = stamp.height = size;
  const ctx = stamp.getContext("2d");
  const gradient = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  gradient.addColorStop(0, "rgba(255, 238, 118, .95)");
  gradient.addColorStop(.16, "rgba(255, 132, 70, .68)");
  gradient.addColorStop(.42, "rgba(255, 53, 84, .32)");
  gradient.addColorStop(1, "rgba(255, 42, 90, 0)");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, size, size);
  return stamp;
}

async function drawHeatmap(canvas, points, mapName) {
  const ctx = canvas.getContext("2d");
  const width = canvas.width, height = canvas.height;
  ctx.fillStyle = "#0b111b"; ctx.fillRect(0, 0, width, height);
  if (!points.length) { ctx.fillStyle = "#8fa1b8"; ctx.font = "18px system-ui"; ctx.fillText("Нет точек", 24, 36); return; }
  const map = await getMapData(mapName);
  const radarUrl = map?.radar_paths?.at(-1);
  let radar = null;
  if (radarUrl && map?.radar_info) {
    try { radar = await loadImage(radarUrl); } catch { radar = null; }
  }
  if (radar && map.radar_info) {
    ctx.drawImage(radar, 0, 0, width, height);
    ctx.fillStyle = "rgba(4, 10, 18, .04)"; ctx.fillRect(0, 0, width, height);
    const stamp = heatStamp();
    const visible = points.map((point) => pointOnRadar(point, map.radar_info, width, height))
      .filter((point) => point && point.x >= -70 && point.y >= -70 && point.x <= width + 70 && point.y <= height + 70);
    ctx.globalCompositeOperation = "screen";
    for (const point of visible) {
      ctx.globalAlpha = Math.min(.88, .42 + Math.max(0, (Number(point.duration) - 6) * .035));
      ctx.drawImage(stamp, point.x - 50, point.y - 50);
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = "source-over";
    for (const point of visible) {
      ctx.beginPath(); ctx.arc(point.x, point.y, 4, 0, Math.PI * 2);
      ctx.fillStyle = "rgba(255, 246, 185, .95)"; ctx.fill();
      ctx.beginPath(); ctx.arc(point.x, point.y, 7, 0, Math.PI * 2);
      ctx.strokeStyle = "rgba(255, 81, 82, .9)"; ctx.lineWidth = 2; ctx.stroke();
    }
    ctx.fillStyle = "rgba(7, 15, 26, .82)"; ctx.fillRect(14, 14, 230, 29);
    ctx.fillStyle = "#e8eef8"; ctx.font = "700 14px ui-monospace";
    ctx.fillText(`${visible.length} стоянок · radar`, 25, 34);
    return;
  }
  drawFallbackHeatmap(ctx, points, width, height);
}

function drawFallbackHeatmap(ctx, points, width, height) {
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
  $("counts").textContent = `T ${player.sides.T.length} · CT ${player.sides.CT.length} стоянок ≥ ${result.min_stationary_seconds || 6} сек`;
  drawHeatmap($("tCanvas"), player.sides.T, result.map_name); drawHeatmap($("ctCanvas"), player.sides.CT, result.map_name);
}
