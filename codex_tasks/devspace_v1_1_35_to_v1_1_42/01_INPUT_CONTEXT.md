# DevSpace v1.1.35〜v1.1.42 実装前インプット資料

## 1. この資料の目的

この資料は、v1.1.35〜v1.1.42のCodexタスクを実装する前に読む共通インプットである。各タスクの個別実装に入る前に、DevSpaceというシステム自体の目的、全体構成、現在地、設計原則、今回のタスク群が解決しようとしている根本課題を揃える。

この資料はプロジェクト別ルールではない。Aegis Gate、Arcaia、DevSpace本体などの実例は、全PJT共通の効率化ロジックを作るための観測事例として扱う。

## 2. 最重要方針: 回避ではなく効率化

このタスク群の最重要目的は、危険そうな作業を避けることではない。

目的は、DevSpace側の入力形式、構造化tool、検証導線、ログ分析を改善し、同じ目的をより速く、確実に、一気通貫で達成できるようにすることである。

### 2.1 誤った方向

以下を目的にしてはいけない。

```text
- 危険そうな単語を避ける
- API / secret / token / webhook などを含む作業をやらない
- エラーが出たら単に停止する
- PJTごとの独自注意事項を増やす
- bashを禁止して作業範囲を狭める
- base64を安全フィルタ回避目的で使う
```

### 2.2 正しい方向

以下を目的にする。

```text
- 実secret値とenv var名・config key名・コード上の参照を構造的に区別する
- free-form bashではなくtyped schemaへ分離する
- 大きい編集や特殊文字をstructured edit transportへ移す
- fixed devspace_verify profileで検証導線を短縮する
- incidentを停止理由ではなく、次回の効率改善入力へ変換する
- ログから非効率の発生箇所を測定し、DevSpace機能改善へ戻す
```

## 3. DevSpaceの目的

DevSpaceは、ローカルworkspaceに対してAIが安全かつ効率的に読み取り、編集、検証、commitまで進めるための作業基盤である。

単なるshell実行環境ではない。最終的には、以下を実現するためのstructured workflow layerである。

```text
1. 対象workspaceを安全に扱う
2. 必要最小限の情報を読む
3. 変更を構造化して適用する
4. 検証をfixed profileへ寄せる
5. 結果をログ化し、次回の効率改善へ使う
6. 長いチャットや複数PJTでも同じ運用を再現する
```

## 4. DevSpaceの全体構成

v1.1.34時点の重要構成は以下である。

```text
DevSpace MCP server
  ├─ Workspace registry
  ├─ Read / inspect tools
  ├─ Structured edit / patch tools
  ├─ Router / workflow tools
  ├─ devspace_verify fixed profiles
  ├─ workflow event recording
  ├─ log analysis / reports
  ├─ Skill / operating guide
  └─ startup smoke / runtime validation
```

## 5. 主要コンポーネント

### 5.1 Workspace registry

workspaceIdとローカルrootを対応付ける。v1.1.35〜v1.1.42のタスクでは、workspace境界を壊さないことが前提である。

### 5.2 Read / inspect tools

広範囲の読み取りを繰り返すと、出力肥大、ストリームエラー、無駄な往復につながる。今後は、read-heavyな作業をRouter、focused read、ZIP-first、locatorへ寄せる。

### 5.3 Structured edit / patch tools

`apply_structured_edit` と `apply_unified_patch` は、bash一括編集よりも効率的で再現性の高い編集経路である。v1.1.37では、特殊文字や大きなtemplateを壊さず搬送するtyped transportを強化する。

### 5.4 Router / workflow tools

Routerは任意の自然言語実行器ではない。小さなstructured requestを受け取り、次に使うべきtoolやverify profileを提案するplanning layerである。

v1.1.34時点では、Router v1として `verify_plan` / `suggest_verify` が存在する。

### 5.5 devspace_verify

`devspace_verify` は、typecheck、related test、npm test、build、git diff check、git status checkなどをfixed profileとして実行する。任意shell commandではなく、bounded outputとstructured resultを返す検証導線である。

### 5.6 workflow event recording

Router、verify、patch、inspectionなどの作業結果をworkflow eventとして記録する。これは単なる履歴ではなく、baseline / router / zip_first / zip_first_router の比較と効率化に使う。

### 5.7 log analysis / reports

`npm run logs:report` と `scripts/analyze-workbridge-logs.mjs` は、DevSpace利用効率を観測するための基盤である。v1.1.42では、効率化metricsをここへ統合する。

### 5.8 Skill / operating guide

Skillは、チャットが長くなっても方針を再現するための運用ガイドである。ただし、PJT別ルール集にしてはいけない。全PJT共通の作業分類・編集方式・検証方式・incident改善方針を置く。

## 6. 現在地: v1.1.34

v1.1.34時点で完了している主な内容は以下である。

```text
v1.1.29:
  devspace_verify schema robustness

v1.1.30:
  workflow log analysis拡張

v1.1.31:
  package manager verify hotfix
  spawn EINVAL対策

v1.1.32:
  startup smoke / runtime validation docs and script

v1.1.33:
  Router v1 verify_plan / suggest_verify

v1.1.34:
  logs:report HTML details sections hotfix
```

