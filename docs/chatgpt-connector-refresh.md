# ChatGPT Connector Refresh Helper

`scripts/refresh_chatgpt_connector.py` opens the DevSpace app settings page in ChatGPT, clicks the update button, and waits until the version note advances by one patch component.

It uses Playwright, reuses a CDP browser when available, otherwise launches a persistent ChatGPT profile, and avoids choosing `about:blank` tabs as the target page.

## Configuration

Default config lookup order:

1. `scripts/chatgpt_connector_refresh.config.local.json`
2. `scripts/chatgpt_connector_refresh.config.example.json`

The local config file is ignored by Git. The config stores only the Discord environment variable name, not the actual secret value.

## Run

```powershell
python .\scripts\refresh_chatgpt_connector.py
```

or:

```powershell
npm run connector:refresh
```

Run metadata is written to `.devspace/connector_refresh/last_run.json`.

## Notes

- The example profile path points to `../../aegis_gate/.chatgpt_profile` from the DevSpace repository root.
- If Chrome or Chromium is already available at `http://127.0.0.1:9222`, the helper reuses it through CDP.
- The version check reads values near `バージョンに関する注記` / `Version notes`, then waits until the last numeric component increases by one.
