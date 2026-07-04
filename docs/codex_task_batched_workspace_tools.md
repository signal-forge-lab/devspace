# Codex Task: Batched Workspace Tools for DevSpace

## 背景

このリポジトリは `Waishnav/devspace` の fork です。
現在の作業ブランチは以下です。

```text
feature/batched-workspace-tools
```

目的は、ChatGPT / MCP / DevSpace 利用時の往復回数を減らし、実作業の体感速度を改善することです。
現状の DevSpace は `open_workspace`、`read`、`write`、`edit`、`bash` などの粒度が細かく、丁寧に調査すると MCP 呼び出し回数が増えます。

まずは破壊的操作を増やさず、読み取り・初動調査をまとめる方向で改善してください。

## 実装ゴール

以下の2つの read-only MCP tools を追加してください。

1. `workspace_snapshot`
2. `read_many`

編集系の `edit_many` は今回の対象外です。
`show_changes` の `DEVSPACE_WIDGETS=off` 対応も今回の対象外です。

## 既存構成の前提

主要ファイルは以下です。

- `src/server.ts`
  - MCP server / tool registration の中心。
  - 既存の `open_workspace`、`read`、`write`、`edit`、`bash` などがここで登録されている。
- `src/pi-tools.ts`
  - `@earendil-works/pi-coding-agent` の read/write/edit/bash 等を薄くラップしている。
- `src/workspaces.ts`
  - `workspaceId` 管理、allowed roots、AGENTS.md / CLAUDE.md 検出、read path 解決を担当。
- `src/roots.ts`
  - path allowlist / safety check を担当。
- `src/ui/*`
  - widget UI。今回の実装では原則触らない。

## 実装方針

### 共通方針

- 既存の `open_workspace` → `workspaceId` 再利用フローを維持する。
- 追加ツールは read-only とし、ファイル作成・更新・削除を行わない。
- allowed roots / workspace root の安全制約を維持する。
- 既存 `read` と同様に、必要な場合は `workspaces.resolveReadPath()` を通す。
- 既存の `read` / `bash` / `show_changes` などの挙動を壊さない。
- `DEVSPACE_TOOL_MODE=minimal` でも追加ツールが利用できるようにする。
- 既存の tool naming mode との関係を確認し、短い名前の運用に合わせる。
- UI widget 側は今回の主目的ではないため、必要最低限に留める。

## Tool 1: `read_many`

### 目的

複数ファイルの読み取りを1回の MCP call にまとめる。

現状は以下のように複数回の `read` が必要になる。

```text
read README.md
read package.json
read src/server.ts
read src/pi-tools.ts
read src/workspaces.ts
```

これを1回にまとめる。

### 入力仕様案

```ts
{
  workspaceId: string;
  files: Array<{
    path: string;
    offset?: number; // 1-indexed, same as read
    limit?: number;  // max lines, same as read
  }>;
  maxTotalCharacters?: number;
}
```

### 制約

- `files` は最低1件、最大20件程度に制限する。
- `offset` / `limit` は既存 `read` と同じ意味にする。
- `maxTotalCharacters` は任意。未指定時は安全なデフォルトを設定する。
  - 例: 120000 characters 程度。
- 合計出力が上限を超える場合は、途中で止めるか、各ファイルごとに truncated 情報を返す。
- 1ファイルの失敗で全体を落とすのではなく、ファイル単位で `ok: false` / `error` を返す方針を優先する。
- ただし、`workspaceId` が不正など workspace 全体のエラーは通常エラーでよい。
- SKILL.md / nested instruction file の扱いは既存 `read` と矛盾しないようにする。
- ファイル読み取り後、既存 `read` と同様に必要なら `workspaces.markReadPathLoaded()` を呼ぶ。

### 出力仕様案

```ts
{
  files: Array<{
    path: string;
    ok: boolean;
    content?: string;
    error?: string;
    offset: number;
    limited: boolean;
    characters?: number;
    lines?: number;
  }>;
  summary: {
    requested: number;
    succeeded: number;
    failed: number;
    characters: number;
    truncated: boolean;
  };
  result: string;
}
```

`result` は model-readable なテキストとして、ファイルごとの見出し付きで返す。

例:

```text
# README.md
...

# src/server.ts
...
```

## Tool 2: `workspace_snapshot`

### 目的

`open_workspace` 後の初動調査を1回の MCP call にまとめる。

現状は以下を複数 call で確認しがち。

```text
git status
git branch
find .
read package.json
read README.md
read AGENTS.md
read docs一覧
read src一覧
```

これを1回にまとめる。

### 入力仕様案

```ts
{
  workspaceId: string;
  include?: {
    git?: boolean;
    topLevelFiles?: boolean;
    packageJson?: boolean;
    docs?: boolean;
    src?: boolean;
    agents?: boolean;
  };
  maxFiles?: number;
}
```

`include` 未指定時は、軽量なデフォルトセットを返す。

### 返す情報

最低限、以下を返してください。

