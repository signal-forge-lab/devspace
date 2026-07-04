# Codex Task: DevSpace v1.1.42 Efficiency Metrics / Log Report Integration

## 共通最重要方針: 回避ではなく効率化

目的は主観的な反省ではなく、bash率、heredoc率、retry率、structured edit率、verify成功率、incident改善候補などをログから見える化し、次の効率化施策を判断できるようにすること。

## Codex推論レベル

高

## 背景

これまでのDevSpace利用効率レビューは主観的になりやすかった。今後は、どこで非効率が発生し、どのDevSpace機能に寄せれば効率化できるかをlog reportで確認できるようにする。

## 目的

`logs:report` とJSON summaryに、DevSpace効率化のための統一metricsを追加する。

## 実装範囲

1. `scripts/analyze-workbridge-logs.mjs` にefficiencyMetricsを追加する。
2. JSON出力、text出力、HTML出力に反映する。
3. `src/log-analysis.test.ts` にregression testを追加する。
4. docsを更新する。
5. versionを `1.1.42` に更新する。

## metric候補

```text
bashToolCalls
bashEditLikeCalls
heredocLikeCalls
listResourcesLikeEvents
structuredEditCalls
unifiedPatchCalls
workbridgeVerifyCalls
workbridgeVerifyFailureRate
routerCalls
routerVerifyPlanCalls
workflowEvents
incidentCount
incidentImprovementHintCount
oversizedOutputCount
truncatedOutputCount
retryAfterFailureCount
```

実際にログから取得できないものは無理に推測せず、`availableMetrics` / `unavailableMetrics` として分ける。

## HTML表示候補

- Efficiency Summary KPI
- Tooling mix table
- Incident improvement hints table
- Verify profile success/failure tableとの接続
- Workflow mode別比較の下地

## 非目的

- すべてのログを巨大HTMLに展開しない。
- 個別PJT名で分類しない。
- 主観的な点数だけを出さない。

## 実装手順

1. v1.1.41のincident categoryを確認する。
2. 既存log analyzerのsummary構造を確認する。
3. metricsを小さく追加する。
4. JSON testを追加する。
5. HTML sectionの存在assertionを追加する。
6. `node --check scripts/analyze-workbridge-logs.mjs` を実行する。
7. `npx tsx src/log-analysis.test.ts` を実行する。
8. `npm test` とbuildを実行する。
9. `npm run logs:report` を実行し、HTMLに新sectionが出ることを確認する。
10. commitする。

## レビュー観点

- metricsが効率化判断に使えるか。
- 回避・禁止の数を増やすだけの指標になっていないか。
- structured editやverify profileへの移行効果が見えるか。
- HTML detailsに表示漏れがないか。
- log reportが重くなりすぎていないか。

## 移行条件

次の条件を満たしたら v1.2.0計画へ進む。

- JSON/text/HTMLにefficiency metricsが出る。
- log-analysis testがある。
- npm testが通る。
- npm run logs:reportが通る。
- git statusがclean。

## v1.2.0準備タスク作成条件

v1.1.42完了後、以下のどれかが未達なら、v1.2.0へ直接進まず `v1_2_0_readiness_gap.md` を作成する。

- Unified Operating Policyが実装・Skill参照済み。
- Risk/Efficiency Classifierが実装済み。
- Structured Edit Transportが実装済み、または明確な見送り理由がある。
- Structured Sensitive Integration Workflowが実装済み、またはtyped schema案がdocs化されている。
- Verification PolicyがRouter/verifyに反映済み。
- Incident-to-Improvement分類がある。
- Efficiency Metricsがlogs:reportに出る。
