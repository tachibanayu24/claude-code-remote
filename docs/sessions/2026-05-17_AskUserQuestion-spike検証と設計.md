# 2026-05-17 AskUserQuestion spike 検証と設計

前回 (2026-05-13) は「設計だけ済ませて保留」だったが、設計の前提自体を疑って組み直す方針で再着手。先入観を持たず実機 spike で挙動を確定させ、そこから全体最適の構造を決めた。

## なぜ前回の設計を捨てたか

前回は「PreToolUse hook で `deny + systemMessage` → ローカル UI を抑制 → phone 専用にする」案を Phase 2 として残していたが、

- そもそも AskUserQuestion を hook で乗っ取る最新の正攻法 (PermissionRequest hook + updatedInput) が未確認だった
- 「ローカル UI 抑制」自体が、ユーザーが本当に欲しい体験 ("CLI dialog も出る + phone でも操作 + first responder wins") と逆方向だった

公式 docs / GitHub Issue #15872 (Seraphli の updatedInput 報告) を起点に再調査し、実機 spike で詰めた。

## Spike で確定したこと

| # | 事項 | 結果 |
|---|---|---|
| 1 | AskUserQuestion で PermissionRequest hook が発火する | ✅ |
| 2 | PreToolUse も同時発火する (回答は返せない) | ✅ |
| 3 | MCP channel notification は AskUserQuestion で **一切発火しない** (推測 capability 5 種 + 既存 permission_request すべて空振り、backend D1 に row も増えない) | ✅ |
| 4 | `hookSpecificOutput.decision.updatedInput.answers` で回答を返せる | ✅ |
| 5 | hook が delay 中も CLI dialog は **並行表示** される (hook と dialog は同期しない) | ✅ |
| 6 | hook が遅れて answer を返すと CLI dialog は自動クローズ + hook answer 採用 (= phone 後勝ち) | ✅ |
| 7 | user が CLI で早勝ちした場合、遅延 hook answer は無視される (副作用なし) | ✅ |
| 8 | `multiSelect: true` は answers を array で返せば受理。Claude 側には comma-joined string で見える | ✅ |
| 9 | hook 設定はライブ再読み込み (CC 再起動不要) | ✅ |

つまり既存承認 relay と **完全同じ "first responder wins"** が PermissionRequest hook ベースで実現できる。

検証用 probe は `hooks/spike-aq-probe.mjs` に残してある (将来 spec 変更の再検証用)。channel.mjs に仕込んだ stderr ミラー / 推測 capabilities / 推測 method handlers は本実装前に revert 済み。

## 経路の非対称性は受け入れる

- 承認: MCP channel (常駐 `channel.mjs`)
- 質問: PermissionRequest hook (per-call 短命プロセス)

CC 側が MCP channel に AskUserQuestion を流さない事実が確定したので、ここに選択の余地はない。無理に統合せず適材適所で:

- `channel.mjs` (常駐): 全 session の承認 + heartbeat + prompt drain + 質問の **JSONL 監視による early-dismiss** を担当
- `hooks/ask-user-question.mjs` (新規, 短命): 質問 1 件あたり起動、 long-poll で answer 取得 → updatedInput で返す

## 全体最適のための層別共通化

| 層 | 共通化 | 専用 |
|---|---|---|
| Hook 側コード | `channel/lib/api.mjs` (apiPost / config) と `channel/lib/session.mjs` (readPpidSession / getSessionLabel) を流用 | `hooks/ask-user-question.mjs` 本体 |
| Backend | FCM push lifecycle、auth、ask_delay_ms、long-poll | `/v1/questions/*` routes、`backend/src/questions.ts` (`approvals.ts` と対称な集約) |
| `channel.mjs` | 既存 wait loop、JSONL parser、settings tuning | `pending_question_ids` の追加と JSONL early-dismiss |
| Android | FCM dispatcher、`BackendClient`、通知 channel、Settings 連携 | `QuestionPayload`、`QuestionActivity`、`respondQuestion` |

## D1 schema は分離

統合 (`approvals` テーブルに `request_type` 列追加) も検討したが、

- `tool_input` blob の schema が `{description, input_preview, supports_always}` (承認) vs `{questions: [...]}` (質問) で構造的にまるで違う
- `supports_always` / allowlist は質問では死にコード
- backend route / format / Android UI の分岐が散らばる

→ 分離 (`questions` テーブル新設) する方が schema・型・UI 全部薄く保てる。共通化は lifecycle / push helper レベルで十分。

## 体験フロー

```
[CC] AskUserQuestion 発火
  ├─ PreToolUse hook (使わない)
  └─ PermissionRequest hook
      ├─ hooks/ask-user-question.mjs (新規, 短命) 起動
      │   ├─ POST /v1/questions (backend)
      │   ├─ POST /v1/questions/:id/wait で long-poll
      │   └─ answer 来たら decision.updatedInput.answers を stdout に
      │
      └─ CLI dialog も並行表示

[Backend] POST /v1/questions
  ├─ D1 questions insert
  ├─ FCM push (data type=question)
  └─ ask_delay_ms 経過後に notify (承認と同じ仕組み)

[channel.mjs] wait loop
  ├─ session の pending_question_ids を取得
  ├─ JSONL で AskUserQuestion の tool_use_id に tool_result を検出
  └─ /v1/questions/:id/dismiss → phone 側 UI クリア

[Android]
  ├─ FCM data: type=question → QuestionActivity
  ├─ Compose: 質問リスト + radio/chip + Other 自由入力
  └─ Submit → /v1/questions/:id/respond {answers}

[Hook] long-poll が answers 受信 → stdout に decision JSON

[CC] CLI dialog 自動クローズ、AskUserQuestion 解決
```

## 残課題 / 実装中に確認する事項

- PermissionRequest hook の timeout 設定の上限 (現状 spike で 30s しか試してない、本実装は 120s 想定)
- 同一ターンで複数 AskUserQuestion 連続発火時の channel.mjs JSONL 監視 (既存承認 relay と同じパターンで吸収可能なはず)
- multiSelect=true で複数選択の場合、Claude 側に comma-joined で見える挙動の妥当性 (CC の表示整形なので実用上問題なし)
- "Other" 自由入力をどう options に乗せるか (label に Other を含めるか、別途 text field を Android UI に出すか)
