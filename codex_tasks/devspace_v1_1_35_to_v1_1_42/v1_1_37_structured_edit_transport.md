# Codex Task: DevSpace v1.1.37 Structured Edit Transport

## 共通最重要方針: 回避ではなく効率化

目的はbash編集を単に避けることではなく、特殊文字や大きな変更でも壊れにくく、レビュー可能で、hash guard付きで適用できる編集経路へ効率化すること。

## Codex推論レベル

非常に高い

## 背景

最近の失敗の多くは、長いPython heredoc、巨大文字列置換、正規表現やHTML template literalを含む編集、Windows出力encodingなど、文字列搬送・編集単位の問題だった。base64等のencodingは、フィルタ回避ではなく、特殊文字・大きなpatch・テンプレート文字列を壊さず搬送するtyped transportとしてのみ扱う。

## 目的

既存の `apply_structured_edit` / `apply_unified_patch` を拡張または補助し、plain/base64などのtyped content transport、decoded size validation、hash guard、dry-run結果を標準化する。

## 実装範囲

既存構造を確認して最小安全範囲で行う。

候補:

1. `apply_structured_edit` に `contentEncoding?: "plain" | "base64"` を追加する。
2. decoded contentの最大サイズを制限する。
3. base64はフィルタ回避ではなく、特殊文字・大きなtemplate・patch搬送のためのtransportとしてdocsに明記する。
4. `apply_unified_patch` への追加が大きすぎる場合は、まず `decodeStructuredContent` helper + testのみでも可。
5. `src/workflow-tools.test.ts` にbase64 contentのdryRun/apply testを追加する。
6. `docs/workbridge-operating-policy.md` にStructured Edit Transportを追記する。
7. versionを `1.1.37` に更新する。

## 非目的

- フィルタ回避を目的にしたencodingではない。
- 任意bash文字列を隠して通す機能ではない。
- 実secret値をbase64で受け取る機能ではない。

## 期待される入力例

```json
{
  "operation": {"type": "replace", "contentEncoding": "base64", "content": "..."},
  "locator": {"type": "section_heading", "heading": "## Target"},
  "expectedSha256": "...",
  "dryRun": true
}
```

実際のschemaは既存MCP schemaに合わせること。

## 実装手順

1. 既存 `ApplyStructuredEditInput` / registration schema / testsを確認する。
2. contentEncoding追加の影響範囲を確認する。
3. 小さく実装する。
4. plain既存挙動の後方互換を維持する。
5. base64 decode失敗、サイズ超過、dryRun、applyのtestを追加する。
6. `npx tsc -p tsconfig.json --noEmit` を実行する。
7. `npx tsx src/workflow-tools.test.ts` を実行する。
8. `npm test` とbuildを実行する。
9. docs更新後、commitする。

## レビュー観点

- base64が「回避目的」と読める説明になっていないか。
- decoded size上限があるか。
- dryRunで差分確認できるか。
- hash guardが維持されるか。
- 既存plain contentの挙動が壊れていないか。
- MCP schemaにnullやundefined不一致がないか。

## 移行条件

次の条件を満たしたら v1.1.38 へ進む。

- structured editでplain/base64のどちらか、またはtransport helperがtest済み。
- docsでencodingの目的が効率化・堅牢化として説明されている。
- npm testが通る。
- git statusがclean。

## 後続タスク見直し条件

contentEncoding schemaやtransport helper名が変わった場合、v1.1.38のStructured Sensitive Integration Workflowの実装方針を更新すること。
