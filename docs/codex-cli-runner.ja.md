# Codex CLI Runner MCP Tool（日本語版）

> English: [codex-cli-runner.md](./codex-cli-runner.md)
>
> この日本語版は `codex-cli-runner.md` の翻訳です。英語版と日本語版に差分がある場合は、英語版を正とします。

Workbridge は `run_codex_cli` という、ChatGPT から利用するための MCP ツールを公開します。
このツールは、次のローカル Python ラッパーを呼び出します。

```text
C:\path\to\your\workspace\labs\codex_cli_runner\run_codex.py
```

これは意図的に **Codex Skill ではありません**。
Workbridge MCP ツールとして登録されているため、この Workbridge サーバーに接続している ChatGPT クライアントから見えるようになります。

Codex からも Codex Skill として発見させたい場合を除き、このワークフローを `.agents/skills` や `$HOME/.agents/skills` 配下には置かないでください。

## ツール名

```text
run_codex_cli
```

## 入力

- `projectDir`: Codex CLI の対象プロジェクトディレクトリ。Workbridge の allowed roots 配下である必要があります。
- `instructionFile`: Markdown の指示ファイル。絶対パスまたは相対パスを指定できます。
- `sandbox`: 任意。`read-only` または `workspace-write`。デフォルトは `read-only` です。
- `mode`: 任意。`sync` または `detached`。デフォルトは `sync` です。
- `model`: 任意。Python runnerへ渡すCodex modelです。デフォルトは `gpt-5.5` です。
- `serviceTier`: 任意。`standard` または `fast`。デフォルトは `standard` です。
- `reasoningEffort`: 任意。`minimal`、`low`、`medium`、`high`、`xhigh`。デフォルトは `xhigh` です。
- `dryRun`: 任意。`true` の場合、Codex を実行せず、検証と実行予定コマンドの表示だけを行います。`detached` mode でもコンソールは開きません。
- `json`: 任意。`true` の場合、Python runner に `--json` を渡します。
- `timeout`: 任意。`sync` mode 用の秒数指定。デフォルトは 900 秒、最大 3600 秒です。
- `earlyWaitSeconds`: 任意。`detached` mode の早期監視秒数です。デフォルトは `DEVSPACE_CODEX_EARLY_WAIT_SECONDS` または 10 秒、最大 300 秒です。
- `maxOutputCharacters`: 任意。MCP 応答として返す stdout / stderr の最大文字数です。
- `maxFallbackPromptCharacters`: 任意。Codex が limit 系エラーで失敗した場合に `fallbackPrompt` として返す指示 Markdown の最大文字数です。デフォルトは 120000 文字です。

`danger-full-access` は意図的にサポートしていません。

Workbridge はデフォルトで、次のオプションをPython runnerへ渡します。

```text
--model gpt-5.5
--service-tier standard
--reasoning-effort xhigh
```

Python runner はそれをCodex CLI向けに次のオプションへ変換します。

```text
--model gpt-5.5
-c service_tier="standard"
-c features.fast_mode=false
-c model_reasoning_effort="xhigh"
```

## 実行モード

### `sync`

`sync` mode は、Python wrapper の完了まで待ちます。最終的なプロセス結果に応じて、`completed`、`failed`、`limit_error`、`timeout`、`launch_error` を返します。

### `detached`

`detached` mode は、次の配下に job ディレクトリを作成します。

```text
<ProjectDir>\.codex\runs\devspace_codex_<jobId>\
```

その後、別のローカルコンソールを開いて、そこで Codex を実行します。MCP 呼び出し側は、早期監視時間だけ待ちます。

`detached` process は次のファイルを書き込みます。

- `status.json`
- `codex_combined.log`
- `launch-codex.ps1` または `launch-codex.sh`

Windowsでは、launcher は `status.json` と `codex_combined.log` を UTF-8 BOMなしで書き込みます。読み取り側も UTF-8 BOM付きおよび UTF-16LE のログを許容するため、PowerShell のencoding挙動によって早期Codexエラーを見落としにくくしています。

`earlyWaitSeconds` が経過するまでに早期エラーが検出されなかった場合、このツールは次を返します。

```text
status=started_running
```

