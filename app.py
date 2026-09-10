from __future__ import annotations

import json
import os
import re
import tempfile
import time
import gzip
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

import httpx
import polars as pl
import uvicorn
import zstandard
from demoparser2 import DemoParser
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

ROOT = Path(__file__).parent
STATIC = ROOT / "static"
MAX_DEMO_BYTES = 750 * 1024 * 1024
SAMPLE_EVERY_TICKS = 32

app = FastAPI(title="CS2 Scout MVP")
app.mount("/static", StaticFiles(directory=STATIC), name="static")


def fail(message: str, status: int = 400) -> None:
    raise HTTPException(status_code=status, detail=message)


def require_steam_id(value: str) -> str:
    value = value.strip()
    if not re.fullmatch(r"7656\d{13}", value):
        fail("Нужен SteamID64 из 17 цифр.")
    return value


async def resolve_steam_id(value: str) -> str:
    value = value.strip()
    if re.fullmatch(r"7656\d{13}", value):
        return value
    parsed = urlparse(value)
    if parsed.scheme != "https" or parsed.netloc.lower() != "steamcommunity.com":
        fail("Вставь SteamID64 или публичную ссылку https://steamcommunity.com/id/.../")
    if not re.fullmatch(r"/(id|profiles)/[^/]+/?", parsed.path):
        fail("Поддерживаются только ссылки Steam Community вида /id/... или /profiles/...")
    async with httpx.AsyncClient(timeout=12, follow_redirects=True) as client:
        response = await client.get(value.rstrip("/") + "/?xml=1")
    if response.status_code != 200:
        fail("Steam Community не вернул публичный профиль.", 502)
    match = re.search(r"<steamID64>(\d{17})</steamID64>", response.text)
    if not match:
        fail("Не удалось получить SteamID64: профиль может быть приватным или ссылка неверна.")
    return match.group(1)


@app.get("/")
async def index() -> FileResponse:
    return FileResponse(STATIC / "index.html")


@app.get("/api/resolve")
async def resolve(value: str) -> dict[str, str]:
    return {"steam_id": await resolve_steam_id(value)}


@app.get("/api/player/{steam_id}/matches")
async def recent_matches(steam_id: str, request: Request) -> dict[str, Any]:
    steam_id = require_steam_id(steam_id)
    key = request.headers.get("x-leetify-key", "").strip()
    headers = {"Authorization": f"Bearer {key}"} if key else {}
    api_url = "https://api-public.cs-prod.leetify.com/v3/profile/matches"
    async with httpx.AsyncClient(timeout=20) as client:
        response = await client.get(api_url, params={"steam64_id": steam_id}, headers=headers)
    if response.status_code == 404:
        fail("Leetify не нашёл публичные матчи этого игрока.", 404)
    if response.status_code == 429:
        fail("Leetify временно ограничил запросы. Добавь свой API key или попробуй позже.", 429)
    if response.status_code >= 400:
        fail(f"Leetify вернул HTTP {response.status_code}.", 502)
    data = response.json()
    if not isinstance(data, list):
        fail("Неожиданный ответ Leetify.", 502)
    return {"steam_id": steam_id, "matches": data[:10]}


def faceit_headers(request: Request) -> dict[str, str]:
    key = request.headers.get("x-faceit-key", "").strip()
    if not key:
        fail("Вставь FACEIT Data API key. Он нужен для официального API.", 401)
    return {"Authorization": f"Bearer {key}"}


async def faceit_request(path: str, headers: dict[str, str], params: dict[str, Any] | None = None) -> Any:
    async with httpx.AsyncClient(timeout=20) as client:
        response = await client.get(f"https://open.faceit.com/data/v4{path}", headers=headers, params=params)
    if response.status_code == 404:
        fail("FACEIT не нашёл игрока или матч.", 404)
    if response.status_code == 401:
        fail("FACEIT не принял Data API key.", 401)
    if response.status_code == 429:
        fail("FACEIT временно ограничил запросы. Попробуй позже.", 429)
    if response.status_code >= 400:
        fail(f"FACEIT вернул HTTP {response.status_code}.", 502)
    return response.json()


@app.get("/api/faceit/player/{nickname}/matches")
async def faceit_matches(nickname: str, request: Request) -> dict[str, Any]:
    headers = faceit_headers(request)
    player = await faceit_request("/players", headers, {"nickname": nickname, "game": "cs2"})
    player_id = player.get("player_id")
    if not player_id:
        fail("FACEIT не вернул идентификатор игрока.", 502)
    history = await faceit_request(f"/players/{player_id}/history", headers, {"game": "cs2", "limit": 10, "offset": 0})
    return {
        "player_id": player_id,
        "nickname": player.get("nickname", nickname),
        "steam_id": player.get("steam_id_64"),
        "matches": history.get("items", []),
    }


@app.get("/api/faceit/match/{match_id}/demo")
async def faceit_match_demo(match_id: str, request: Request) -> dict[str, Any]:
    details = await faceit_request(f"/matches/{match_id}", faceit_headers(request))
    raw_urls = details.get("demo_url") or []
    if isinstance(raw_urls, str):
        raw_urls = [raw_urls]
    return {"match": details, "demo_urls": raw_urls}


async def download_demo(url: str, destination: Path) -> None:
    parsed = urlparse(url)
    if parsed.scheme != "https" or not parsed.netloc:
        fail("Разрешены только прямые HTTPS-ссылки на демо.")
    async with httpx.AsyncClient(timeout=httpx.Timeout(90, connect=15), follow_redirects=True) as client:
        async with client.stream("GET", url) as response:
            if response.status_code != 200:
                fail(f"Ссылка на демо вернула HTTP {response.status_code}.", 502)
            size = 0
            with destination.open("wb") as output:
                async for chunk in response.aiter_bytes():
                    size += len(chunk)
                    if size > MAX_DEMO_BYTES:
                        fail("Демо больше лимита 750 МБ.")
                    output.write(chunk)


