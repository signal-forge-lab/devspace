# Codex Prompt: Implement Batched Workspace Tools

以下のリポジトリで作業してください。

```text
<path-to-your-devspace-repository>
```

現在のブランチは以下を想定しています。

```text
feature/batched-workspace-tools
```

詳細な作業仕様は次のファイルにまとめています。

```text
docs/codex_task_batched_workspace_tools.md
```

このタスクファイルを必ず読んでから、内容に従って実装してください。

## 実装対象

以下の2つの read-only MCP tools を追加してください。

1. `workspace_snapshot`
2. `read_many`

今回の対象外:

- `edit_many`
- `show_changes` の `DEVSPACE_WIDGETS=off` 対応
- OAuth / tunnel / trust proxy 周辺の変更
- widget UI の大きな変更

## 目的

ChatGPT / MCP / DevSpace 利用時の往復回数を減らすことが目的です。
現在は `read`、`bash`、`find`、`git status` などを細かく呼びがちなので、初動調査と複数ファイル読み取りをまとめられるようにしてください。

改善後の理想フローは以下です。

```text
open_workspace
workspace_snapshot
read_many
```

## 実装方針

- 既存の `open_workspace` → `workspaceId` 再利用フローを壊さないでください。
- 追加ツールは read-only としてください。
- allowed roots / workspace root の安全制約を維持してください。
- `read_many` は既存の `read` と同じパス解決・offset/limitの考え方に合わせてください。
- `workspace_snapshot` は Git repo でない場合も失敗させず、可能な範囲の情報を返してください。
- 出力が大きくなりすぎないように上限を設けてください。
- `.env`、token、cookie、session、auth関連ファイルを自動対象に含めないでください。
- 既存ツールの挙動を壊さないでください。

## 主に確認・変更するファイル

まず以下を確認してください。

```text
src/server.ts
src/pi-tools.ts
src/workspaces.ts
src/roots.ts
src/review-checkpoints.ts
package.json
docs/chatgpt-coding-workflow.md
```

実装は、できれば以下のように整理してください。

```text
src/server.ts                    # tool registration
src/workspace-snapshot.ts        # workspace_snapshot helper, if useful
src/batched-tools.test.ts        # tests, or equivalent test file
```

`read_many` は最小実装では `src/server.ts` 内で既存 `readFileTool()` を複数回呼ぶ形でも構いません。

## 検証

実装後、最低限以下を実行してください。

```bash
npm test
npm run typecheck
npm run build
```

失敗した場合は、失敗理由と未解決点を明記してください。

## ドキュメント

以下のいずれかに、追加ツールの目的と使いどころを追記してください。

- `README.md`
- `docs/chatgpt-coding-workflow.md`
- `docs/configuration.md`

## 最後に報告してください

以下の形式で報告してください。

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

作業完了前に必ず以下も確認してください。

```bash
git diff --stat
git status --short
```
