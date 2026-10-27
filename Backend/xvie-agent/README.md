# Xvie Agent

This folder contains the Xvie coding workflow and its authenticated loopback service. The desktop app starts `xvie_agent.service:app` as a child process and communicates with it through a random bearer token. Session files are stored under the selected workspace's ignored `.xvie-sessions` directory.

## Development setup

```powershell
cd Backend/xvie-agent
python -m venv .venv
.venv/Scripts/python -m pip install -e .
Copy-Item .env.example .env
```

Set one or more `FORGE_PROVIDER_<NAME>_API_KEY` and `FORGE_PROVIDER_<NAME>_BASE_URL` pairs in `.env`. The integrated app can also store provider credentials using Windows secure storage; those values take precedence when selected in Xvie. The desktop app uses NVIDIA Nemotron 3.5 Lightning by default for faster replies unless `DEFAULT_MODEL` or `FORGE_DEFAULT_MODEL` is set.

### Zetaris (optional)

Xvie Agent can query a Zetaris instance as a read-only data source. Set `ZETARIS_BASE_URL`, `ZETARIS_USERNAME`, and `ZETARIS_PASSWORD` in this folder's local `.env` file; set `ZETARIS_ORG_ID` only if the login response does not provide it. Keep real credentials in `.env`, which is git-ignored. Restart Xvie after changing these settings so the agent reloads them.

When configured, the coding agent can use `zetaris_catalog` to discover data sources, tables, and columns, and `zetaris_query` to run read-only SQL. It rejects write statements, limits returned rows, and uses short request timeouts. Zetaris access is optional; core coding workflows continue if it is unavailable. The datasource itself must already be registered and accessible in Zetaris.

### Meterless / Nightshift

If the local Meterless runtime is running on Windows, Xvie detects its bearer token at `%LOCALAPPDATA%\ai.meterless.runtime\proxy-token` and adds a **Meterless** profile in Agent → Model providers. It uses `http://127.0.0.1:8088/v1` and model `worker` by default. Choose that profile to run the agent through Meterless; choose the NVIDIA profile to use NVIDIA. The token stays in the runtime's local file. `METERLESS_TOKEN_PATH`, `METERLESS_BASE_URL`, and `METERLESS_MODEL` can override the defaults.

The sidecar is started by Xvie. To run it manually for development:

```powershell
$env:XVIE_AGENT_TOKEN = "development-token"
python -m uvicorn xvie_agent.service:app --host 127.0.0.1 --port 28712
```

Run the workflow tests with `python -m pytest` from this directory.
