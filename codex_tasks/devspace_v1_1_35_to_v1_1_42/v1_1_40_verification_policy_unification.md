# Codex Task: DevSpace v1.1.40 Verification Policy Unification

## 共通最重要方針: 回避ではなく効率化

目的は検証を増やすことではなく、作業分類に応じて最短で十分な検証profileを提案し、無駄なbashや過剰なfull testを減らすこと。

## Codex推論レベル

高

## 背景

`devspace_verify` と Router v1 `verify_plan` はあるが、作業分類ごとの共通検証policyはまだ十分に統一されていない。ここでは検証導線を全PJT共通の効率化ロジックとして整える。

## 目的

作業分類ごとのverification profile policyを統一し、classifier/router/Skill/docsに反映する。

## 実装範囲

1. `src/verification-policy.ts` などのhelperを作る、または既存 `buildVerifyPlan` を拡張する。
2. taskClassごとのprofile候補を定義する。
3. Router `verify_plan` がtaskClassやclassifier結果を使えるようにする。
4. testを追加する。
5. docsとSkillを更新する。
6. versionを `1.1.40` に更新する。

## 共通profile案

```text
read_inspect:
  git_status_check

small_edit:
  git_status_check
  git_diff_check
  targeted related test if known

large_edit_refactor:
  git_status_check
  git_diff_check
  typecheck_only
  related_tests
  npm_test
  build if package/build path changed

validation_test:
  git_status_check
  requested fixed verify profile

structured_sensitive_integration:
  git_status_check
  git_diff_check
  typecheck_only
  mock test
  no live smoke by default

packaging_release:
  git_status_check
  git_diff_check
  npm_test
  build
```

## 非目的

- すべての作業で常に `npm test` と `build` を走らせることではない。
- 任意test commandを自由入力させることではない。
- live API smokeを標準検証に含めることではない。

## 実装手順

1. v1.1.36 classifierとv1.1.38 sensitive schemaを確認する。
2. verification policy helperを実装する。
3. `buildVerifyPlan` の重複があればhelperへ寄せる。
4. testを追加する。
5. docs/Skillを更新する。
6. `npx tsc -p tsconfig.json --noEmit` を実行する。
7. `npx tsx src/workflow-tools.test.ts` と関連testを実行する。
8. `npm test` とbuildを実行する。
9. commitする。

## レビュー観点

- 作業分類ごとの最小十分な検証になっているか。
- 過剰検証で効率を落としていないか。
- fixed profileのみを提案しているか。
- live external side effectを標準検証に含めていないか。
- Routerの出力が一気通貫で次操作につながるか。

## 移行条件

次の条件を満たしたら v1.1.41 へ進む。

- verification policy helperまたは同等の統一ロジックがある。
- taskClassごとのprofile testがある。
- Router verify_planが新policyを使うか、docs上で明確に接続されている。
- npm testが通る。
- git statusがclean。

## 後続タスク見直し条件

verification profileの並びやpolicy名が変わった場合、v1.1.41とv1.1.42のログ分類・metrics名を更新すること。
