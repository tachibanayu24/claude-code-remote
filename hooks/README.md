# hooks — PC 側 hook スクリプト

Claude Code の hook イベントで起動し、Workers backend に POST する Node スクリプト群。
追加 npm 依存ゼロ（`fetch` built-in）。

このディレクトリには **2 本の hook スクリプト**がある:

| スクリプト | hook event | モード/役割 |
|---|---|---|
| `cc-remote-hook.mjs` | **Stop** / **PostToolUse** | `stop` = 応答完了通知、`posttool` = pending dismiss |
| `ask-user-question.mjs` | **PermissionRequest** (`AskUserQuestion` matcher) | 質問 (question) を phone にリレーして answers を待つ |

> **承認 (approval) は hook では扱わない。** Bash / Edit / Write 等の permission リレーは
> 常駐 MCP channel server (`channel/channel.mjs`) が直接処理する。hook が扱うのは
> 「完了通知」「pending dismiss」「AskUserQuestion (question)」のみ。
> approval と question の使い分けは [`../CLAUDE.md`](../CLAUDE.md) のドメイン用語、
> 全体像は [`../docs/architecture.md`](../docs/architecture.md) を参照。

## 動作要件

- Node.js 18+（`fetch` built-in、npm 依存ゼロ）
- macOS / Linux

## セットアップ

### 1. スクリプトを `~/.claude/hooks/` に配置

`lib/` ごとシンボリックリンク（リポジトリ更新が即反映される）が楽:

```sh
mkdir -p ~/.claude/hooks
ln -s "$(pwd)/cc-remote-hook.mjs"   ~/.claude/hooks/cc-remote-hook.mjs
ln -s "$(pwd)/ask-user-question.mjs" ~/.claude/hooks/ask-user-question.mjs
ln -s "$(pwd)/lib"                   ~/.claude/hooks/lib
```

### 2. `.env` を作成

```sh
cp .env.example ~/.claude/hooks/.env
chmod 600 ~/.claude/hooks/.env   # 自分だけ読める権限に
$EDITOR ~/.claude/hooks/.env
```

中身（`backend/.dev.vars` の `SHARED_SECRET` と一致させる）:

```
CC_REMOTE_BACKEND_URL=https://claude-code-remote.<your-subdomain>.workers.dev
CC_REMOTE_SHARED_SECRET=<backend と同じ値>
```

### 3. `~/.claude/settings.json` に hook を登録

```json
{
  "hooks": {
    "Stop": [{
      "hooks": [{
        "type": "command",
        "command": "node ~/.claude/hooks/cc-remote-hook.mjs stop",
        "timeout": 10
      }]
    }],
    "PostToolUse": [{
      "hooks": [{
        "type": "command",
        "command": "node ~/.claude/hooks/cc-remote-hook.mjs posttool",
        "timeout": 5
      }]
    }],
    "PermissionRequest": [{
      "matcher": "AskUserQuestion",
      "hooks": [{
        "type": "command",
        "command": "node ~/.claude/hooks/ask-user-question.mjs",
        "timeout": 120
      }]
    }]
  }
}
```

`PermissionRequest` の `matcher` は `AskUserQuestion` 限定。これ以外の tool の permission
（Bash / Edit / Write 等）は hook ではなく channel server がリレーするので、ここには
書かない。

## モードの挙動

| スクリプト / モード | 用途 | 出力 |
|---|---|---|
| `cc-remote-hook.mjs stop` | Stop hook（応答完了時） | jsonl から最終スナップショットを読み `POST /v1/hook/stop`。閾値判定・通知整形・FCM push・dismiss は backend 側。fire-and-forget |
| `cc-remote-hook.mjs posttool` | PostToolUse hook | `POST /v1/hook/posttool`。同 session の pending approval / question を session-wide で dismiss（CLI 早勝ち時に phone 通知をクリア）|
| `ask-user-question.mjs` | PermissionRequest hook（`AskUserQuestion` 発火時） | `POST /v1/questions` → long-poll で answers を待つ → `hookSpecificOutput.decision.updatedInput.answers` を返して CLI ローカル dialog を自動 close。phone 無応答ならタイムアウトで CLI 通常選択に fallback |

`stop` モードは jsonl の `end_turn` 出現を最大 1.5s ポーリングしてから読む（CC の書き込みバッファ
で最終ナレーションが欠けるのを防ぐ）。詳細は `cc-remote-hook.mjs` の冒頭コメント参照。

## 注意: 起動側の channel ダイアログ

approval リレー / プロンプト注入は channel server (`channel/channel.mjs`) が担うが、
それは CC を `--dangerously-load-development-channels server:cc-remote` で起動し、
**起動時の確認ダイアログを `1` で通過した場合のみ**有効。通過しないと channel 未登録で、
hook 由来の Stop 通知だけが届く状態になる（[`../README.md`](../README.md) 「起動」節を参照）。

## トラブルシュート

- `cc-remote-hook: config missing` / `[cc-remote] config missing`
  → `~/.claude/hooks/.env` の `CC_REMOTE_BACKEND_URL` / `CC_REMOTE_SHARED_SECRET` が空
- `POST … HTTP 401`
  → `CC_REMOTE_SHARED_SECRET` が backend の `SHARED_SECRET` と不一致
- 完了通知が来ない
  → settings.json の Stop hook 登録、`.env` のパス・権限を確認
- スマホからのプロンプトが効かない（通知は来る）
  → 起動時の channel 確認ダイアログを `1` で通過したか確認（最頻の原因）
