# claude-code-remote

Claude Code を複数セッション並行運用するときの通知・遠隔操作基盤。Android アプリ + Cloudflare Workers backend + Claude Code Channels (permission relay) の3層構成。

## 構成

```
Claude Code (PC)
  ├── Native permission dialog (CLI で従来どおり操作可)
  └── MCP channel server (channel/channel.mjs, stdio subprocess)
        ↓ permission_request
        ↓ HTTP POST
  Cloudflare Workers backend (backend/)
        ↓ FCM push
  Android app (android/)  ← Allow / Deny ボタンタップ
        ↓ HTTP POST
  Cloudflare Workers backend
        ↓ poll で channel server が verdict 取得
  MCP channel server emits notifications/claude/channel/permission
        ↓
  Claude Code が verdict 適用 (or PC で先に答えてればそっち)
```

PC native dialog と Phone の通知は **同時に live**。先に答えた方が勝ち、もう一方は自動的にキャンセルされる（Channels protocol が組み込みで処理）。

## 起動

```bash
claude --dangerously-load-development-channels server:cc-remote
```

エイリアス推奨:

```bash
alias claudec='claude --dangerously-load-development-channels server:cc-remote'
```

`--dangerously-load-development-channels` は Channels research preview の機能で、approved allowlist に載るまで必要。Pro/Max ユーザは claude.ai login + v2.1.81+ で使える。

## 設定ファイル

- **`~/.claude.json`** — `mcpServers` に `cc-remote` 登録（channel server 起動）
- **`~/.claude/hooks/.env`** — Backend URL + shared secret (chmod 600)
- **`~/.claude/settings.json`** — Stop / PostToolUse hooks

## ディレクトリ

| Path | 用途 |
|---|---|
| `channel/` | MCP channel server (Node.js, permission relay) |
| `backend/` | Cloudflare Workers + Hono + D1 + FCM v1 |
| `android/` | Kotlin + Jetpack Compose アプリ |
| `hooks/` | Stop / PostToolUse 用の hook script |
| `docs/` | 設計ノート、セッションログ |

## 主要設計

- 言語: Android = Kotlin + Compose / Backend = TypeScript + Hono
- ストレージ: Cloudflare D1
- 通知: FCM v1 (Web Crypto で RS256 JWT 署名)
- 認証: 共有 bearer token 1種類
- Permission relay: Claude Code Channels (research preview)

詳細は `docs/handover.md` および `docs/sessions/` 参照。
