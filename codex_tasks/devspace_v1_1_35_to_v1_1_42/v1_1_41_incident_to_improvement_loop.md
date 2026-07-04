# Codex Task: DevSpace v1.1.41 Incident-to-Improvement Loop

## 共通最重要方針: 回避ではなく効率化

目的はエラーの回避ではなく、incidentを分類し、次回の効率改善提案へ変換すること。停止は作業放棄ではなく、非効率な経路を打ち切ってより良い経路を作る切替点として扱う。

## Codex推論レベル

高

## 背景

安全ブロック、schema validation error、spawn error、quoting error、UnicodeEncodeErrorなどは、単なる停止理由ではなく、DevSpace側の入力形式・編集方式・検証方式を改善する材料である。

## 目的

incident分類とimprovement suggestionを共通化し、ログ・Router・docsで使える形にする。

## 実装範囲

1. `src/incident-classifier.ts` などを新規作成する、またはlog analyzerのfailure classificationを抽出する。
2. incident categoryとimprovement actionを定義する。
3. log analyzerのfailureCategoriesと整合させる。
4. testを追加する。
5. docsに「2回ブロックで停止」は目的ではなく非効率経路打ち切りルールであることを明記する。
6. versionを `1.1.41` に更新する。

## incident category案

```text
schema_validation
spawn_process_start
heredoc_or_quoting_syntax
unicode_console_output
line_range_or_locator_miss
safety_filter_block
oversized_output
unexpected_dirty_worktree
alternate_path_miss
live_side_effect_attempt
```

## improvement action案

```text
switch_to_structured_schema
use_fixed_profile_shell_wrapper
use_structured_edit_transport
set_utf8_or_escape_output
resolve_locator_before_edit
split_sensitive_reference_from_secret_value
use_bounded_report_or_tail
inspect_status_and_scope_commit
run_alternate_execution_path_detector
require_explicit_live_smoke_flag
```

## 実装手順

1. 既存 `scripts/analyze-devspace-logs.mjs` の `categorizeFailure` を確認する。
2. 共通incident分類を切り出すか、少なくとも同じカテゴリ名を使う。
3. testを追加する。
4. log analyzerがimprovement hintを出せるなら最小実装する。
5. docsを更新する。
6. `npx tsc -p tsconfig.json --noEmit` を実行する。
7. log-analysis test、npm test、buildを実行する。
8. commitする。

## レビュー観点

- incident分類が停止・禁止で終わっていないか。
- improvement actionが次回の効率化に直結しているか。
- safety_filter_blockを「回避」ではなく「typed schema / structured transportへの切替」にしているか。
- log analyzerとTS側分類の二重管理が増えすぎていないか。
- 出力が大きくなりすぎないか。

## 移行条件

次の条件を満たしたら v1.1.42 へ進む。

- incident categoryとimprovement actionが定義されている。
- 少なくとも3〜5種類のincident testがある。
- docsにincident-to-improvementの方針がある。
- npm testが通る。
- git statusがclean。

## 後続タスク見直し条件

incident category名が変わった場合、v1.1.42のmetrics名・log reportの表示項目を更新すること。