v1.1.35以降は、この基礎の上に、統一運用方針、分類器、structured edit transport、sensitive integration workflow、alternate path detector、verification policy、incident loop、efficiency metricsを積む。

## 7. 最近の実行結果から見えた根本課題

### 7.1 API/env/secret系の扱い

問題は、API keyという単語やenv var名そのものではない。実secret値と、env var名・config key名・コード上の参照がfree-form textやbash編集の中で区別されないことが非効率を生む。

根本解決は以下である。

```text
- env var referenceをtyped schemaにする
- secret value handlingを明示する
- 実secret値は受け取らない
- config-only / mock-first / live smoke明示フラグを分離する
```

### 7.2 大きな一括編集の失敗

長いPython heredoc、巨大文字列置換、正規表現、HTML template、Windows console encodingは、PJTに関係なく失敗しやすい。

根本解決は以下である。

```text
- locator + hash guard
- apply_structured_edit
- apply_unified_patch
- contentEncodingを持つstructured transport
- decoded size limit
- dryRun first
```

### 7.3 alternate execution pathの見落とし

分割・リファクタでは、main pathだけでなく、fallback、manual injection、CLI、daemon、batch、test、config、generated artifact pathを確認する必要がある。

根本解決は、PJT別チェックリストではなく、alternate execution path detectorとして一般化することである。

### 7.4 検証のばらつき

毎回bashでテストコマンドを組み立てると、出力肥大やchain commandの問題が出る。検証は作業分類ごとにfixed profileへ寄せる。

根本解決は、verification policyを作り、Routerの `verify_plan` と `devspace_verify` を接続することである。

### 7.5 incident後の判断

ブロックやエラーが起きたとき、同じ経路で粘ると効率が落ちる。ただし目的は停止ではない。

根本解決は、incident categoryとimprovement actionを定義し、次回はより効率的な経路に切り替えることである。

## 8. v1.1.35〜v1.1.42の関係

```text
v1.1.35 Unified Operating Policy
  全体方針と作業分類を定義する

v1.1.36 Unified Risk / Efficiency Classifier
  作業分類と効率的sequenceを返す

v1.1.37 Structured Edit Transport
  大きな編集・特殊文字・template搬送を壊れにくくする

v1.1.38 Structured Sensitive Integration Workflow
  env var参照・config・mock-first・live smokeを構造化する

v1.1.39 Alternate Execution Path Detector
  main path以外の実行経路を一般検出する

v1.1.40 Verification Policy Unification
  taskClassごとの最小十分なverify profileを統一する

v1.1.41 Incident-to-Improvement Loop
  エラーやブロックを効率改善候補に変換する

v1.1.42 Efficiency Metrics / Log Report Integration
  効率化の成果と課題をログで測定する
```

## 9. 設計原則

### 9.1 Typed over free-form

自由文やbash文字列で意図を渡すより、typed schemaで意図・値・制約を分離する。

### 9.2 Reference over secret value

env var名、config key名、credential referenceは扱ってよい。実secret値は受け取らない、読まない、書かない。

### 9.3 Transport over workaround

encodingは回避ではなく搬送手段である。目的は特殊文字や大きなtemplateを壊さないこと。

### 9.4 Dry-run over blind write

大きい編集や構造化編集はdryRun firstを基本にする。

### 9.5 Fixed profile over ad-hoc validation

検証はfixed profileへ寄せ、出力をboundedにする。

### 9.6 Incident over blame

エラーは失敗理由ではなく改善入力である。原因を分類し、次回の効率化アクションへつなげる。

### 9.7 Unified over project-specific

PJT別の独自ルールは作らない。個別事例は全PJT共通の分類・検出・workflowへ抽象化する。

## 10. 実装時の共通注意

- 既存のMCP schemaを壊さない。
- optional fieldの `null` / `undefined` 不一致に注意する。
- outputはboundedにする。
- HTML reportにsectionを追加したら、testで存在確認する。
- 新しい分類名を作った場合、後続タスクmdも更新する。
- version更新とpackage-lock root version更新を忘れない。
- `git status --short` と `git diff --check` を必ず確認する。

## 11. Codexへの期待動作

Codexは各タスクを単発で処理するのではなく、以下のループで動く。

```text
1. このinput contextを読む
2. 該当タスクmdを読む
3. 現在repo状態を確認する
4. 実装する
5. 自己レビューする
6. テストする
7. 後続タスクの前提変更があればタスクmdを更新する
8. commitする
9. 次タスクへ移行する
```

## 12. v1.2.0の到達イメージ

v1.2.0では、DevSpaceが以下の状態になっていることを目指す。

```text
- 全PJT共通の作業分類がある
- classifierが効率的なtool sequenceを返す
- structured edit transportで大きな編集が壊れにくい
- env var参照やAPI integrationをtyped workflowで扱える
- alternate execution pathを一般検出できる
- verify policyが統一されている
- incidentを改善アクションへ変換できる
- logs:reportで効率化metricsを確認できる
```

この状態になれば、DevSpaceは「作業を避けるための安全装置」ではなく、「難しい作業をより効率よく進めるための統一workflow基盤」として扱える。