```text
- workspaceId
- root
- mode
- sourceRoot / worktree summary if present
- git repository かどうか
- git branch
- git status --short
- top-level file list
- README.md の有無
- AGENTS.md / CLAUDE.md の有無
- package.json の有無
- package.json scripts summary
- docs/ 配下の主要ファイル一覧
- src/ 配下の主要ファイル一覧
- test command candidates
```

### git 情報について

- Git repo でない場合はエラーにせず、`isGitRepo: false` として返す。
- `git status --short` / `git branch --show-current` 相当の情報を返す。
- Gitコマンドが失敗しても snapshot 全体を失敗にしない。

### ファイル一覧について

- `node_modules`、`.git`、`dist`、`build`、`.cache` などは除外する。
- 深すぎる再帰は避ける。
- まずは `top-level`、`docs`、`src` 程度で十分。
- `maxFiles` で過剰出力を防ぐ。

### package.json について

存在する場合、以下を返す。

```text
name
version
type
scripts
主要 dependencies/devDependencies のキー一覧
```

全 dependency version の詳細は不要。

### test command candidates

以下のように推定する。

- `package.json` に `test` があれば `npm test`
- `typecheck` があれば `npm run typecheck`
- `build` があれば `npm run build`

## 実装場所の提案

### `read_many`

最小実装では `src/server.ts` に tool registration を追加し、既存 `readFileTool()` を複数回呼ぶ形でよいです。

必要なら補助関数を `src/server.ts` 内に追加して構いません。
ただし肥大化しすぎる場合は新規ファイルに分離してください。

### `workspace_snapshot`

`src/server.ts` に直接大きく書くと肥大化しやすいため、新規ファイルを推奨します。

```text
src/workspace-snapshot.ts
```

想定責務:

- workspace root の情報収集
- package.json の軽量パース
- git情報の安全取得
- 除外ディレクトリを避けた軽量ファイル一覧
- snapshot result の整形

`server.ts` は tool registration と `workspaceSnapshot(...)` 呼び出しに留めるのが望ましいです。

## テスト方針

少なくとも以下を追加・更新してください。

### 新規テスト候補

```text
src/batched-tools.test.ts
```

または、既存の構成に合わせて適切な test file 名にしてください。

### テスト観点

`read_many`:

- 複数ファイルを1回で読める。
- `offset` / `limit` が効く。
- 存在しないファイルはファイル単位の error として返る。
- workspace外パスを読めない。
- summary の requested/succeeded/failed が正しい。
- maxTotalCharacters で過剰出力を抑制できる。

`workspace_snapshot`:

- Git repo で snapshot が返る。
- Git repo でないディレクトリでも失敗しない。
- package.json scripts を返せる。
- top-level / docs / src のファイル一覧を返せる。
- node_modules / .git / dist などを除外する。
- test command candidates を推定できる。

## 実行する確認コマンド

実装後、最低限以下を実行してください。

```bash
npm test
npm run typecheck
npm run build
```

`npm run build` が時間や環境都合で失敗する場合は、失敗理由を明記してください。

## ドキュメント更新

以下のいずれかを更新してください。

- `README.md`
- `docs/chatgpt-coding-workflow.md`
- `docs/configuration.md`

最低限、追加された `workspace_snapshot` と `read_many` の目的・使いどころを追記してください。

## 期待される利用フロー

改善後、ChatGPT / MCP 側の初動は以下を目指します。

```text
open_workspace
workspace_snapshot
read_many
```

従来の以下より往復を減らすことが目的です。

```text
open_workspace
bash git status
bash find
read package.json
read README.md
read AGENTS.md
read src/server.ts
read src/pi-tools.ts
```

## 完了条件

- `workspace_snapshot` tool が登録され、MCPクライアントから呼べる。
- `read_many` tool が登録され、MCPクライアントから呼べる。
- 既存ツールの挙動を壊していない。
- `npm test` が成功する。
- `npm run typecheck` が成功する。
- 可能なら `npm run build` が成功する。
- ドキュメントに追加ツールの説明がある。
- `git diff` と `git status --short` を確認し、変更内容を要約する。

## 実装時の注意

- shell redirection、heredoc、`sed -i`、生成スクリプトでプロジェクトファイルを書き換えないでください。
- ファイル変更は通常のエディタ操作または Codex の安全な編集機能で行ってください。
- 秘密情報、token、cookie、session、auth関連ファイルを読まない・出力しないでください。
- `.env` 系ファイルは snapshot / read_many の自動対象に含めないでください。
- 出力が大きくなりすぎないよう、必ず上限を設けてください。
- 既存の OAuth / auth / tunnel / trust proxy 周辺は今回の対象外です。

## 最終報告フォーマット

作業完了後、以下を報告してください。

```text
変更概要:
- ...

変更ファイル:
- ...

追加ツール:
- workspace_snapshot
- read_many

検証:
- npm test: pass/fail
- npm run typecheck: pass/fail
- npm run build: pass/fail

未確認・懸念:
- ...

git:
- branch: feature/batched-workspace-tools
- status: ...
```
