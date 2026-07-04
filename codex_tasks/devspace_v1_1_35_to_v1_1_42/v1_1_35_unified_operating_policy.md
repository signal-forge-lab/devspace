# Codex Task: DevSpace v1.1.35 Unified Operating Policy

## 共通最重要方針: 回避ではなく効率化

目的は、危険そうな作業を避けることではなく、DevSpace側の入力形式・構造化tool・検証導線を改善し、同じ目的をより速く確実に達成すること。PJT別ルールを増やさず、全PJT共通の作業分類へ抽象化する。

## Codex推論レベル

高

## 背景

最近の実行結果では、Aegis Gate、Arcaia、DevSpace本体で異なる失敗が出たが、根本はPJT固有ではなく、DevSpace作業の共通分類・入力形式・編集方式・検証方式の未整理にある。ここではPJT別プレイブックを作らず、全PJTに適用できる統一運用方針を作る。

## 目的

DevSpace作業を、作業分類ごとに最短で成功しやすいtool sequenceへ導く統一方針を文書化し、Skillから参照できるようにする。

## 実装範囲

1. `docs/workbridge-operating-policy.md` を新規作成する。
2. `skills/workbridge-workflow/SKILL.md` に統一方針への参照を追記する。
3. 必要なら `docs/workflow-router.md` に関連リンクを追記する。
4. `package.json` のversionを `1.1.35` に更新する。
5. `package-lock.json` のroot versionも `1.1.35` に更新する。

## 方針に含めるべき作業分類

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

## 方針に含めるべき共通判断

- read/inspectはまずRouterまたはfocused readへ寄せる。
- small editはstructured editまたはunified patchを優先する。
- large edit/refactorは事前にalternate execution pathと検証範囲を定義する。
- validation/testは `devspace_verify` fixed profileを優先する。
- sensitive integrationは実secret値ではなくenv var参照・config key・mock-firstを構造化する。
- runtime/external side effectは明示フラグ・手動確認・dry-runを優先する。
- incidentは単なる停止ではなく、改善候補へ分類する。

## 重要な表現ルール

避けるべき表現:

```text
危険なのでやらない
その単語を使わない
ブロックされたら諦める
PJTごとの注意事項を追加する
```

使うべき表現:

```text
typed schemaに分離する
reference_onlyとして扱う
structured edit transportに移す
fixed verify profileに寄せる
incidentをefficiency improvement候補に変換する
```

## 実装手順

1. `git status --short` を確認する。
2. `docs/workbridge-operating-policy.md` を作成する。
3. Skillへ短い参照を追加する。
4. versionを更新する。
5. `npx tsc -p tsconfig.json --noEmit` を実行する。
6. `npm run smoke:startup` を実行する。
7. `git diff --check` を実行する。
8. 自己レビューする。
9. 問題なければcommitする。

## レビュー観点

- PJT別ルールが増えていないか。
- 「回避」や「禁止」が目的化していないか。
- 全PJT共通の作業分類として使えるか。
- 後続のClassifier、Structured Edit、Sensitive Integration、Metricsタスクが参照できる粒度になっているか。
- `Skill` の追記が長すぎず、実運用で読みやすいか。

## 移行条件

次の条件を満たしたら v1.1.36 へ進む。

- `docs/workbridge-operating-policy.md` が存在する。
- Skillから参照されている。
- 作業分類が明記されている。
- `npm run smoke:startup` が通る。
- git statusがclean。

## 後続タスク見直し条件

このタスクで作業分類名が変更された場合、v1.1.36〜v1.1.42の全タスクmd内の分類名を更新すること。分類体系が大きく変わる場合は、新規調整タスクを作成すること。
