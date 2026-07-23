# Setup Guide

## Requirements

- Node `>=22.19 <27`
- npm
- Git
- a public HTTPS URL forwarding to the local Workbridge server

Workbridge does not create the tunnel. Tailscale Funnel, Cloudflare Tunnel,
ngrok, Pinggy, or another HTTPS reverse proxy may be used.

## Initialize

```bash
npx @waishnav/devspace init
```

Choose narrow allowed project roots, keep the default local port `7676` unless
needed otherwise, and enter the public origin without `/mcp`.

Local endpoint:

```text
http://127.0.0.1:7676/mcp
```

Public client endpoint:

```text
https://your-public-host.example.com/mcp
```

## Start

```bash
npx @waishnav/devspace serve
```

For a one-run public URL override:

```bash
DEVSPACE_PUBLIC_BASE_URL="https://new-host.example.com" npx @waishnav/devspace serve
```

The tool surface is fixed; no tool-mode or widget-mode environment variables are
required.

## Approve and Diagnose

Approve the client with the Owner password generated during initialization.
Keep `~/.devspace/auth.json` private.

```bash
npx @waishnav/devspace doctor
```

For a local source checkout:

```bash
npm install --include=dev
npm run dev
```
