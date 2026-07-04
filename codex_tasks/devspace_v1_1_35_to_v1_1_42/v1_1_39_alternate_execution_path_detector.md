# Codex Task: DevSpace v1.1.39 Alternate Execution Path Detector

## 共通最重要方針: 回避ではなく効率化

目的は分割やリファクタを避けることではなく、main pathだけでなくfallback / CLI / popup / daemon / batch / test pathを早期に検出し、手戻りを減らすこと。

## Codex推論レベル

高

## 背景

分割・リファクタ時の問題は、メイン経路だけ修正してfallback、manual injection、CLI、popup、daemon、batch、test pathを見落とすことにある。これは特定PJTの問題ではなく、全PJT共通のrefactor効率化課題である。

## 目的

リファクタや大きな編集前に、alternate execution path候補を検出・列挙する共通ロジックとdocsを作る。

## 実装範囲

1. `src/alternate-path-detector.ts` などのhelperを新規作成する、またはclassifierに組み込む。
2. ファイル内容やpath名からalternate path候補を分類する。
3. Router `verify_plan` またはclassifierが、large_edit_refactor時にalternate path確認をrecommendedSequenceへ含める。
4. testを追加する。
5. docsに共通チェック観点を追加する。
6. versionを `1.1.39` に更新する。

## 検出カテゴリ例

```text
main_entry
fallback_entry
manual_injection
cli_entry
batch_or_script_entry
daemon_or_runtime_entry
popup_or_ui_entry
config_entry
test_entry
generated_artifact_entry
```

## 出力例

```ts
{
  path: "popup.js",
  categories: ["popup_or_ui_entry", "manual_injection"],
  reviewHint: "Check alternate injection/load path after module split."
}
```

reviewHintはPJT固有名称ではなく一般化すること。

## 実装手順

1. v1.1.35の作業分類を確認する。
2. alternate pathカテゴリ型を定義する。
3. path/content heuristicsを小さく実装する。
4. test fixtureで複数pathを分類する。
5. classifierまたはrouterへの連携を最小実装する。
6. docsを更新する。
7. `npx tsc -p tsconfig.json --noEmit` を実行する。
8. 対象test、npm test、buildを実行する。
9. commitする。

## レビュー観点

- 特定PJT名に依存していないか。
- fallback/manual/CLI/runtimeなどの一般カテゴリになっているか。
- 大きなrefactor前の効率化に使えるか。
- 誤検出があっても安全側かつ出力過多になりすぎないか。
- Routerの出力が巨大にならないか。

## 移行条件

次の条件を満たしたら v1.1.40 へ進む。

- alternate path detectorのtestがある。
- large_edit_refactor時にrecommendedSequenceへalternate path確認が入る。
- docsで共通カテゴリが説明されている。
- npm testが通る。
- git statusがclean。

## 後続タスク見直し条件

検出カテゴリ名が変わった場合、v1.1.40〜v1.1.42のタスクmd内のカテゴリ名を更新すること。
