# Workbridge コードレビュー・改修タスク台帳

この文書は、2026-07-11 に実施した Workbridge 全体レビューと、その前後に実施した関連改修について、**何が完了し、何が未対応で、次に何を行うか**を一元管理するための正本である。

今後このレビュー系統の作業を進める際は、会話上の説明だけでなく、本書の状態・実施commit・完了条件を更新する。

## 1. 管理情報

- 対象リポジトリ: `signal-forge-lab/devspace`
- ローカルブランチ: `feature/workbridge-stable-surface`
- レビュー実施日: 2026-07-11 JST
- レビュー開始時基準commit: `c4e6a1d`
- 確認したupstream: `upstream/main` at `6ccefbf`
- 現在の最新実装commit: `6f9c4b7`
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
| P1-1 | 完了 | 応答パスsanitizationの一元化 |
| P1-2 | 完了 | 子プロセス環境変数の最小化と明示allowlist |
| P1-3 | 完了 | workspace taskのtemplate-only既定化 |
| P2-1〜P2-7 | 完了 | buffer抑制、OAuth強化、lifecycle cleanup、version統一、HTTPログ分類 |
| P2-8 | 保留 | ユーザー指定により表示名統一は今回の優先対応から除外 |
| P3-1〜P3-3 | 未着手 | server.ts分割、lint、coverage/test分類 |
| P3-4 | 完了 | 遅延読込chunkの実態に合わせてbuild警告閾値を調整 |

### 2.2 次に着手する推奨タスク

P2-1〜P2-7とP3-4は完了した。次の候補は **P3-1: `src/server.ts`分割** である。

理由:

- P2-8はユーザー指定により保留している。
- P3-1は機能変更を避けながら約2,000行の`server.ts`を分割し、今後の保守・レビュー範囲を小さくできる。

## 3. レビュー前後に完了した関連改修

以下はP0レビュー着手前に完了していた、今回のセキュリティ・安定性レビューと直接関係する変更である。

### DONE-A: workspaceId再利用誘導

- 状態: 完了
- commit: `3983266 feat reduce workspace reopen prompts`
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
- commit: `1753312 fix redact workspace task dry runs`
- 実施内容:
  - 実行用`command`と表示用`displayCommand`を分離
  - dryRun、card summary、通常summaryでは`<workspace>/...`を返す
  - 実行内部では従来どおり絶対パスを使用

### DONE-C: workspace task stdout/stderrの外部返却抑制

- 状態: 完了
- commit: `74042aa fix suppress workspace task output`
- 実施内容:
  - `launch_workspace_task`由来processを`outputMode: status`に設定
  - 初回応答・`write_stdin` pollingともstdout/stderr本文を返さない
  - running、sessionId、exitCode、signal、wallTimeなど状態だけ返す

### DONE-D: open_workspace返却パスの秘匿

- 状態: 完了
- commit: `bef5aa8 fix redact open workspace paths`
- 実施内容:
  - response本文のrootを`<workspace>`へ変更
  - `_meta.card.root/path`を`<workspace>`へ変更
  - `structuredContent.root/sourceRoot/worktree.path`を秘匿
  - open_workspace tool logのpathも秘匿
- 注意:
  - context file path、diagnostics、error detailsなどはP1-1対象

### DONE-E: exec_command/bash出力のworkspace/homeパス秘匿

- 状態: 完了
- commit: `5bc515a fix redact command path output`
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
- 現在のbase: `6ccefbf upstream/main`
- 履歴整理: 2026-07-11にfork固有commitを`upstream/main`直上へrebase済み
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
| rebase競合なし | 成功 |
| Workbridge固有のworkspaceId再利用説明を維持 | 成功 |
| `npm run typecheck` | 成功 |
| `npm test` | 成功 |
| `npm run build` | 成功 |
| `git diff --check` | 成功 |

## 5. P0改修

### P0-2: 一般file toolのrealpath境界修正

- 状態: **完了**
- commit: `e187b68 fix enforce realpath workspace boundaries`

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
- commit: `f3b1ba1 fix honor shell command logging policy`

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

