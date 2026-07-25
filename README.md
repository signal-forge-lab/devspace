<p align="center">
  <picture>
    <img src="https://raw.githubusercontent.com/Waishnav/devspace/main/docs/assets/devspace-logo-light.png" alt="DevSpace logo" width="140">
  </picture>
</p>

<h1 align="center">DevSpace</h1>

<p align="center">Bring a Codex-style coding workflow to ChatGPT.</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@waishnav/devspace"><img alt="npm" src="https://img.shields.io/npm/v/%40waishnav%2Fdevspace?style=flat-square" /></a>
  <a href="https://github.com/Waishnav/devspace/actions/workflows/ci.yml"><img alt="CI" src="https://img.shields.io/github/actions/workflow/status/Waishnav/devspace/ci.yml?style=flat-square&branch=main" /></a>
  <a href="https://github.com/Waishnav/devspace/blob/main/LICENSE"><img alt="License" src="https://img.shields.io/npm/l/%40waishnav%2Fdevspace?style=flat-square" /></a>
</p>

[![DevSpace connected to ChatGPT](https://raw.githubusercontent.com/Waishnav/devspace/main/docs/assets/devspace-screenshot.png)](https://raw.githubusercontent.com/Waishnav/devspace/main/docs/assets/devspace-screenshot.png)

**Give ChatGPT a secure connection to your own machine and Turn ChatGPT into Codex**

DevSpace is a self-hosted MCP server that lets ChatGPT read, edit, search, and run code in your real local projects — your files, your tools, your terminal — without uploading anything to a third party. You run it on your machine, expose it through a tunnel you control, and approve the connection with a password only you have.

This Workbridge branch exposes a fixed seven-tool MCP surface:
`open_workspace`, `read`, `apply_patch`, `exec_command`, `write_stdin`,
`run_workspace_action`, and `download_artifact`. Native artifact download
executes on Linux; other host platforms keep the same schema and return an
unsupported-platform result.

## Sponsors and Special Thanks

<table>
  <thead>
    <tr>
      <th>Sponsor</th>
      <th>About</th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <td align="center" width="220">
        <a href="https://rebates.ai/">
          <img
            src="https://app.rebates.ai/brand/rebates-lockup.svg"
            alt="Rebates"
            width="170"
          >
        </a>
      </td>
      <td>
        <strong>The ads in your terminal pay you.</strong><br><br>
        <a href="https://rebates.ai/">Rebates</a> adds one optional
        sponsored footer to your coding agent and pays you cash back for every
        session in which it is shown. Turn it off at any time.
      </td>
    </tr>
  </tbody>
</table>

<p>
  DevSpace is open to new sponsors.
  <a href="https://x.com/wshxnv">Get in touch to become one.</a>
</p>

## Installation

DevSpace requires Node `>=22.19 <27`.

Install the DevSpace CLI:

```bash
npm install -g @waishnav/devspace
```

Then initialize and start the server:

```bash
devspace init
devspace serve
```

Or run it without a global install:

```bash
npx @waishnav/devspace init
npx @waishnav/devspace serve
```

During setup, DevSpace asks for:

- the local project folders ChatGPT is allowed to open through DevSpace
- the local port, usually `7676`
- your public HTTPS base URL from Cloudflare Tunnel, ngrok, Pinggy, Tailscale Funnel, or
  another reverse proxy

Use the public origin without `/mcp` during setup:

```text
https://your-tunnel-host.example.com
```

You will configure your MCP client with the public `/mcp` URL after setup.

When the client connects, DevSpace opens an Owner password approval page. Enter
the Owner password printed by `devspace init`. It is also stored in:

```text
~/.devspace/auth.json
```

Keep that password private.

## Connect Your MCP Client

The default local endpoint is:

```text
http://127.0.0.1:7676/mcp
```

The local dark-theme session monitor is available while the server is running:

```text
http://127.0.0.1:7676/monitor
```

The monitor is intentionally local-only. It shows one stable row per Workbridge
workspace session (`workspaceId`), even when the MCP client creates a fresh
transport session for each tool call. Tool calls appear in execution order with
per-session call counts, per-node call numbers and durations, and the current
Running, Waiting, Idle, or Error state. New workspace sessions are inserted at
the top by workspace-session start time; existing rows do not move when later
activity occurs. The compact ID shown beside each row matches the workspace ID
column used by the compact console tool logs.

The same window also contains a resizable live console panel. Workbridge keeps
the latest 300 console lines in memory, returns the initial history from
`/monitor/api/logs`, and streams new lines over Server-Sent Events from
`/monitor/api/logs/stream`. The panel supports ALL, HTTP, READ, RUN, CHANGE, and
ERROR filters, optional automatic scrolling, display-only clearing, and
expandable structured log details. The console APIs inherit the same local-only
access restriction as the monitor page.

### Desktop monitor window

The monitor can run in a separate Electron window without browser tabs or an
address bar. The desktop wrapper is isolated under `desktop/monitor`, so the
published Workbridge server does not acquire Electron as a production
dependency.

Install the desktop-only dependencies once, start Workbridge normally, and then
open the monitor window:

```bash
npm run monitor:desktop:install
npm run monitor:desktop
```

The window loads `http://127.0.0.1:7676/monitor` by default. Override it with
`WORKBRIDGE_MONITOR_URL` when Workbridge uses another local port. The wrapper
remembers its size, position, maximized state, and the monitor's own console
split height. If Workbridge is not running yet, the window remains open and
switches to the monitor automatically when the local endpoint becomes ready.

Create a Windows desktop app directory with:

```bash
npm run monitor:desktop:pack
```

Build output is written under `desktop/monitor/release` and is not committed.
The generated directory contains `Workbridge Monitor.exe` and its required
Electron runtime files. A signed installer or single-file portable package is
intentionally deferred so the first version does not introduce a second,
security-sensitive packaging stack.

Most users should connect through a public HTTPS tunnel:

```text
https://your-tunnel-host.example.com/mcp
```

> [!NOTE]
> Using DevSpace as an MCP connector isn't against OpenAI's Usage Policies — it's
> a standard custom App/connector setup, and writing or running code isn't a
> restricted use case. But your account is governed by your usage, not by
> DevSpace. Don't point it at anything that would violate your provider's terms.
> Used normally, you're fine. (Based on OpenAI's Usage Policies and Service Terms
> as of June 2026.)

## What ChatGPT Can Do

Once connected, ChatGPT can open one of your approved project folders as a
workspace. From there, it can inspect the repo, make scoped edits, run commands,
and show you what changed.

Workbridge gives ChatGPT a fixed seven-tool surface to:

- open and reuse workspace-scoped sessions
- read files and project instructions
- apply consolidated multi-file patches
- run commands for inspection, tests, builds, and Git
- poll or interact with long-running processes
- run registered, policy-controlled workspace actions
- download MCP-host native files into Linux workspaces without changing the tool schema on other platforms
- use isolated Git worktrees and discover local Agent Skills

## Mental Model

DevSpace is remote access to selected local folders.

You decide which roots are allowed. The MCP client still has powerful local
capabilities inside an opened workspace, including shell execution. Treat a
connected client like a trusted coding partner with access to your machine.

For a normal ChatGPT coding session:

1. Start your tunnel.
2. Run `devspace serve`.
3. Connect the MCP client to your public `/mcp` URL.
4. Approve the connection with the Owner password.
5. Ask ChatGPT to open a project inside one of your allowed roots.

## Platform Support

Workbridge supports Linux, macOS, and Windows. The fixed `exec_command` tool
uses `ComSpec` on Windows, normally `cmd.exe`. On macOS and Linux it uses a
supported shell from `SHELL`, with `/bin/sh` as fallback. PowerShell is not
selected automatically.

Run `devspace doctor` to inspect the resolved environment.

## Documentation

- [Setup Guide](https://github.com/Waishnav/devspace/blob/main/docs/setup.md)
- [ChatGPT Coding Workflow](https://github.com/Waishnav/devspace/blob/main/docs/chatgpt-coding-workflow.md)
- [Configuration Reference](https://github.com/Waishnav/devspace/blob/main/docs/configuration.md)
- [Native File Download](https://github.com/Waishnav/devspace/blob/main/docs/artifact-exchange.md)
- [Security Model](https://github.com/Waishnav/devspace/blob/main/docs/security.md)
- [Troubleshooting Gotchas](https://github.com/Waishnav/devspace/blob/main/docs/gotchas.md)

## Philosophy

Every piece of software is becoming conversational. Natural language is
redefining how we interact with tools, workflows, and systems.

My bet is that ChatGPT becomes the operating system for everything. Once we
reach AGI, we will simply talk to ChatGPT, and it will prompt, coordinate, and
orchestrate sub-agents that set up the right loops for us.

We are not there yet.

DevSpace is one attempt to fast-forward that future: a way for MCP-capable
hosts like ChatGPT and Claude to work directly with local project files through
explicit, inspectable tools.

## Built by Waishnav

I'm Waishnav, I like building opinionated products and tools, and DevSpace is one example of that.
This year, I started my journey to build a single-person and multiple-agents company doing multiple millions in
revenue. If you want to watch the failures, wins, lessons, and everything in
between, come hang out with me on [X](https://x.com/wshxnv).

## More from me

<table>
  <thead>
    <tr>
      <th>Project</th>
      <th>About</th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <td align="center" width="220">
        <a href="https://gitcms.dev/">
          <img
            src="https://gitcms.dev/brand/gitcms-logo.svg"
            alt="GitCMS"
            width="48"
          /><br />
          <strong>GitCMS</strong>
        </a>
      </td>
      <td>
        <strong>Modern CMS and tooling for markdown based content sites — built for agents and humans.</strong><br><br>
        Visual editing, editorial workflow, and ChatGPT/Claude content agents, with
        every post and page stored as files in your repo.
        <a href="https://gitcms.dev/">Learn more</a>.
      </td>
    </tr>
  </tbody>
</table>

## Local Development

For working on DevSpace itself:

```bash
npm install --include=dev
npm run dev
npm run typecheck
npm test
npm run build
npm run start
```
