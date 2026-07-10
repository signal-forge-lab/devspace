# Workbridge コードレビュー・改修タスク台帳

この文書は、2026-07-11 に実施した Workbridge 全体レビューと、その前後に実施した関連改修について、**何が完了し、何が未対応で、次に何を行うか**を一元管理するための正本である。

今後このレビュー系統の作業を進める際は、会話上の説明だけでなく、本書の状態・実施commit・完了条件を更新する。

## 1. 管理情報

- 対象リポジトリ: `signal-forge-lab/devspace`
- ローカルブランチ: `feature/workbridge-stable-surface`
- レビュー実施日: 2026-07-11 JST
- レビュー開始時基準commit: `c4e6a1d`
- 確認したupstream: `upstream/main` at `6ccefbf`
- 現在の最新commit: `2bd4658`
- push方針: ユーザー承認があるまでpushしない
- commit方針: 完了した変更は作業単位ごとにcommitする

## 2. 現在の状態サマリ

### 2.1 優先度別進捗

| 区分 | 状態 | 内容 |
|---|---|---|
| 事前関連改修 | 完了 | workspaceId再利用誘導、パス秘匿化、workspace task出力抑制 |
| P0-1 | 完了 | upstream/mainのWindows・AGENTS symlink安全性修正を取り込み |
| P0-2 | 完了 | 一般file toolのrealpath/junction境界修正 |
| P0-3 | 完了 | shell command logging設定の実適用 |
| P1 | 未着手 | 応答sanitizer、子プロセス環境変数、workspace task固定化 |
| P2 | 未着手 | status-only buffer、OAuth、cleanup、version、HTTPログ分類 |
| P3 | 未着手 | server.ts分割、lint/coverage、UI bundle改善 |

### 2.2 次に着手する推奨タスク

次は **P1-1: 応答パスsanitizationの一元化** を行う。

理由:

- root系のフルパスは秘匿済みだが、context file、skill diagnostics、tool error、backend detailsなどに残存経路がある。
- ファイル本文を改変せず、Workbridgeが生成したmetadata・error・detailsだけを安全に処理する共通境界が必要である。

## 3. レビュー前後に完了した関連改修

以下はP0レビュー着手前に完了していた、今回のセキュリティ・安定性レビューと直接関係する変更である。

### DONE-A: workspaceId再利用誘導

- 状態: 完了
- commit: `256f739 feat reduce workspace reopen prompts`
- 目的: 同じfolderで不要な`open_workspace`再実行を減らす
- 実施内容:
  - `open_workspace`の説明を「必要時だけ呼ぶ」方針へ変更
  - downstream toolのworkspaceId説明に再利用指示を追加
  - unknown workspaceId時のみ再openする誘導へ変更
- 未実装:
  - サーバー側の自動workspace逆引き
  - stable alias
  - 重複openの強制拒否

### DONE-B: workspace task dryRunのフルパス秘匿

- 状態: 完了
- commit: `84b7e1a fix redact workspace task dry runs`
- 実施内容:
  - 実行用`command`と表示用`displayCommand`を分離
  - dryRun、card summary、通常summaryでは`<workspace>/...`を返す
  - 実行内部では従来どおり絶対パスを使用

### DONE-C: workspace task stdout/stderrの外部返却抑制

- 状態: 完了
- commit: `5f12a25 fix suppress workspace task output`
- 実施内容:
  - `launch_workspace_task`由来processを`outputMode: status`に設定
  - 初回応答・`write_stdin` pollingともstdout/stderr本文を返さない
  - running、sessionId、exitCode、signal、wallTimeなど状態だけ返す

### DONE-D: open_workspace返却パスの秘匿

- 状態: 完了
- commit: `56d093e fix redact open workspace paths`
- 実施内容:
  - response本文のrootを`<workspace>`へ変更
  - `_meta.card.root/path`を`<workspace>`へ変更
  - `structuredContent.root/sourceRoot/worktree.path`を秘匿
  - open_workspace tool logのpathも秘匿
- 注意:
  - context file path、diagnostics、error detailsなどはP1-1対象

### DONE-E: exec_command/bash出力のworkspace/homeパス秘匿

- 状態: 完了
- commit: `c4e6a1d fix redact command path output`
- 実施内容:
  - 共通`path-redaction`を追加
  - workspace rootを`<workspace>`へ置換
  - user homeを`~`へ置換
  - `exec_command`、後続`write_stdin`、`bash`のstdout/stderrへ適用
  - command summary/logにも同じredactionを適用