## 6. 対応済みP1タスク

### P1-1: 応答パスsanitizationの一元化

- 状態: **完了（2026-07-11）**
- 実装commit: `fef86c3 fix centralize response path sanitization`

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

#### 実施内容

- `redactPathsInValue()`を追加し、plain objectとarray内のsystem-generated文字列を再帰的にsanitizationするようにした
- tool responseの`details`を共通sanitizerへ通した
- file toolのerror messageをworkspace/home path redaction対象にした
- global AGENTS/CLAUDE pathはuser home配下を`~/...`表示にした
- skill diagnostics、agent provider reason、agent profile summaryをsanitizationした
- `read`成功時のファイル本文はsanitization対象外として原文を維持した
- `src/pi-tools.test.ts`を追加し、file tool errorにworkspace rootが残らないことを確認した

#### 検証結果

- `npm run typecheck`: 成功
- 対象テスト: 成功
- `npm test`: 成功
- `npm run build`: 成功
- `git diff --check`: 成功

### P1-2: 子プロセス環境変数の最小化

- 状態: **完了（2026-07-11）**
- 実装commit: `595beb7 fix minimize child process environment`

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

#### 実施内容

- `src/child-environment.ts`に子プロセス用の最小環境生成処理を追加した
- OS、shell、PATH、home、temp、locale、Git/Python実行に必要な変数だけを既定継承するようにした
- 追加変数は`DEVSPACE_CHILD_ENV_ALLOWLIST`へ名前を明示した場合だけ継承するようにした
- `DEVSPACE_OAUTH_OWNER_TOKEN`とAuthorization系変数はallowlist指定があっても常に遮断するようにした
- allowlist制御変数自体は子プロセスへ渡さない
- workspaceIdとworkspace rootの内部連携変数は従来どおり注入する

#### 運用上の注意

Discord webhook、追加API key、独自build flagなどを親Workbridge processの環境変数からAegis Gateやコマンドへ渡す場合は、必要な変数名だけを明示する。

```text
DEVSPACE_CHILD_ENV_ALLOWLIST=DISCORD_WEBHOOK_URL,CUSTOM_BUILD_FLAG
```

値ではなく変数名だけを設定する。WorkbridgeのOAuth owner tokenは指定しても渡らない。

#### 検証結果

- `npm run typecheck`: 成功
- environment unit/integration test: 成功
- `npm test`: 成功
- `npm run build`: 成功
- `git diff --check`: 成功

### P1-3: workspace taskをtemplate-only既定へ変更

- 状態: **完了（2026-07-11）**
- 実装commit: `bed5536 fix require workspace task templates`

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

#### 実施内容

- 既定状態では`launch_workspace_task`の`template`を必須にした
- 既定状態のmodel-facing schemaから`args`を除外した
- resolver側でもtemplateなし起動と任意`args[]`を拒否する二重防御にした
- `WORKBRIDGE_ENABLE_WORKSPACE_TASK_DYNAMIC_ARGS=1`を明示した場合だけ従来のdynamic args動作を許可する
- workspace task catalogの例から任意args起動を除き、template名を使う例だけを残した
- 既存のworkspace-local templateはそのまま利用可能

#### 検証結果

- `npm run typecheck`: 成功
- config/workspace-task対象テスト: 成功
- `npm test`: 成功
- `npm run build`: 成功
- `git diff --check`: 成功

## 7. P2タスク

### P2-1: status-only processでstdout/stderrをbufferしない

- 状態: **完了（2026-07-11）**
- commit: `b121722 fix avoid buffering status-only output`
- 実施内容:
  - `outputMode === "status"`ではstdout/stderrを`HeadTailBuffer`へ追加しない
  - status-onlyの外部返却抑制だけでなく、内部滞留とメモリ消費も防止
  - 10,000文字を出力するstatus-only processがbufferへ1文字も追加しない回帰テストを追加

### P2-2: OAuth authorization rate limit

