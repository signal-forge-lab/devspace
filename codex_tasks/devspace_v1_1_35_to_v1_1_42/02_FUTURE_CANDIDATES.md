# DevSpace Future Candidates

## 目的

この資料は、v1.1.35〜v1.1.42の本線タスクにはまだ入れないが、今後のDevSpace改善候補として保持する項目をまとめる。ここに記載する候補も、共通方針である「回避ではなく効率化」に従う。

- 公開や外部接続を避けることが目的ではない。
- OAuth / Funnel / 外部MCP接続を、より安全かつ効率的に扱えるDevSpace側の構造を作ることが目的である。
- 個別PJTルールではなく、公開MCP endpointを扱う全体統一の設計候補として扱う。

## Candidate A: OAuth Static Client Registry

### 背景

ChatGPT ConnectorやClaude CodeからDevSpace MCPへ接続する場合、Dynamic Client Registrationが使えない、または失敗するケースがある。この場合、接続元ごとのOAuth client_idとredirect_uri allowlistをDevSpace側で明示的に管理できる必要がある。

### 目的

MCP接続元を自由文字列ではなく、DevSpace側の登録済みclientとして扱い、redirect_uri、client type、token TTL、scopeを制御する。

### 候補機能

```text
- oauthClients config
- clientId
- displayName
- redirectUris allowlist
- publicClient / confidentialClient
- tokenTtlSeconds
- allowedScopes
- disabled flag
```

### 例

```json
{
  "oauthClients": [
    {
      "clientId": "chatgpt-devspace-iw",
      "displayName": "ChatGPT DevSpace IW Connector",
      "redirectUris": ["<ChatGPT connector callback URI>"],
      "publicClient": true,
      "allowedScopes": ["mcp:read", "mcp:verify", "mcp:structured_edit"],
      "tokenTtlSeconds": 3600
    },
    {
      "clientId": "claude-code-devspace-iw",
      "displayName": "Claude Code DevSpace IW",
      "redirectUris": ["http://localhost:8080/callback"],
      "publicClient": true,
      "allowedScopes": ["mcp:read", "mcp:verify", "mcp:structured_edit"],
      "tokenTtlSeconds": 3600
    }
  ]
}
```

### レビュー観点

- Dynamic Client Registration失敗時の実用的な代替になっているか。
- client_idをただ受け入れるだけでなく、redirect_uri allowlistがあるか。
- client secretやtokenをログに出さないか。
- ChatGPT / Claude Codeのような接続元を、PJT別ではなくOAuth client種別として扱えているか。

## Candidate B: MCP Scope / Tool Permission Profiles

### 背景

OAuth認証済みでも、すべてのMCP toolを同じ権限で使える状態は強すぎる。特にFunnel経由では、bash、commit、runtime起動、外部通知、delete系操作を高権限として扱うべきである。

### 目的

MCP toolをscope/profileで分類し、接続元clientやtokenに応じて使えるtoolを制御する。

### 候補scope

```text
mcp:read
mcp:inspect
mcp:verify
mcp:structured_edit:dry_run
mcp:structured_edit:apply
mcp:commit
mcp:bash
mcp:runtime
mcp:external_side_effect
```

### 初期方針

```text
ChatGPT Connector default:
  read / inspect / verify / structured_edit:dry_run

Claude Code default:
  read / inspect / verify / structured_edit:dry_run

write-enabled session:
  structured_edit:apply / commit を明示的に追加

high-risk session:
  bash / runtime / external_side_effect は別scopeにする
```

### レビュー観点

- bashを禁止することが目的になっていないか。
- bashが必要なケースを、より効率的なfixed profileやstructured toolへ寄せる導線があるか。
- scope不足時のエラーが、必要scopeと代替toolを提示するか。

## Candidate C: Tailscale Funnel Exposure Hardening

### 背景

Tailscale FunnelはDevSpace MCPを公開インターネットから到達可能にする。MCPがOAuth必須でも、公開面が増えるため、DevSpace側で公開状態を検出し、設定・ログ・rate limit・body size limitを強化したい。

### 目的

Funnel公開を避けるのではなく、公開時にDevSpaceが自己診断し、必要な制限と監査を有効化できるようにする。

### 候補機能

```text
- publicBaseUrlがhttps://*.ts.net の場合に exposureMode=funnel を推定
- bind address check: 127.0.0.1推奨、0.0.0.0ならwarning
- request body size limit
- OAuth authorize/token endpoint rate limit
- MCP endpoint rate limit
- failed auth audit
- tool call audit
- token issue / revoke audit
- Authorization / token / client secret redaction
- funnel status check helper or docs
```

### 追加候補

```text
- startup smokeにpublic exposure warningを追加
- logs:reportにexposure/security sectionを追加
- devspace_routerでexposure hardening checkを提案
- devspace_verify profileにexposure_config_checkを追加
```

### レビュー観点

- Funnel利用を禁止する方向になっていないか。
- 公開時に必要な制限をDevSpace側で自動確認できるか。
- OAuthだけに依存せず、tool permission / rate limit / audit / redactionまで含めているか。
- logにsecretやtokenが出ないか。

## Candidate D: Public MCP Endpoint Readiness Check

### 背景

ChatGPT ConnectorやClaude Codeから使う前に、DevSpaceが公開MCP endpointとして準備できているかを一括確認したい。

### 目的

公開前チェックを手作業ではなく、fixed verify profileまたはstartup smokeとして実行できるようにする。

### チェック候補

```text
- OAuth enabled
- registered OAuth clients exist
- redirect URI allowlist configured
- token TTL configured
- tool permission profiles configured
- bind address is localhost or explicitly accepted
- publicBaseUrl set
- request body limit set
- rate limit configured
- log redaction enabled
- high-risk tools require explicit scope
```

### 出力例

```text
public_mcp_readiness: needs_review
- oauth client registry is missing
- redirect URI allowlist is missing
- high-risk tool scope is not separated
- bind address is localhost: ok
```

## 優先度案

v1.1.35〜v1.1.42完了後、またはOAuth/Claude Code接続を先に安定させたい場合に以下の順で検討する。

```text
1. OAuth Static Client Registry
2. Public MCP Endpoint Readiness Check
3. MCP Scope / Tool Permission Profiles
4. Tailscale Funnel Exposure Hardening
```

ただし、Funnel経由の常用を始める前には、1〜3を先に入れることを推奨する。

## v1.1.35〜v1.1.42との関係

この資料の候補は、v1.1.35〜v1.1.42の統一効率化基盤の上に載せる。

```text
v1.1.35 Operating Policy:
  public MCP endpointをruntime_external_side_effect / structured_sensitive_integrationに分類する

v1.1.36 Classifier:
  publicBaseUrlやOAuth client設定から公開接続作業を分類する

v1.1.38 Sensitive Integration:
  OAuth client_id / redirect_uri / token TTLをtyped configとして扱う

v1.1.40 Verification Policy:
  public_mcp_readiness_checkをfixed verify候補にする

v1.1.41 Incident Loop:
  OAuth registration failureやredirect mismatchをimprovement actionへ変換する

v1.1.42 Metrics:
  failed auth / rate limit / high-risk tool usageを可視化する
```
