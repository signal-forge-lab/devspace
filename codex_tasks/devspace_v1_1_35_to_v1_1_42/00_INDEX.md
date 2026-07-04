# DevSpace v1.1.35〜v1.1.42 Codex Task Index

## 共通最重要方針: 回避ではなく効率化

このタスク群の目的は、DevSpace作業を「避ける」「止める」「個別注意を増やす」方向に寄せることではない。目的は、失敗・ブロック・非効率な往復を材料にして、DevSpace側の入力形式、構造化tool、検証導線、ログ分析を改善し、同じ作業をより速く、確実に、一気通貫で進められるようにすることである。

- 危険そうな単語を避けることを目的にしない。
- API key / token / Authorization / webhook / secret などの語が出ても、実secret値と変数名・設定キー名・コード上の参照を構造的に区別する。
- ブロックやエラーを「作業中止の理由」ではなく、「より効率的なDevSpace経路を作るための改善入力」として扱う。
- base64等のencodingは、フィルタ回避ではなく、特殊文字・大きなpatch・テンプレート文字列を壊さず搬送するためのtyped transportとしてのみ検討する。
- PJT別の独自ルールを増やさず、作業分類・危険分類・編集方式・検証方式・停止判断を全PJT共通ルールへ抽象化する。

## 実装前に必ず読む資料

- `01_INPUT_CONTEXT.md`

## 今後の対応候補

- `02_FUTURE_CANDIDATES.md`

## 作成対象タスク

1. `v1_1_35_unified_operating_policy.md`
2. `v1_1_36_unified_risk_efficiency_classifier.md`
3. `v1_1_37_structured_edit_transport.md`
4. `v1_1_38_structured_sensitive_integration_workflow.md`
5. `v1_1_39_alternate_execution_path_detector.md`
6. `v1_1_40_verification_policy_unification.md`
7. `v1_1_41_incident_to_improvement_loop.md`
8. `v1_1_42_efficiency_metrics_log_report.md`

## ループ実行方針

各タスクは以下の順で進める。

1. `git status --short` を確認する。
2. タスク本文の実装範囲に限定して変更する。
3. タスク本文のレビュー観点で自己レビューする。
4. テスト、build、diff checkを実行する。
5. 結果により、後続タスクの前提が変わる場合は後続タスクmdを更新する。
6. 問題がなければcommitする。
7. 次タスクの移行条件を満たしてから次へ進む。

## 共通テスト候補

```text
npx tsc -p tsconfig.json --noEmit
npx tsx src/operation-router.test.ts
npx tsx src/workflow-tools.test.ts
npx tsx src/workbridge-verify.test.ts
npx tsx src/log-analysis.test.ts
npx tsx src/startup-smoke.test.ts
npm test
npm run build
git diff --check
npm run smoke:startup
npm run logs:report
```

## 共通レビュー観点

- 「避ける」「禁止する」だけの表現になっていないか。
- 同じ目的をより効率的に達成するDevSpace側の処理改善になっているか。
- PJT別ルールを増やしていないか。
- 実secret値とenv var名・config key名・コード上の参照を区別できているか。
- 任意bashへの拡大ではなく、typed schema / fixed profile / structured edit に寄せられているか。
- エラー発生時に、次回以降の効率改善に変換できるログ・分類・提案が残るか。

## 後続タスク見直しルール

あるタスクの結果で、後続タスクの前提・名称・実装方針・schemaが変わった場合は、次のどちらかを行う。

1. 影響が軽微なら、該当する後続タスクmdをその場で更新してからcommitする。
2. 影響が大きいなら、新規タスク `v1_1_xx_adjust_roadmap_after_<task>.md` を同フォルダに追加し、Indexも更新する。

## v1.2.0 到達条件

- 作業分類と効率化方針が統一文書にある。
- Routerまたは分類器が、作業目的に応じた効率的なtool sequenceを提案できる。
- 大きな編集・特殊文字・API/env参照が、bash一括編集ではなく構造化経路に寄っている。
- devspace_verify / verify_plan / logs:report が、作業後の検証導線として自然に使える。
- エラーやブロックが、単なる停止理由ではなく、効率改善候補として分類・記録・レビューできる。