- 対象外:
  - `read`で取得したファイル本文自体
  - 任意のsecret文字列

## 4. upstream/mainレビューと取り込み

### P0-1: upstream/mainの取り込み

- 状態: **完了**
- 実施日: 2026-07-11
- merge commit: `b73ce47 merge upstream main security fixes`
- 取り込み前upstream参照: `d031874`
- 取り込み対象upstream: `6ccefbf`
- 競合: なし

取り込んだ主な変更:

1. `629318c` — Windows drive rootをcheckout workspaceとして開く修正
2. `71d7f07` — symlinkされたAGENTS context fileの実体解決
3. `94afa09` — 許可範囲外を指すAGENTS symlink targetの拒否
4. `6242f29` — AGENTS realpath containmentのCI修正
5. `2fd5dc3` — Windows AGENTS fixture discovery修正

対象ファイル:

- `src/workspaces.ts`
- `src/workspaces.test.ts`

完了条件と結果:

| 条件 | 結果 |
|---|---|
| merge競合なし | 成功 |
| Workbridge固有のworkspaceId再利用説明を維持 | 成功 |
| `npm run typecheck` | 成功 |
| `npm test` | 成功 |
| `npm run build` | 成功 |
| `git diff --check` | 成功 |

## 5. P0改修

### P0-2: 一般file toolのrealpath境界修正

- 状態: **完了**
- commit: `6c3aa0c fix enforce realpath workspace boundaries`

#### 問題

従来の`src/roots.ts`は`resolve()`と`relative()`による文字列上の判定のみだった。

そのため、workspace内のsymlinkまたはWindows junctionがworkspace外を指していても、見かけ上のパスがworkspace配下であれば許可される可能性があった。

安全な一時領域で再現確認し、junction経由でworkspace外のファイルを読めることを確認した。

#### 対象tool

- `read`
- `write`
- `edit`
- `grep`
- `glob` / find
- `ls`

`apply_patch`は既に独自のrealpath-aware confinementを持っていたため、その既存設計を維持した。

#### 実施内容

- `resolveAllowedRealPath()`を共通resolverとして追加
- workspace root自体を`realpath()`で解決
- 対象が存在する場合は対象実体を`realpath()`で解決
- 新規ファイルなど対象が存在しない場合は、最も近い既存親を解決
- 実体または既存親が許可root外なら拒否
- read用の追加許可rootにも同じrealpath境界を適用
- `pi-tools.ts`の一般file toolへ共通適用

#### 追加した回帰テスト

- workspace外fileを指すsymlinkの拒否
- workspace外directoryを指すsymlinkの拒否
- Windows junction escapeの拒否
- escaped parent配下への新規ファイル作成拒否
- workspace内を指す正常symlinkの許可
- 明示的に許可された追加read rootの許可

#### 完了条件と結果

| 条件 | 結果 |
|---|---|
| 単体テスト | 成功 |
| `npm run typecheck` | 成功 |
| `npm test` | 成功 |
| `npm run build` | 成功 |
| `git diff --check` | 成功 |

### P0-3: shell command logging設定の実適用

- 状態: **完了**
- commit: `2bd4658 fix honor shell command logging policy`

#### 問題

`DEVSPACE_LOG_SHELL_COMMANDS`は既定OFFであり、security documentationも「明示有効化しない限りcommand previewを記録しない」としていた。

しかし実装上は`logToolCall()`が設定を参照せず、commandを受け取ると常に`commandPreview`をJSONLへ記録していた。

#### 実施内容

- 既定OFFでは以下のcommand previewとcommand lengthを記録しない
  - `exec_command`
  - `bash`
  - `launch_workspace_task`
- `DEVSPACE_LOG_SHELL_COMMANDS=1`の場合だけredaction済みpreviewを記録
- `write_stdin`の入力文字列は設定ONでも記録しない
- `launch_workspace_task`はcommand本文なしでも以下を記録
  - task
  - template
  - dryRun
  - workspaceId
  - workingDirectory
  - success/failure
  - duration
- JSONLとcompact consoleで同じ方針を使用

#### 追加した回帰テスト