def unpack_demo(path: Path) -> Path:
    with path.open("rb") as source:
        magic = source.read(4)
    if magic[:2] == b"\x1f\x8b":
        unpacked = path.with_suffix(".dem")
        with gzip.open(path, "rb") as source, unpacked.open("wb") as destination:
            destination.write(source.read())
        path.unlink(missing_ok=True)
        return unpacked
    if magic == b"\x28\xb5\x2f\xfd":
        unpacked = path.with_suffix(".dem")
        with path.open("rb") as source, unpacked.open("wb") as destination:
            zstandard.ZstdDecompressor().copy_stream(source, destination)
        path.unlink(missing_ok=True)
        return unpacked
    return path


def dataframe_rows(frame: pl.DataFrame) -> list[dict[str, Any]]:
    return frame.to_dicts()


def analyze_demo(path: Path, steam_id: str) -> dict[str, Any]:
    parser = DemoParser(str(path))
    props = [
        "X", "Y", "is_alive", "team_num", "player_steamid", "player_name",
        "total_rounds_played", "game_time",
    ]
    try:
        ticks = parser.parse_ticks(props, players=[steam_id])
    except Exception as exc:
        raise HTTPException(422, f"Парсер не смог прочитать демо: {exc}") from exc
    if ticks.is_empty():
        fail("В демо не нашлись тики выбранного игрока. Проверь SteamID и файл.", 422)

    samples: dict[str, list[dict[str, float | int]]] = {"T": [], "CT": []}
    last_tick = -SAMPLE_EVERY_TICKS
    for row in dataframe_rows(ticks):
        team = row.get("team_num")
        if team == 2:
            side = "T"
        elif team == 3:
            side = "CT"
        else:
            continue
        tick = int(row.get("tick") or row.get("game_time") or 0)
        if tick - last_tick < SAMPLE_EVERY_TICKS:
            continue
        last_tick = tick
        if row.get("is_alive") is False:
            continue
        x, y = row.get("X"), row.get("Y")
        if not isinstance(x, (int, float)) or not isinstance(y, (int, float)):
            continue
        samples[side].append({"x": round(float(x), 1), "y": round(float(y), 1), "round": int(row.get("total_rounds_played") or 0)})

    if not samples["T"] and not samples["CT"]:
        fail("В демо нет пригодных живых позиций игрока.", 422)
    header: dict[str, Any] = {}
    try:
        header = parser.parse_header()
    except Exception:
        pass
    return {
        "steam_id": steam_id,
        "map_name": header.get("map_name", "unknown") if isinstance(header, dict) else "unknown",
        "player_name": next((r.get("player_name") for r in dataframe_rows(ticks) if r.get("player_name")), steam_id),
        "sample_every_ticks": SAMPLE_EVERY_TICKS,
        "sides": samples,
    }


async def analyze_path(path: Path, steam_id: str) -> dict[str, Any]:
    try:
        path = unpack_demo(path)
        return analyze_demo(path, steam_id)
    finally:
        path.unlink(missing_ok=True)


@app.post("/api/analyze-url")
async def analyze_url(payload: dict[str, str]) -> dict[str, Any]:
    steam_id = require_steam_id(payload.get("steam_id", ""))
    url = payload.get("demo_url", "").strip()
    with tempfile.NamedTemporaryFile(prefix="cs2-scout-", suffix=".dem", delete=False) as temp:
        path = Path(temp.name)
    try:
        await download_demo(url, path)
        return await analyze_path(path, steam_id)
    except Exception:
        path.unlink(missing_ok=True)
        raise


@app.post("/api/faceit/signed-demo")
async def faceit_signed_demo(payload: dict[str, str], request: Request) -> dict[str, str]:
    """Turn a FACEIT Cloud resource URL into a short-lived download URL when authorized."""
    token = request.headers.get("x-faceit-download-token", "").strip()
    resource_url = payload.get("resource_url", "").strip()
    if not token:
        fail("Нужен FACEIT Downloads API access token.", 401)
    if not resource_url.startswith("https://"):
        fail("Нужна HTTPS resource URL из данных матча FACEIT.")
    async with httpx.AsyncClient(timeout=20) as client:
        response = await client.post(
            "https://api.faceit.com/download/v2/demos/download",
            headers={"Authorization": f"Bearer {token}"}, json={"resource_url": resource_url},
        )
    if response.status_code >= 400:
        fail(f"FACEIT Downloads API вернул HTTP {response.status_code}.", 502)
    download_url = response.json().get("payload", {}).get("download_url")
    if not download_url:
        fail("FACEIT не вернул подписанную ссылку на демо.", 502)
    return {"download_url": download_url}


@app.post("/api/analyze-upload")
async def analyze_upload(request: Request) -> dict[str, Any]:
    steam_id = require_steam_id(request.headers.get("x-steam-id", ""))
    content_length = int(request.headers.get("content-length", "0") or 0)
    if content_length > MAX_DEMO_BYTES:
        fail("Демо больше лимита 750 МБ.", 413)
    with tempfile.NamedTemporaryFile(prefix="cs2-scout-", suffix=".dem", delete=False) as temp:
        path = Path(temp.name)
        size = 0
        async for chunk in request.stream():
            size += len(chunk)
            if size > MAX_DEMO_BYTES:
                path.unlink(missing_ok=True)
                fail("Демо больше лимита 750 МБ.", 413)
            temp.write(chunk)
    return await analyze_path(path, steam_id)


if __name__ == "__main__":
    uvicorn.run(app, host="127.0.0.1", port=8787)
