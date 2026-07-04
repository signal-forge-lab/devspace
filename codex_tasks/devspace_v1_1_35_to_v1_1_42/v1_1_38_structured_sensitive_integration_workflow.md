# Codex Task: DevSpace v1.1.38 Structured Sensitive Integration Workflow

## 共通最重要方針: 回避ではなく効率化

目的はAPI/secret/webhook/token系作業を避けることではなく、実secret値とenv var名・config key名・コード上の参照を構造的に分離し、効率的にconfig/mock-firstで実装できる経路を作ること。

## Codex推論レベル

非常に高い

## 背景

API key / token / Authorization / webhook / secret などの語が出る作業では、実secret値ではなくenv var名や設定キー名を扱っているだけでも、自由文・bash・大きなコード断片として渡すと非効率やブロックを誘発する可能性がある。目的はこれらを避けることではなく、実secret値と参照名を構造的に分離し、config/mock-firstの効率的な実装経路を作ること。

## 目的

env var参照、config schema、mock-first test、live smoke明示フラグをtyped workflowとして扱える基礎を作る。

## 実装範囲

候補を既存設計に合わせて最小実装する。

1. `src/sensitive-integration.ts` などの新規helperを作る、またはclassifier内に最初の実装を置く。
2. `EnvVarReference` 型を定義する。
3. `secretValueHandling: "never_read_or_write" | "mock_only"` のような意図を表現する。
4. env var nameのvalidationを追加する。
5. 実secret値を受け取らない・ログに出さないtestを追加する。
6. config-only / mock-firstのrecommendedSequenceをclassifierまたはrouterに反映する。
7. docsに「env var名は扱うが、secret値は扱わない」標準を明記する。
8. versionを `1.1.38` に更新する。

## 入力モデル例

```ts
{
  provider: "openai",
  envVarName: "AEGIS_GATE_LLM_API_KEY",
  secretValueHandling: "never_read_or_write",
  mode: "config_and_mock_only"
}
```

これは例であり、実装schemaは既存構成に合わせること。

## 非目的

- 実API live callを自動実行しない。
- 実secret値を受け取らない。
- secret値をbase64化して渡す機能を作らない。
- OpenAI専用、Discord専用などPJT固有・サービス固有ルールにしない。

## 実装手順

1. v1.1.36 classifierとv1.1.37 transportの結果を確認する。
2. env var referenceの型とvalidationを実装する。
3. testを追加する。
4. classifierのstructured_sensitive_integration出力を必要に応じて更新する。
5. docsを更新する。
6. `npx tsc -p tsconfig.json --noEmit` を実行する。
7. 対象test、`npm test`、buildを実行する。
8. `git diff --check` を実行する。
9. commitする。

## レビュー観点

- 実secret値を扱う経路が混ざっていないか。
- env var名やconfig key名を不必要に避けていないか。
- API/secret系を「やらない」ではなく「構造化して効率よく進める」説明になっているか。
- live smokeが明示フラグなしに実行されないか。
- provider固有実装に寄りすぎていないか。

## 移行条件

次の条件を満たしたら v1.1.39 へ進む。

- env var referenceのvalidation/testがある。
- secret値を受け取らないことがtestまたはdocsで明確。
- classifier/routerがsensitive integrationの効率的sequenceを提案できる。
- npm testが通る。
- git statusがclean。

## 後続タスク見直し条件

このタスクでenv var reference schemaが確定したら、v1.1.40のVerification Policy、v1.1.41のIncident Loopにそのschema名を反映すること。