- logging OFFでcommand previewがない
- logging OFFでcommand lengthがない
- logging ONでredaction済みcommand previewがある
- `write_stdin`入力が記録されない

#### 完了条件と結果

| 条件 | 結果 |
|---|---|
| 単体テスト | 成功 |
| `npm run typecheck` | 成功 |
| `npm test` | 成功 |
| `npm run build` | 成功 |
| `git diff --check` | 成功 |

## 6. 未対応P1タスク

### P1-1: 応答パスsanitizationの一元化

- 状態: **未着手**
- 優先順位: P1の先頭

#### 残存する可能性がある経路

- workspace外にあるglobal AGENTS/CLAUDE path
- skill pathおよびskill diagnostics
- tool error message
- backend detailsの`fullOutputPath`等
- system-generated metadata内の絶対パス

#### 実装方針

- Workbridgeが生成したmetadata、error、detailsは共通sanitizerを通す
- workspace rootは`<workspace>`へ置換
- user homeは`~`へ置換
- 内部一時出力pathは返却しないか`<internal-output>`へ置換
- `read`で取得したファイル本文は改変しない
- process stdout/stderrは現在のpath redactionを維持

#### 完了条件

- context file pathの絶対パスが外部返却されない
- skill diagnosticsの絶対パスが外部返却されない
- error messageのworkspace/home pathが秘匿される
- backend detail fieldに絶対パスが残らない
- ファイル本文は原文のまま返る
- full test/buildが成功する

### P1-2: 子プロセス環境変数の最小化

- 状態: **未着手**

#### 問題

`exec_command`とworkspace taskの子プロセスは、現在Workbridge processの環境変数をほぼすべて継承している。

これにはOAuth owner token、API key、webhook、cloud credentialなどが含まれる可能性がある。

#### 実装候補

- safe baseline environmentを定義
- `PATH`、`HOME`、`TEMP`、`SystemRoot`など必要値だけ既定継承
-追加pass-throughを明示allowlist化
- 以下の名称パターンは既定除外
  - `*_TOKEN`
  - `*_SECRET`
  - `*_PASSWORD`
  - `AUTHORIZATION`
  - `DEVSPACE_OAUTH_OWNER_TOKEN`
- workspace taskごとの環境変数allowlistを検討

#### 完了条件

- OAuth owner tokenが子プロセス環境に存在しない
- 一般的なsecret patternが既定除外される
- Node/Python/Git等の通常実行が壊れない
- Aegis Gateに必要な変数を安全に明示できる
- Windows/Linux/macOSテストが通る

### P1-3: workspace taskをtemplate-only既定へ変更

- 状態: **未着手**

#### 問題

`launch_workspace_task`はtask/templateに加えて任意`args[]`を受け付けるため、完全な固定CLIではない。

workspace taskはraw shellより安全だが、OSレベルの完全なsecurity boundaryではなくworkflow boundaryである。

#### 実装候補

- 既定ではtemplate指定のみ許可
- dynamic argsは明示的な環境変数またはworkspace configでopt-in
- templateごとの許可追加引数schemaを定義する方式も検討
- dryRun表示は引き続き`displayCommand`のみ使用

#### 完了条件

- 既定状態で任意argsを追加できない
- 既存のAegis Gate固定templateが動作する
- opt-inなしでtask定義外CLIへ拡張できない
- regression testがある

## 7. 未対応P2タスク

### P2-1: status-only processでstdout/stderrをbufferしない

- 状態: 未着手
- 現状: `launch_workspace_task`は外部返却しないが、内部`HeadTailBuffer`には一度格納している
- 改善: `outputMode === "status"`ではbufferへのappend自体を行わない

### P2-2: OAuth authorization rate limit

- 状態: 未着手
- 改善候補:
  - IP単位の短時間rate limit
  - owner password失敗時の遅延
  - dynamic client registration件数制限
  - 古いclient recordのcleanup

### P2-3: OAuth redirect scheme制限

- 状態: 未着手
- 現状: redirect URIは主にhostnameで判定
- 改善候補:
  - `chatgpt.com`等の外部hostはHTTPSのみ
  - localhost/127.0.0.1/::1だけHTTP許可

### P2-4: MCP transport/session cleanup

- 状態: 未着手
- 改善候補:
  - idle timeout
  - transport最大数
  - stale transportの定期cleanup
  - stale workspace session recordのcleanup

### P2-5: review refs cleanup

