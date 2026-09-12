# Workbridge

[English](README.md) | [日本語](README.ja.md)

Workbridge は、ChatGPT から自分のPC上の許可済みプロジェクトへ安全に接続し、コードの読取・編集・検索・コマンド実行を行うための self-hosted MCP server です。接続対象のrootを利用者が限定し、公開HTTPS tunnelとOwner passwordによって接続を承認します。

## 要件

- Node `>=22.19 <27`
- npm
- Git
- Bash互換shell

Windowsでは Git Bash、WSL、MSYS2、Cygwin Bash などを利用できます。

## インストール

```bash
npm install -g @waishnav/devspace
workbridge init
workbridge serve
```

グローバルインストールせず実行する場合:

```bash
npx @waishnav/devspace init
npx @waishnav/devspace serve
```

初期設定では、ChatGPTから開くことを許可するローカルroot、local port、公開HTTPS base URLを設定します。設定例は `.env.example` を参照し、実PCのパス・Owner password・token・Secretはコミットしないでください。

## MCP接続

既定のローカルendpoint:

```text
http://127.0.0.1:7676/mcp
```

外部MCP clientから接続する場合は、自分で管理するHTTPS tunnelを通した `/mcp` URLを使用します。接続時は `workbridge init` が生成したOwner passwordで承認します。

## 主な機能

- 許可済みroot内のworkspaceを開く
- repository snapshotとindexによる効率的な読取
- scopedなファイル編集
- code search、directory inspection
- tests/build/package scriptなどのcommand実行
- Git status、stage、commit、hunk staging
- isolated worktreeによる並列作業
- `AGENTS.md` / `CLAUDE.md` のproject instruction読込
- local agent skillの発見

## セキュリティ境界

Workbridgeは選択したローカルフォルダへの強力なremote accessです。接続したMCP clientは、許可範囲内でshell実行を含む操作が可能なため、信頼できるclientとして扱ってください。

Public repositoryには次を置きません。

- Owner password、API key、OAuth tokenなどのSecret
- 実PC固有のroot path
- `.env` の実値
- local state、log、worktree、生成artifact

公開用の設定例では `/path/to/...` などの明示的なplaceholderだけを使用します。

## 診断

```bash
workbridge doctor
```

このbranchはWorkbridge向けの開発線です。公開branchであるため、すべてのcommitは公開可能な内容だけを含む前提で管理します。
