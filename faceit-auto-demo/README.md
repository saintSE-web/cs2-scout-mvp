# CS2 Scout — FACEIT Auto Demo

Local, unpacked browser extension for testing the CS2 Scout MVP.

It only looks for FACEIT's own **Watch Demo / Download Demo** button on an already opened match-room page and invokes that visible page control once. It does **not** request, read, save, or transmit cookies, session tokens, passwords, or FACEIT API keys.

## Install in Opera / Chrome

1. Open the extensions page (`opera://extensions` in Opera or `chrome://extensions` in Chrome).
2. Enable **Developer mode**.
3. Click **Load unpacked** and select this `faceit-auto-demo` folder.
4. Open a completed FACEIT CS2 match room in the same browser. If a native **Watch Demo** button appears, the extension attempts the normal page action once.

The script runs only on `https://www.faceit.com/*` and stops after one attempt per match-room route. If FACEIT changes the button text or blocks script-generated clicks, it will do nothing; it does not fall back to private API calls.