- 状態: **完了（2026-07-11）**
- commits:
  - `8504e71 fix harden oauth authorization and redirects`
  - `6f9c4b7 fix prune inactive oauth clients`
- 実施内容:
  - IP単位で5回/5分のowner password失敗を監視し、到達後15分block
  - password失敗時に既定250msの遅延
  - dynamic client registrationを既定50件に制限
  - expired tokenを削除後、tokenを持たない90日超のclient recordを自動削除
  - block時はHTTP 429と`Retry-After`を返却
- 主な設定:
  - `DEVSPACE_OAUTH_AUTH_FAILURE_LIMIT`
  - `DEVSPACE_OAUTH_AUTH_FAILURE_WINDOW_SECONDS`
  - `DEVSPACE_OAUTH_AUTH_BLOCK_SECONDS`
  - `DEVSPACE_OAUTH_AUTH_FAILURE_DELAY_MS`
  - `DEVSPACE_OAUTH_MAX_REGISTERED_CLIENTS`
  - `DEVSPACE_OAUTH_INACTIVE_CLIENT_MAX_AGE_DAYS`

### P2-3: OAuth redirect scheme制限

- 状態: **完了（2026-07-11）**
- commit: `8504e71 fix harden oauth authorization and redirects`
- 実施内容:
  - allowlistされた外部hostはHTTPSのみ許可
  - localhost、127.0.0.1、::1はHTTP/HTTPSを許可
  - redirect URIのuserinfoとfragmentを拒否
  - hostnameだけでなくschemeを含む回帰テストを追加

### P2-4: MCP transport/session cleanup

- 状態: **完了（2026-07-11）**
- commit: `5654110 fix bound transport and workspace session lifetime`
- 実施内容:
  - MCP transportを既定最大32件に制限
  - transportを既定1時間idleでclose・削除
  - 最大数到達時は最も古いtransportをcloseして入れ替え
  - server shutdown時に全transportをclose
  - SQLiteのworkspace session recordを既定30日で起動時整理
- 主な設定:
  - `DEVSPACE_MCP_MAX_TRANSPORTS`
  - `DEVSPACE_MCP_TRANSPORT_IDLE_SECONDS`
  - `DEVSPACE_WORKSPACE_SESSION_MAX_AGE_DAYS`

### P2-5: review refs cleanup

- 状態: **完了（2026-07-11）**
- commit: `3ceedf7 fix prune stale review refs`
- 対象: `refs/devspace/review/*`
- 実施内容:
  - workspace review checkpoint初期化時に古いrefを走査
  - 既定7日を超えたreview refを削除
  - 現在のworkspace用open/baseline refはその後に再作成
  - cleanup回帰テストを追加

### P2-6: version source of truth統一

- 状態: **完了（2026-07-11）**
- commit: `859a377 fix unify runtime version metadata`
- 実施内容:
  - `package.json`をversionとNode対応範囲の正本に統一
  - MCP server metadataはpackage versionを使用
  - CLI version、起動表示、doctorは同じpackage情報を使用
  - doctorで`Node v24.16.0 (supported >=22.19 <27)`を確認

### P2-7: expected HTTP probeのログ分類

- 状態: **完了（2026-07-11）**
- commit: `8e26e7f fix classify expected http probes`
- 実施内容:
  - unauthenticated `/mcp`の401/403を`auth`へ分類
  - `/.well-known/*`の404を`probe`へ分類
  - その他の4xx/5xxは`error`を維持
  - compact consoleでは`AUTH`、`PROBE`、`HTTP`を表示
  - auth/probeを赤い`failed`表示にしない

### P2-8: ユーザー向け表示名をWorkbridgeへ統一

- 状態: **保留（ユーザー指定）**
- 目的: 互換識別子を壊さず、ユーザーから見える旧名称`DevSpace`を`Workbridge`へ整理する
- 変更候補:
  - MCP server title・instructions・tool/card description
  - OAuth認証画面のtitle、heading、button、resource表示
  - workspace diff UIのHTML title
  - CLI setup、doctor、起動メッセージ、エラー説明の製品名
  - local agent連携へ渡すclient表示名
  - 起動ログなどの表示用名称
