# hooks — PC hook script

Claude Code が hook イベント（PreToolUse / Stop / Notification）を起こすたびに呼ばれる Node スクリプト。Workers backend に POST して通知 / 承認待ちを処理する。

## 動作要件

- Node.js 18+ （`fetch` が built-in、追加 npm 依存ゼロ）
- macOS / Linux

## セットアップ

### 1. スクリプトを `~/.claude/hooks/` に配置

シンボリックリンク（リポジトリ更新が即反映される）:

```sh
mkdir -p ~/.claude/hooks
ln -s "$(pwd)/cc-remote-hook.mjs" ~/.claude/hooks/cc-remote-hook.mjs
chmod +x cc-remote-hook.mjs
```

または単純にコピー:

```sh
mkdir -p ~/.claude/hooks
cp cc-remote-hook.mjs ~/.claude/hooks/
chmod +x ~/.claude/hooks/cc-remote-hook.mjs
```

### 2. `.env` を作成

```sh
cp .env.example ~/.claude/hooks/.env
chmod 600 ~/.claude/hooks/.env  # 自分だけ読める権限に
$EDITOR ~/.claude/hooks/.env
```

中身:

```
CC_REMOTE_BACKEND_URL=https://claude-code-remote.<your-subdomain>.workers.dev
CC_REMOTE_SHARED_SECRET=<backend と同じ値>
```

`SHARED_SECRET` は `backend/.dev.vars` の `SHARED_SECRET` と同じ値。

### 3. `~/.claude/settings.json` に hook を登録

既存の `hooks` セクションに以下をマージ（無ければ新規作成）:

```json
{
  "hooks": {
    "PreToolUse": [{
      "matcher": "Bash|Edit|Write|MultiEdit|mcp__.*",
      "hooks": [{
        "type": "command",
        "command": "node ~/.claude/hooks/cc-remote-hook.mjs pretool",
        "timeout": 360
      }]
    }],
    "Stop": [{
      "hooks": [{
        "type": "command",
        "command": "node ~/.claude/hooks/cc-remote-hook.mjs stop"
      }]
    }],
    "Notification": [{
      "hooks": [{
        "type": "command",
        "command": "node ~/.claude/hooks/cc-remote-hook.mjs notify"
      }]
    }]
  }
}
```

`matcher` は承認対象の tool 名にマッチさせる正規表現。デフォルトは Bash / Edit / Write / MultiEdit / 全 MCP tool を承認対象にしている。Read 等の安全 tool は対象外（通知過多回避）。

`timeout` は Claude Code 側の hook タイムアウト（秒）。スクリプト内のポーリングタイムアウト（300秒）より少し長く設定。

## モードの挙動

| モード | 用途 | 出力 |
|---|---|---|
| `pretool` | PreToolUse hook | stdout に `permissionDecision` の JSON |
| `stop` | Stop hook（応答完了時） | fire-and-forget の通知送信 |
| `notify` | Notification hook（待機時） | fire-and-forget の通知送信 |

### pretool の決定ルート

1. backend に承認リクエストを POST
2. 1秒間隔で `/v1/approvals/:id` を最大 5分ポーリング
3. ステータスが `allow` / `deny` になったら、対応する `permissionDecision` を stdout
4. タイムアウトしたら `ask` を出力 → Claude Code の通常承認プロンプトに fallback
5. 設定不備 / backend 到達不能の場合も `ask` で fallback

→ スマホ放置・電波なし・backend ダウンでも Claude Code が固まらない設計。

## 動作確認

```sh
# pretool: stdin に hook event JSON を流す
echo '{"session_id":"test","cwd":"/tmp","tool_name":"Bash","tool_input":{"command":"ls"}}' \
  | node cc-remote-hook.mjs pretool
# → stdout に permissionDecision の JSON が出る
#   （別端末から POST /v1/approvals/:id/respond で allow/deny を返さないと 5分待つ）
```

## トラブルシュート

- `cc-remote-hook: cannot read ~/.claude/hooks/.env`
  → `.env` のパス・読み権限を確認
- `[cc-remote] config missing`
  → `.env` の `CC_REMOTE_BACKEND_URL` または `CC_REMOTE_SHARED_SECRET` が空
- `[cc-remote] backend POST failed: HTTP 401`
  → `CC_REMOTE_SHARED_SECRET` が backend の `SHARED_SECRET` と一致していない
- `[cc-remote] スマホで応答がなかったため通常確認に戻します`
  → タイムアウト fallback。Android アプリの動作確認 or backend 直接 curl で respond
