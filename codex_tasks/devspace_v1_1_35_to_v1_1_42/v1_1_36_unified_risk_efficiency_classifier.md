# Codex Task: DevSpace v1.1.36 Unified Risk / Efficiency Classifier

## 共通最重要方針: 回避ではなく効率化

目的は、危険度を理由に作業を止めることではなく、作業目的を達成するための最短で成功しやすいDevSpace tool sequenceを返すこと。

## Codex推論レベル

高

## 背景

既存の `operation-router.ts` は操作リスクと推奨toolを返せるが、今後は「危険度」だけでなく「効率的に成功するためのtool sequence」を返す必要がある。目的はリスク回避ではなく、作業目的に応じた最短・安全・再現可能なDevSpace経路を提案することである。

## 目的

全PJT共通の作業分類と効率化判断を行う classifier を実装し、Router/Skill/Docsから利用できる基礎を作る。

## 実装範囲

1. 既存の `src/operation-router.ts` を拡張する、または `src/devspace-efficiency-classifier.ts` を新規作成する。
2. taskClass、risk、efficiencyGoal、recommendedSequence、requiredChecks、transportRecommendationを返す。
3. `src/operation-router.test.ts` または新規testに分類テストを追加する。
4. `docs/devspace-operating-policy.md` にclassifierの出力例を追記する。
5. versionを `1.1.36` に更新する。

## 出力例

```ts
{
  taskClass: "structured_sensitive_integration",
  risk: "high",
  efficiencyGoal: "separate_secret_reference_from_secret_value_and_generate_config_mock_first",
  recommendedSequence: [
    "classify",
    "structured_env_reference_patch",
    "mock_test",
    "devspace_verify:typecheck_only",
    "devspace_verify:git_diff_check"
  ],
  blockedPattern: "live_secret_value_or_live_api_call_in_first_step",
  improvementHint: "use typed env var reference rather than free-form source insertion"
}
```

## 分類対象

```text
read_inspect
small_edit
large_edit_refactor
validation_test
structured_sensitive_integration
runtime_external_side_effect
packaging_release
incident_recovery
```

## 効率化観点

- 危険語の有無だけで判定しない。
- 実secret値とenv var名・設定キー名を区別する。
- bashの禁止ではなく、より効率的なtyped operationへ誘導する。
- 大きな編集はstructured edit transportへ誘導する。
- validationはdevspace_verify profileへ誘導する。

## 実装手順

1. v1.1.35のpolicyを確認する。
2. classifierの型を定義する。
3. 既存 `routeSafeOperation` と重複しすぎる場合は、後方互換を維持して拡張する。
4. testを追加する。
5. docsに出力例を追記する。
6. `npx tsc -p tsconfig.json --noEmit` を実行する。
7. 対象testと `npm test` を実行する。
8. `git diff --check` を実行する。
9. commitする。

## レビュー観点

- classifierが単に「禁止」を返していないか。
- recommendedSequenceが具体的で、Codexが次操作へ進めるか。
- sensitive語をenv var名として扱うケースを不当にブロックしていないか。
- 任意bash実行の推奨になっていないか。
- 既存 `operation-router.test.ts` を壊していないか。

## 移行条件

次の条件を満たしたら v1.1.37 へ進む。

- classifierが作業分類を返す。
- efficiencyGoal / recommendedSequence が返る。
- structured_sensitive_integration のenv var参照ケースがtestされている。
- npm testが通る。
- git statusがclean。

## 後続タスク見直し条件

classifierの出力schemaが当初案と変わった場合、v1.1.37〜v1.1.42のタスクmdで参照しているfield名を更新すること。
