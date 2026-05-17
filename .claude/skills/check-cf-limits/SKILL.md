---
name: check-cf-limits
description: |
  claude-code-remote プロジェクトで使っている Cloudflare サービス (Workers / D1) の
  無料枠使用率を取得して人間向けにサマリし、`docs/limits-check.md` のスナップショット
  履歴に追記するスキル。「無料枠」「リミット」「cloudflare 使用量」「使用量チェック」
  「枠ヒット」等で起動する。
allowed-tools: Bash, Read, Edit
---

# Cloudflare 無料枠チェック

このスキルは claude-code-remote プロジェクト専用。Workers と D1 の使用量を
GraphQL Analytics API + `wrangler d1 info` から取得し、無料枠との比率を表示する。

## 前提

- このディレクトリの `check.sh` が動く環境 (curl, python3, npx)
- `npx wrangler whoami` がログイン済み (OAuth トークンは `~/Library/Preferences/.wrangler/config/default.toml` から取得)
- OAuth トークン期限切れ (401 Unauthorized 等) の場合は最初に `cd backend && npx wrangler whoami` を一度走らせて refresh させる

## 手順

1. **実行**: プロジェクトルートで `.claude/skills/check-cf-limits/check.sh` を実行。
   - 標準出力に Workers/D1 の 24h スナップ + 7 日履歴が表示される。
   - `--json` を付けると機械可読 JSON を出力 (履歴記録用)。

2. **無料枠との比較**: 出力の `[OK / WATCH / WARN / OVER]` を確認し、ユーザーに人間向けサマリを返す。
   特に注意:
   - **Workers requests/day** が 100,000 に近い (WARN 以上) → channel.mjs の polling 増を疑う
   - **D1 rows_written/day** が 100,000 に近い → hooks/PostToolUse の書き込み頻度を疑う
   - **CPU P99 が 8,000 μs 超 (10ms 上限の 80%)** → Workers Observability で重い route を特定 (下記「## CPU P99 追い込み手順」参照)
   - **Errors > 0** → Workers Observability で内訳を確認 (Dashboard > Logs)。または `npx wrangler tail claude-code-remote`
   - **Workers Logs 自体の枠** (200k events/日, 3 日保持) → 通常運用 (~10k req/日) では余裕だが、polling 暴発で req が跳ねるとログ枠も同時に食う点だけ留意

3. **スナップショット記録**: `docs/limits-check.md` の "## 計測ログ" セクションに新しいエントリを **先頭** (最新が上) に追加する。
   フォーマット:

   ```markdown
   ### YYYY-MM-DD HH:MM JST — <人間サマリ>

   - Workers 24h: <req>/100k req (<pct>%) / CPU P99 <μs>μs / errors <n>
   - D1 24h: rows R/W = <r>/<w> (<wpct>% of 100k write)
   - DB size: <size>
   - 過去 7 日のピーク: <date> requests=<n> (<pct>%)
   - 所見: <一言で>
   ```

   人間サマリは「余裕」「要監視」「危険」のどれかで始める。

4. **危険水準なら**:
   - WARN/OVER が出ている指標について、原因仮説 (どのエンドポイント・どの hook) を 1-2 行で添える。
   - 直近のコミット (`git log --oneline -10`) や `docs/sessions/` の最新エントリと突き合わせ、最近の変更が増加要因か確認。

## CPU P99 追い込み手順

`backend/wrangler.toml` で `[observability] enabled = true` が有効になっており、
全リクエストの invocation logs (CPU 時間 / duration / status / URL) が 3 日間
保存される (Free tier: 200k events/日)。CPU P99 が WARN 水準なら以下の流れで原因
を特定する。

1. Dashboard を案内する:
   <https://dash.cloudflare.com/2ed52fafd3387679d9b97beadf46abee/workers-and-pages/view/claude-code-remote/production/observability/logs>
2. フィルタで `CPU Time > 8000μs` を設定して outlier だけ残す。
3. URL カラムで route 別に集計し、上位を特定 (`/v1/wait`, FCM 送信を伴う
   `/v1/approvals/:id` 系、複数 session を舐めるクエリあたりが疑わしい)。
4. 該当 route のコードを読み、JWT 署名・サブリクエスト・SQL の N+1・JSON
   parse の重さなどを点検。
5. 改善後は再度このスキルを走らせて CPU P99 が下がったか確認 (反映には数時間〜
   1 日かかる)。

ユーザーが「ログから集計して」と頼んできた場合は Dashboard を案内する以外に、
Workers Logs Query API (GraphQL) を `check.sh` 経由で叩く手もある (将来拡張)。

## 出力例 (ユーザーへの返答テンプレ)

> 余裕あり。Workers は 24h で 9,548 req (9.5%)、D1 writes は 21,450 rows (21%)。
> ただし 5/7 に requests が 129k で枠オーバーしていた履歴あり (long-poll 化で解決済み)。
> CPU P99 が 9,998μs と 10ms 上限ギリギリの日があるので、新しい重い処理を入れる時は注意。
> スナップショットを `docs/limits-check.md` に追記しました。

## 環境変数オーバーライド

別 worker/別 DB を見たい場合:

```bash
WORKER_NAME=other-worker DB_ID=xxx-yyy .claude/skills/check-cf-limits/check.sh
```

## トラブルシュート

- `401 Unauthorized`: `cd backend && npx wrangler whoami` で token を refresh
- `unknown field`: CF GraphQL schema が変わった可能性 → 公式 https://developers.cloudflare.com/analytics/graphql-api/ を確認
- `database_size` が出ない: `npx wrangler d1 info <name> --json` が新しい wrangler で動くか確認
