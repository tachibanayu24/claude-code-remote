# 2026-05-18 AskUserQuestion 後の全体リファクタリング

AskUserQuestion 実装 (`feat/ask-user-question` ブランチ) を main にマージした後、 「部分最適が重なってコードベースがぐちゃぐちゃに感じる、 長期保守できる構成にしたい」 という user の要望で全体リファクタを実施。

## 着手前の問題仮説

監査して見えた「ぐちゃぐちゃ」 感の根本要因:

1. **ドキュメントの大幅な乖離** — `README.md` / `docs/handover.md` に AskUserQuestion / question relay / migration 0010〜0016 が一切記載なし。 自分で読んでも全体像が掴めず、 git log から逆算する必要があった (= 今回時間がかかった主因)。
2. **2 ドメイン (approval + question) が並列に存在**、 共通 lifecycle が抽象化されていない。 `expirePending*`、 `notify*Resolved`、 `PendingXxxBlock`、 `XxxPayload` が双子で量産。
3. **`push.ts` の 5 関数が listFcmTokens + fanOut の同じパターンを 5 回書いている**。
4. **Android `Models.kt` が 174 行で全ドメインを抱える**。
5. **notification channel の命名が approval 偏重** (`CHANNEL_APPROVAL` を question にも使い回し)。
6. **spike artifact (`hooks/spike-aq-probe.mjs`) と未使用変数の残り**。
7. **PostToolUse hook が 2 ドメイン両方の dismiss を直書き** = 拡張時に必ず編集される hot spot。

## 進めた Phase

### Phase A — ドキュメント全面更新 (`3ac2acb`)

リスク 0、 最優先で対応。 「コードと doc の乖離」 が再発防止できれば次回からこんな全体掃除は不要になる。

- `README.md`: architecture diagram に question relay と PermissionRequest hook 経路を追加、 D1 テーブル一覧に `questions` と `settings.question_ask_delay_ms` を反映
- `docs/handover.md`: §2 現状 を AskUserQuestion 込みで更新、 §3 各コンポーネント責務に `hooks/ask-user-question.mjs` を追加、 §6 D1 schema を migration 0016 まで、 §8 hook 登録例に PermissionRequest を追記、 §9 ロードマップに Phase 4 完了を反映
- `CLAUDE.md`: ドメイン用語表 (approval / question / interaction の使い分け) を 1 セクション追加
- `docs/architecture.md` (新規): モジュール責務マップ + 4 経路 (approval / question / completion / prompt-inject) のデータフロー + 「どこに何を追加するか」 ガイド + 用語集

### Phase B — backend 整理 (`107d897`)

- `src/lifecycle.ts` 新設: `expirePendingBy(table, where, value)` の generic SQL helper、 + `dismissAllPendingForSession` で session 横断 dismiss を 1 箇所集約
- `approvals.ts` / `questions.ts` を `expireAndNotify` thin wrapper だけ持つ構造に
- `push.ts` を `pushNotification(type, data)` 中心に再構成、 `notify*Request/Resolved` は thin wrapper として残し call site の grep 性は維持
- `routes/hooks.ts` の PostToolUse は `dismissAllPendingForSession(sessionId)` 1 呼び出しに集約 → 新ドメイン追加時 routes を触らない構造に
- `/v1/questions/:id/dismiss` route + `dismissQuestionById` 関数を削除 (channel.mjs の dismiss-next 削除後 dead だった)

### Phase C — Android 整理 (`c117107`)

- `data/Models.kt` (174 行) を `Common.kt` / `ApprovalModels.kt` / `QuestionModels.kt` / `SessionModels.kt` / `SettingsModels.kt` にドメイン別分割。 同 package なので import 修正不要
- `CHANNEL_APPROVAL` を `CHANNEL_REQUEST` に rename、 ID 文字列も `"approval"` → `"request"` に (承認 + 質問の両方を扱う統合 channel)。 旧 channel は端末側に孤立して残るが単一 user システムなので許容
- `PendingApprovalBlock` / `PendingQuestionBlock` の外枠を `PendingCard(header, content)` Composable に抽出、 ドメイン固有 body は content lambda へ

### Phase D — hooks / channel 整理 (`6456b56`)

- `hooks/spike-aq-probe.mjs` 削除 (git 履歴で復元可、 本実装が動いてるので参照不要)
- `hooks/ask-user-question.mjs` から「将来 tool_use_id 連動用」 と称して残してあった `inputPreview` 変数 + `findPendingToolUseInJsonl` / `readFileSync` / `jsonlPath` import を削除 (PostToolUse session-wide dismiss 設計では使わない)
- `channel/channel.mjs` 冒頭コメントを refresh: 3 役割の番号付き列挙 + AskUserQuestion を扱わない旨を明示

### Phase E — 動作確認

PC で `claude --continue` 再起動 + Android Studio rebuild の後、 通し確認:

- ✅ Bash 承認 (WebFetch で代用): phone カード表示 → 許可 → CLI 進行、 backend row が status=allow / resolved_by=device_id で記録
- ✅ AskUserQuestion: phone or CLI どちらでも応答可
- ✅ prompt inject (phone → CC): `<channel>...</channel>` 形式で届く
- (Stop 完了通知 / セッション画面の過去 turn 表示は短ターン or 起動済みアプリで簡単に観察可能、 user 主導テスト)

## 効果

- 「次回の機能追加で 'どこに何を書くか' が `docs/architecture.md` の 1 ファイルで分かる」 = 同じ作業を 2 回しない
- backend で新 interaction ドメインを足す時、 lifecycle / push / routes/hooks の 3 箇所が「追記するだけ」 構造に
- Android Models が肥大化しない (= 機能追加で `XxxModels.kt` を作るだけ)
- 命名 (`CHANNEL_REQUEST` = approval + question 両用) で「2 種のリクエスト」 という上位概念を表現

## 残課題 (将来)

- `Block` を kotlinx.serialization の sealed hierarchy にする (現状は `kind` discriminator + nullable fields)
- 旧 (blocks NULL) turn 行の表示
- 3 ドメイン目の interaction が出てきた時に lifecycle / push の generic 化が窮屈に感じるか再検討
