# Cloudflare 無料枠チェック

claude-code-remote は Cloudflare Workers Free + D1 Free で運用している。本書は
無料枠の上限と現在の使用率を把握するための手順、および定期チェックのスナップショット
履歴をまとめる。

## このプロジェクトで使う Cloudflare サービスと無料枠

| サービス | 指標 | 無料枠 | 備考 |
| --- | --- | --- | --- |
| Workers | リクエスト数 | **100,000 / 日** | 超過するとリクエストが拒否される |
| Workers | CPU 時間 | **10 ms / req** | 超過すると `Worker exceeded CPU` エラー |
| Workers | wall-clock duration | 30 秒 / req | long-poll 中もここに含まれる |
| Workers | サブリクエスト | 50 / req | FCM 送信、外部 fetch 等 |
| Workers Logs | invocation logs | **200,000 events / 日 (3 日保持)** | `[observability]` 有効化で全 req の CPU/duration/status/URL が記録される |
| D1 | rows read | **5,000,000 / 日** | クエリ数ではなく行数で課金 |
| D1 | rows written | **100,000 / 日** | hooks の書き込み頻度に直結 |
| D1 | ストレージ | 5 GB / アカウント全体 | 全 DB の合算 |
| D1 | DB 数 | 10 | |

参考: <https://developers.cloudflare.com/workers/platform/pricing/> /
<https://developers.cloudflare.com/d1/platform/pricing/>

FCM (Firebase Cloud Messaging) は別ベンダーだが本プロジェクトで使用中。FCM v1 は
事実上無制限 (公式に明文化されたレート上限はないが、爆発的送信は弾かれる)。
心配なら Firebase Console > プロジェクト設定 > Cloud Messaging から送信統計を確認。

## チェック手順 (手動)

### A. スキル経由 (推奨)

このリポジトリには `.claude/skills/check-cf-limits/` スキルがある。Claude Code 内で:

```
/check-cf-limits
```

または「無料枠チェックして」「使用量どう？」のような自然文で起動する。
スキルは `check.sh` を走らせ、本書の「計測ログ」セクション先頭にスナップショットを
追記する。

### B. シェルから直接

```bash
.claude/skills/check-cf-limits/check.sh             # 人間向けテーブル
.claude/skills/check-cf-limits/check.sh --json      # 機械可読 JSON
```

事前に `npx wrangler whoami` でログイン済みであること。OAuth トークンが期限切れ
(401 Unauthorized) の場合は、もう一度 `npx wrangler whoami` を走らせて refresh。

### C. ダッシュボード手動確認

スキルが壊れた / 自動化が信用できない時はダッシュボードを直接見る。

| 何を見るか | URL |
| --- | --- |
| Workers (claude-code-remote) | <https://dash.cloudflare.com/2ed52fafd3387679d9b97beadf46abee/workers-and-pages/view/claude-code-remote/production/metrics> |
| Workers Logs (route 別 CPU 追い込み) | <https://dash.cloudflare.com/2ed52fafd3387679d9b97beadf46abee/workers-and-pages/view/claude-code-remote/production/observability/logs> |
| D1 (claude-code-remote) | <https://dash.cloudflare.com/2ed52fafd3387679d9b97beadf46abee/workers/d1/databases/claude-code-remote> |
| アカウント全体請求 | <https://dash.cloudflare.com/2ed52fafd3387679d9b97beadf46abee/billing> |

## チェック頻度のおすすめ

- **デプロイ直後**: 設計変更で polling 頻度や DB 書き込みが変わったとき
- **週次**: 何もしていない週でも 1 回は走らせて trend を蓄積
- **アラート系を組まない理由**: Workers Free にはアラート機能がないので、ログとして
  人間が見るスタイルにしている。気になったら Workers Paid ($5/月) に移行検討。

## 過去のインシデント