- 原則維持する互換識別子:
  - npm package `@waishnav/devspace`
  - CLI command `devspace`
  - `DEVSPACE_*`環境変数
  - `.devspace/`、`~/.devspace/`
  - OAuth scope `devspace`
  - DB名・migration table・既存Git ref prefix
  - runtime metadataの`legacyName: "DevSpace"`
- 別途判断する範囲:
  - upstreamとの差分が大きくなるREADME、AGENTS.md、docs全体の全面置換
  - TypeScript内部関数名・型名・ファイル名
- 完了条件:
  - 通常利用時に表示される製品名がWorkbridgeへ統一される
  - 既存CLI、設定、OAuth、DB、保存済みstateとの互換性が維持される
  - 互換識別子を意図せずrenameしていないことを回帰テストで確認する

## 8. P3タスク

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

- 状態: **完了（2026-07-11）**
- commit: `c312541 chore tune lazy chunk warning threshold`
- 調査結果:
  - 大きいchunkはPierre diffの言語grammar・WASMで、既にdynamic importによる遅延読込
  - 初期workspace app chunkは約349KB、最大の遅延chunkは約780KB
- 実施内容:
  - 実態に合わない既定500KB警告を800KBへ調整
  - 将来800KBを超えた場合の警告は維持
  - buildで従来のchunk-size警告が出ないことを確認

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
| `3983266` | 完了 | workspaceId再利用誘導 |
| `1753312` | 完了 | workspace task dryRunパス秘匿 |
| `74042aa` | 完了 | workspace task stdout/stderr返却抑制 |
| `bef5aa8` | 完了 | open_workspace root/path秘匿 |
| `5bc515a` | 完了 | exec_command/bash出力パス秘匿 |
| `6121483` | 完了 | 初版レビューaction plan作成 |
| `6ccefbf` | 完了 | rebase後のupstream/main base |
| `e187b68` | 完了 | 一般file tool realpath境界修正 |
| `f3b1ba1` | 完了 | shell command logging policy修正 |
| `a835ac0` | 完了 | レビュータスク台帳の詳細化 |
| `1827a7a` | 完了 | `.codex/`、`.devspace/`、`logs/`、`reports/`をignore |
| `fef86c3` | 完了 | 応答パスsanitization一元化 |
| `595beb7` | 完了 | 子プロセス環境変数最小化 |
| `bed5536` | 完了 | workspace task template-only既定化 |
| `b121722` | 完了 | status-only outputの内部buffer抑制 |
| `8504e71` | 完了 | OAuth rate limit・redirect・client上限 |
| `5654110` | 完了 | transport・workspace session lifecycle制限 |
| `3ceedf7` | 完了 | stale review ref cleanup |
| `859a377` | 完了 | version・Node rangeの正本統一 |
| `8e26e7f` | 完了 | HTTP auth/probe分類 |
| `c312541` | 完了 | lazy chunk警告閾値調整 |
| `6f9c4b7` | 完了 | inactive OAuth client cleanup |

## 12. 現在のGit状態

2026-07-11のP2-1〜P2-7・P3-4実装完了時点:

```text
branch: feature/workbridge-stable-surface
remote tracking: origin/feature/workbridge-stable-surface
ahead: 8 commits（本書更新commit前）
tracked changes: none
untracked: none
```

`.codex/`、`.devspace/`、`logs/`、`reports/`は`.gitignore`登録済み。本書更新commit後はahead数が1増える。今回のP2/P3変更はまだpushしていない。

## 13. 今後の実行順

1. P3-1 `src/server.ts`分割
2. P3-2 lint導入
3. P3-3 coverage・security/integration test分類
4. P2-8 ユーザー向け表示名のWorkbridge統一（ユーザーが再開を指示した場合のみ）

各タスク着手時は、本書の状態を「作業中」へ変更し、完了後に以下を追記する。

- 実装概要
- 対象ファイル
- 追加テスト
- 検証結果
- commit hash
- 残課題