これは、Codex が起動済みで、別コンソール上でまだ実行中の可能性がある、という意味です。Codex が正常完了したという意味ではありません。

早期監視中に limit 系エラーが検出された場合は、`status=limit_error`、`errorKind=codex_limit`、`fallbackPrompt` を返します。detached の `status.json` が `failed` を示す場合、ログがlimit系なら `limit_error`、それ以外なら `early_error` を返します。既知の失敗後に `started_running` は返さない設計です。

## 指示ファイルのパス解決

`instructionFile` が相対パスの場合、次の順で解決します。

1. `projectDir`
2. Workbridge サーバーの作業ディレクトリ
3. `run_codex.py` の配置ディレクトリ

解決された指示ファイルは、次の条件を満たす必要があります。

- 存在すること
- Workbridge allowed roots 配下にあること
- 拡張子が `.md` であること

## Runner パスの解決

デフォルトでは、このツールは Python runner を次の場所から探します。

```text
<Workbridge server cwd>\labs\codex_cli_runner\run_codex.py
<Workbridge server cwd>\..\..\labs\codex_cli_runner\run_codex.py
```

パスを明示的に上書きしたい場合は、次の環境変数を使えます。

```text
DEVSPACE_CODEX_CLI_RUNNER=C:\path\to\your\workspace\labs\codex_cli_runner\run_codex.py
```

解決された runner は、存在しており、Workbridge allowed roots 配下にある必要があります。

## Python コマンド

デフォルトの Python コマンドは次です。

```text
python
```

上書きしたい場合は、次の環境変数を使えます。

```text
DEVSPACE_PYTHON_COMMAND=python
```

## 最初に推奨する呼び出し

まずは dry-run を使ってください。

```json
{
  "projectDir": "C:\\path\\to\\your\\workspace\\your-project",
  "instructionFile": "tasks\\periodic_review.md",
  "sandbox": "read-only",
  "mode": "detached",
  "dryRun": true
}
```

表示されたコマンドが正しいことを確認してから、`dryRun` なしで実行してください。

## 出力

このツールは次の情報を返します。

- `status`
- `exitCode`
- `timedOut`
- `errorKind`
- `nextAction`
- `fallbackRecommended`
- `fallbackPrompt`
- `fallbackPromptSource`
- `fallbackPromptTruncated`
- `projectDir`
- `instructionFile`
- `runnerPath`
- `sandbox`
- `mode`
- `model`
- `serviceTier`
- `reasoningEffort`
- `dryRun`
- `jobId`
- `earlyWaitSeconds`
- `outputFile`
- `logFile`
- `instructionCopyFile`
- `statusFile`
- `combinedLogFile`
- `launcherFile`
- `stdout`
- `stderr`
- `command`
- `launchCommand`

内部で呼び出される Python runner は、Codex の実行結果を次の場所に保存します。

```text
<ProjectDir>\.codex\runs\
```

`detached` mode では、追加で `devspace_codex_<jobId>` run ディレクトリ配下に Workbridge job ファイルを書き込みます。

## limit fallback の挙動

Codex が limit 系エラーで失敗した場合、このツールは次の値を返します。

```text
status=limit_error
errorKind=codex_limit
nextAction=continue_in_chatgpt
fallbackRecommended=true
```

この場合、解決済みの `instructionFile` の内容を `fallbackPrompt` として返します。
ChatGPT はこの Markdown 指示を使って、同じ作業を続行できます。

`nextAction=continue_in_chatgpt` の場合、MCP クライアントは Codex の limit を報告するだけ、または後で再実行するよう案内するだけで終了しないでください。ユーザーが明示的に継続しないよう指定していない限り、`fallbackPrompt` を使って同じ作業を ChatGPT で継続します。

この fallback は limit 系エラーの場合だけ推奨されます。
検証エラー、Python 起動失敗、一般的な Codex 失敗、timeout では、デフォルトでは fallback prompt を返しません。

## デプロイ時の注意

Workbridge のソースを変更した後は、ローカルの Workbridge サーバーを rebuild して再起動してください。

既存の ChatGPT MCP 接続では、新しいツールが表示されるまで再接続が必要になる場合があります。
