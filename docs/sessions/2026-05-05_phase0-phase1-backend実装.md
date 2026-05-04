# 2026-05-05 Phase 0 + Phase 1 backend 実装

設計確定後、Workers backend と PC hook script を実装、Android なしで承認フローの E2E まで動作確認。

## 完了したこと

### Phase 0: ベースライン
- D1 データベース `claude-code-remote` 作成（id `4c89f4b7-002c-4d4e-8a68-be23ea6a1f0f`、APAC region）
- マイグレーション 0001（devices / approvals / notifications）を local + remote に適用
- Worker `claude-code-remote` を `https://claude-code-remote.tachibanayu24.workers.dev` にデプロイ
- secrets 登録済み（`SHARED_SECRET` / `FCM_PROJECT_ID` / `FCM_SERVICE_ACCOUNT_JSON`）
- FCM service account の JWT 署名 → OAuth トークン交換まで動作確認

### Phase 1: MVP backend 側
- `backend/src/fcm.ts` 実装: Web Crypto で RS256 JWT 署名、OAuth トークンを isolate メモリに best-effort キャッシュ、FCM v1 messages:send を呼ぶ
- `backend/src/index.ts` に `/v1/*` エンドポイント追加
  - `POST /v1/devices/register`
  - `POST /v1/approvals` / `GET /v1/approvals/:id` / `POST /v1/approvals/:id/respond`
  - `POST /v1/notifications`
- 全エンドポイント認証・冪等性（既決済 → 409）含めて smoke test 通過

### Phase 1: PC hook script
- `hooks/cc-remote-hook.mjs` 実装: Node 18+ ESM、依存ゼロ
- 3 モード: `pretool` / `stop` / `notify`
- `pretool` は 1 秒間隔・最大 5 分ポーリング、設定不備・到達不能・タイムアウトすべて `ask` fallback
- `~/.claude/hooks/.env` から `CC_REMOTE_BACKEND_URL` と `CC_REMOTE_SHARED_SECRET` を読む
- `hooks/README.md` にセットアップ手順と `~/.claude/settings.json` の hook 登録例

### E2E 動作確認（curl 疑似）
- pretool → backend POST → D1 INSERT → curl で respond → 次のポーリングで decision 取得 → stdout に `permissionDecision: "allow"` JSON 出力
- 同様に deny も動作確認
- stop / notify は fire-and-forget で exit 0
- テストデータは D1 から削除済み

## 設計上のメモ

### `notified` フィールド
`POST /v1/approvals` および `POST /v1/notifications` のレスポンスに `notified: <int>` を含めた。これは「FCM 送信を**試みた**端末数」であり、実際に届いたかは保証しない。FCM 送信失敗は console.error にログするが request 自体は成功を返す（fire-and-forget セマンティクス）。

### `tool_summary` の生成
PreToolUse の Android 通知に表示する短い要約は backend 側で生成（`backend/src/index.ts` の `summarize` 関数）。Bash の `command`、Edit/Write/MultiEdit の `file_path` を優先抽出、それ以外は JSON.stringify を 200 文字で truncate。

### `ask` fallback の詳細条件
PC hook script が `ask` を返すケース:
1. `~/.claude/hooks/.env` が読めない・必須キー欠落
2. `POST /v1/approvals` が non-2xx
3. `POST /v1/approvals` で例外（ネットワーク失敗）
4. ポーリング 5 分タイムアウト

すべてのケースで Claude Code の通常承認プロンプトに fallback。詰まらない設計。

## 残タスク

### Phase 1 残り
- [ ] Android アプリ: FCM 受信 → NotificationCompat で Approve/Deny アクション付きローカル通知
- [ ] Android アプリ: BroadcastReceiver で action タップを処理 → backend POST
- [ ] Android アプリ: 初回起動時に backend URL + shared secret 入力 → device 登録
- [ ] フル E2E 動作確認（PC hook → 実機 push → ボタンタップ → hook が decision 受信）

### 既知の todo / 改善点
- Workers の `notified` 数が「送信試行数」でしかないので、本当に届いたか確認したい場合は別途 FCM の delivery report を見る必要あり（FCM v1 の dry-run / batch send で reachable token 確認可、必要時に追加）
- D1 の古いレコードクリーンアップは未実装。MVP では問題ないが、長期運用するなら cleanup-on-write or cron trigger
- ローカル `wrangler dev` での動作確認は省略（remote deploy で直接検証）

## 参考

- 監査結果: [`./2026-05-04_実装方針確定.md`](./2026-05-04_実装方針確定.md)
- 全体設計: [`../handover.md`](../handover.md)
- hook script setup: [`../../hooks/README.md`](../../hooks/README.md)
- backend setup: [`../../backend/README.md`](../../backend/README.md)