| 日付 | 内容 | 解決コミット |
| --- | --- | --- |
| 2026-05-07 | Workers requests 129,064/日 (枠 100k) と D1 rows_written 157,042/日 (枠 100k) を同時に超過。channel.mjs の polling 3 種が原因 | `943987e` (long-poll `/v1/wait` への統合) |

## 計測ログ

最新が一番上。スキル `check-cf-limits` が自動で追記する。

### 2026-05-17 22:06 JST — 要監視 (D1 writes が前回比 2.4 倍に上昇、Workers は引き続き余裕)

- Workers 24h: **18,843 / 100,000 req (18.8%)** / CPU P99 **7,399 μs** / errors 0
- D1 24h: rows R/W = **27,726 / 52,334** (writes **52.3%** of 100k → WATCH 圏)
- DB size: 5.04 MB (5GB 中 0.1%、前回 1.81 MB から約 2.8 倍)
- 過去 7 日のピーク: 2026-05-16 requests=17,635 (17.6%) / D1 writes=47,240 rows (47.2%)
- 所見: D1 writes が 5/13 の 21.4% → 5/17 24h 集計で 52.3% に上昇。直近の変更
  `3532e57 (ask_delay 中の dismiss 通知)` で `/v1/approvals/:id/dismiss` の書き込みが
  増えた可能性が高い (channel.mjs から expired 通知のたびに UPDATE が走る)。
  5/16 ピークの 47k rows/日が継続すると 100k 枠の半分を常用することになるので、
  dismiss の書き込みパスが本当に必要かレビュー推奨。
- CPU P99 は今日 7,399 μs で前回 (9,998 μs) より改善。ただし 5/11 (14,574 μs)、
  5/13 (10,565 μs)、5/16 (10,509 μs) と 10ms 上限超の日が断続的に出続けているので
  Workers Observability の outlier 監視は継続。

### 2026-05-13 01:45 JST — 余裕あり (前回スナップショットからほぼ無変動)

- Workers 24h: **9,837 / 100,000 req (9.8%)** / CPU P99 **9,963 μs** / errors 0
- D1 24h: rows R/W = **101,352 / 21,992** (writes 22.0% of 100k, reads は 5M 枠の 2%)
- DB size: 1.83 MB (5GB 中 0.04%)
- 過去 7 日のピーク: 2026-05-07 requests=129,064 (129.1%, 解決済みインシデント `943987e`)
- 所見: 前回 (約 9 分前) と同じ傾向で安定。CPU P99 が 9,963 μs と 10ms 上限ギリギリ
  なのは継続中。5/11 の CPU P99 14,574 μs は依然として上限超だが errors 0 のまま。
  D1 writes は 21.9% / day で余裕、reads も 100k 行/日で 5M 枠の 2% に留まる。
  新規の重い処理を追加する時のみ要注意、それ以外は通常運用で問題なし。

### 2026-05-13 01:36 JST — 余裕あり (現状ベースライン記録)

- Workers 24h: **9,548 / 100,000 req (9.5%)** / CPU P99 **9,998 μs** / errors 0
- D1 24h: rows R/W = **97,599 / 21,450** (writes 21.4% of 100k)
- DB size: 1.81 MB (5GB 中 0.04%)
- 過去 7 日のピーク: 2026-05-07 requests=129,064 (129.1%, 解決済みインシデント)
- 所見: long-poll 化以降は安定。ただし **CPU P99 が 10ms 上限ギリギリ** (9,998 μs ≒ 9.998 ms)
  の日が複数。重い処理を追加する時は要注意。5/11 は CPU P99 14,574 μs と上限超え
  だが errors 0 で動いていた — Workers Free の CPU は burst 超過を許容する模様だが、
  保証ではないので継続観察。
- D1 writes が 5/8 に 62,557 rows (62.6%) まで上がっている。hooks の書き込み回数を
  これ以上増やすと枠ヒットの可能性。

<!-- 新しいエントリはここの上に追加 -->
