# CS2 Scout MVP

Local web MVP for reviewing one CS2 demo at a time. It uses Leetify's public API only to list public recent matches. The demo itself is parsed locally by this app with `demoparser2`; it is deleted immediately after analysis.

## What it does

1. Resolves a SteamID64 (or a public Steam custom profile URL).
2. Displays the latest public Leetify matches.
3. Lets you download/parse **one** demo either from a direct `.dem` URL or a local file.
4. Creates separate T and CT density maps for the selected player.

Steam match share codes alone do not expose an official direct demo-download HTTP endpoint. For a Valve matchmaking game, copy/download the demo in CS2 first, then drag it into the MVP. FACEIT signed demo URLs can be pasted directly.

## Run

```powershell
python -m pip install -r requirements.txt
python app.py
```

Open `http://127.0.0.1:8787`.

The local server is intentionally bound to loopback only. It does not store API keys, Steam IDs, demos, or analysis results.

## Notes

- Leetify data remains subject to its [Developer Guidelines](https://leetify.com/blog/leetify-api-developer-guidelines/).
- This initial version uses an adaptive world-coordinate grid, not a radar image. Adding per-map radar calibration is the next UI refinement.
