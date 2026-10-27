# Xvie Browser Agent (backend)

Python FastAPI sidecar that lets the Xvie IDE chat with web LLMs
(ChatGPT, Claude, Gemini, DeepSeek, Grok, Qwen, Perplexity) through your own logged-in
Chrome window. No API keys needed.

Automation behaviour (CDP tab reuse, per-site selectors, file upload,
sqlite history) is ported from
[`mcp-web-llm`](https://github.com/HGD-coder/mcp-web-llm) into an
organized package:

```
browser-agent/
├── app.py             # FastAPI service (what Electron spawns)
├── engine.py          # Generic Playwright/CDP driver
├── sites.py           # Hardcoded site + selector tables (the 6 LLMs)
├── store.py           # sqlite chat history (ported from memory.py)
├── requirements.txt
├── .env.example
└── README.md
```

## 1. Install

```powershell
cd C:\Users\HP\Desktop\Xvie\Backend\browser-agent
py -3.12 -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
playwright install chromium
```

## 2. Run

```powershell
python app.py
# serves http://127.0.0.1:28711  (override with XVIE_BROWSER_AGENT_PORT)
```

Endpoints: `GET /sites`, `GET /status`, `POST /ensure-chrome`,
`POST /ask { site, query, file_paths? }`, `GET /history?site=`,
`GET /health`.

## 3. Dedicated Chrome (hidden by default)

The service talks to its own Chrome over CDP on port **9333** with its own
profile (`~/.xvie-browser-agent/chrome-profile`). Port 9222 is deliberately
avoided — Xvie's Electron app and mcp-web-llm both use it. The IDE starts a
real Chrome window but keeps it **invisible**, so chats never cover your
work (and sites can't tell it apart from a normal window). Logins persist
in that profile.

- First run: press **Show** in the IDE's Browser panel to open a visible
  window, log in to each site below, then press **Hide** again.
- Or set `XVIE_BROWSER_HEADLESS=0` in `.env` to always launch visible.

```powershell
& "C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9333 --user-data-dir="$HOME\.xvie-browser-agent\chrome-profile" --disable-blink-features=AutomationControlled
```

Then log in to each site in that window and keep it open in the
background:

- https://chatgpt.com
- https://claude.ai
- https://gemini.google.com
- https://chat.deepseek.com
- https://grok.com
- https://chat.qwen.ai
- https://www.perplexity.ai (single-chat only; not used for agent runs)

If a chat reply says `NOT_LOGGED_IN`, open that site in the dedicated
window and log in, then retry.
