# backend — Cloudflare Workers

claude-code-remote の中継 backend。Workers + D1 + Hono。

## 必要なもの

- Node.js 18+
- Cloudflare アカウント
- GCP プロジェクト + FCM 有効化 + service account JSON

## セットアップ

### 1. 依存インストール

```sh
npm install
```

### 2. Cloudflare ログイン & D1 作成

```sh
npx wrangler login
npx wrangler d1 create claude-code-remote
```

出力された `database_id` を `wrangler.toml` の `[[d1_databases]]` に貼り付け。

### 3. マイグレーション適用

```sh
npm run migrate:local   # ローカル開発用
npm run migrate:remote  # 本番デプロイ後に 1 度
```

### 4. シークレット設定

開発時は `.dev.vars.example` を `.dev.vars` にコピーして埋める（gitignore 済み）。

本番:

```sh
openssl rand -hex 32 | npx wrangler secret put SHARED_SECRET
npx wrangler secret put FCM_SERVICE_ACCOUNT_JSON  # JSON 全体を貼り付け
echo "your-gcp-project-id" | npx wrangler secret put FCM_PROJECT_ID
```

### 5. ローカル起動 / デプロイ

```sh
npm run dev      # ローカル開発（http://localhost:8787）
npm run deploy   # Cloudflare に deploy
```

### 6. 動作確認

```sh
curl https://claude-code-remote.<subdomain>.workers.dev/health
# → {"ok":true,"ts":1714867200000}
```

## エンドポイント

### Phase 0（実装済み）
- `GET /health` — 認証不要

### Phase 1
- `POST /v1/devices/register` — FCM トークン登録
- `POST /v1/approvals` — 承認リクエスト作成（PC hook → backend）
- `GET /v1/approvals/:id` — 承認状態取得（PC hook ポーリング）
- `POST /v1/approvals/:id/respond` — 承認応答（Android → backend）
- `POST /v1/hook/stop` — Stop hook（dismiss + threshold 判定 + 完了通知）
- `POST /v1/hook/posttool` — PostToolUse hook（pending dismiss のみ）

設計詳細は [`../docs/handover.md`](../docs/handover.md)。