- 状態: 未着手
- 対象: `refs/devspace/review/*`
- 現在の安定設定`DEVSPACE_WIDGETS=off`では直近影響は小さい

### P2-6: version source of truth統一

- 状態: 未着手
- 現在の不一致:
  - package version: `1.0.5`
  - MCP server version: `0.1.0`
  - package/docs Node range: `>=22.19 <27`
  - CLI doctor Node range: `>=20.12 <27`

### P2-7: expected HTTP probeのログ分類

- 状態: 未着手
- 対象例:
  - unauthenticated `POST /mcp` の401
  - `GET /.well-known/openid-configuration` の404
- 改善: `failed`ではなく`auth`、`probe`、`ignored`等の分類を検討

## 8. 未対応P3タスク

### P3-1: `src/server.ts`分割

- 状態: 未着手
- 現状: 約2,000行
- 分離候補:
  - `mcp/tools/workspace.ts`
  - `mcp/tools/files.ts`
  - `mcp/tools/process.ts`
  - `mcp/tools/tasks.ts`
  - `mcp/response-sanitizer.ts`
  - `http/auth.ts`
  - `http/logging.ts`

### P3-2: lint導入

- 状態: 未着手
- 候補: ESLintまたは同等の静的検査

### P3-3: coverageとsecurity regression test分離

- 状態: 未着手
- 改善候補:
  - coverage threshold
  - security regression test group
  - integration test group

### P3-4: UI bundle改善

- 状態: 未着手
- 現状: build成功するが500KB超chunk警告あり
- 改善候補: syntax highlighting assets等のlazy loading

## 9. 維持すべき現在の良い点

- OAuth tokenは平文ではなくhashでSQLite保存
- refresh token rotationはtransaction化
- SQLite state directory/fileにrestrictive permissionを設定
- `apply_patch`はrealpath-aware confinementとatomic writeを実装済み
- process sessionは作成workspaceIdへ紐付け
- CIはWindows、macOS、Linuxを対象
- dependency auditで既知脆弱性0件
- `codex` modeは比較的小さいtool surface
- command/output path redactionあり
- workspace task stdout/stderr外部返却抑制あり
- full test、typecheck、buildが安定して成功

## 10. 検証コマンド

各実装タスクの完了時に、原則として以下を実行する。

```text
npm run typecheck
npm test
npm run build
git diff --check
```

セキュリティ・依存関係の節目では以下も実行する。

```text
node dist/cli.js doctor
npm audit --omit=dev
npm audit
npm pack --dry-run
```

## 11. commit対応表

| commit | 状態 | 内容 |
|---|---|---|
| `256f739` | 完了 | workspaceId再利用誘導 |
| `84b7e1a` | 完了 | workspace task dryRunパス秘匿 |
| `5f12a25` | 完了 | workspace task stdout/stderr返却抑制 |
| `56d093e` | 完了 | open_workspace root/path秘匿 |
| `c4e6a1d` | 完了 | exec_command/bash出力パス秘匿 |
| `9b019de` | 完了 | 初版レビューaction plan作成 |
| `b73ce47` | 完了 | upstream/mainセキュリティ修正取り込み |
| `6c3aa0c` | 完了 | 一般file tool realpath境界修正 |
| `2bd4658` | 完了 | shell command logging policy修正 |

## 12. 現在のGit状態

2026-07-11の本書更新前確認時点:

```text
branch: feature/workbridge-stable-surface
remote tracking: origin/feature/workbridge-stable-surface
ahead: 16 commits
tracked changes: none
untracked and intentionally untouched:
  .codex/
  .devspace/
  logs/
  reports/
```

本書更新commit後はahead数が1増える。pushはまだ実施しない。

## 13. 今後の実行順

1. P1-1 応答パスsanitizationの一元化
2. P1-2 子プロセス環境変数の最小化
3. P1-3 workspace task template-only既定化
4. P2-1 status-only process buffer抑制
5. P2-2 / P2-3 OAuth強化
6. P2-4 / P2-5 lifecycle cleanup
7. P2-6 version統一
8. P2-7 HTTPログ分類
9. P3保守性改善

各タスク着手時は、本書の状態を「作業中」へ変更し、完了後に以下を追記する。

- 実装概要
- 対象ファイル
- 追加テスト
- 検証結果
- commit hash
- 残課題
