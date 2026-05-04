# claude-code-remote

Claude Code 複数セッション運用のための通知・遠隔操作基盤。

## このプロジェクトの目的

詳細は `README.md` および `docs/handover.md` を参照。要点:

- 自作 Android アプリ + ローカルバックエンド + Claude Code hooks の3層構成
- スマホ通知（受信） + 双方向操作（Approve/Deny、追加指示）
- 対象 OS は Android のみ（iOS は対象外）

## ドキュメント参照

Context7 プラグインを使用してライブラリ・フレームワーク・SDK のドキュメントを能動的に参照すること。

- 実装前に必ず最新ドキュメントを確認
- 不明な点があれば Context7 で調査してから回答
- 古い知識に頼らず公式ドキュメントをソースとする

特に以下は最新仕様の確認が必須:

- Claude Code hooks (PreToolUse / Stop / Notification / PostToolUse / SessionStart 等)
- Claude Code Channels (Telegram/Discord/iMessage 公式プラグイン、permission relay)
- Claude Agent SDK (`list_sessions()` 等のセッション API)
- FCM (Firebase Cloud Messaging) v1 API
- Android (Kotlin + Jetpack Compose の現行ベストプラクティス)

## セッションログ

セッションのログは `docs/sessions/` 以下に保存する。

- ファイル名形式: `yyyy-mm-dd_日本語で内容.md`
- 例: `2026-05-04_初期設計と方針決定.md`

## 実装方針メモ

- 言語・フレームワーク:
  - Android = Kotlin + Compose
  - バックエンド = Node (TypeScript) + Cloudflare Workers + Hono
- ストレージ: Cloudflare D1
- 通知配送: FCM v1（Workers の Web Crypto で RS256 JWT 署名）
- 認証: 共有 bearer token 1 種類で PC hook / Android アプリ / Workers backend を結ぶ
- 設計の詳細・監査結果は `docs/handover.md` および `docs/sessions/2026-05-04_実装方針確定.md`
- 既存 OSS の参考実装:
  - [yuuichieguchi/claude-remote-approver](https://github.com/yuuichieguchi/claude-remote-approver) — 承認の遠隔化のみに特化、JS 2,500 行
  - [JessyTsui/Claude-Code-Remote](https://github.com/JessyTsui/Claude-Code-Remote) — Telegram/Email/LINE 経由
  - [chronologos/cc-sessions](https://github.com/chronologos/cc-sessions) — Rust でセッション一覧
