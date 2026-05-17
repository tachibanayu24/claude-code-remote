# claude-code-remote

Claude Code を複数セッション並行運用するときの通知・遠隔操作基盤。Android アプリ + Cloudflare Workers backend + Claude Code Channels / hooks の3層構成。

## アーキテクチャ

PC で動く Claude Code に **MCP channel server (常駐)** と **PermissionRequest hook (per-call)** をぶら下げて、Cloudflare Workers backend を経由してスマホと双方向に喋らせる。3 層構成。

```mermaid
flowchart LR
  subgraph PC["PC (Claude Code 起動環境)"]
    direction TB
    CC["Claude Code<br/>(CLI)"]
    CH["channel.mjs<br/><i>MCP channel server (常駐)</i>"]
    AQ["ask-user-question.mjs<br/><i>PermissionRequest hook (per-call)</i>"]
    HK["cc-remote-hook.mjs<br/><i>Stop / PostToolUse hooks</i>"]
    JSONL[("session jsonl<br/>~/.claude/projects/...")]
    CC <-->|"stdio (MCP)"| CH
    CC -. "PreToolUse=AskUserQuestion" .-> AQ
    CC -. "fires on event" .-> HK
    CC -.->|"writes"| JSONL
    CH -.->|"polls"| JSONL
    HK -.->|"reads on Stop"| JSONL
  end

  subgraph CLOUD["Cloudflare Workers"]
    API["Hono REST API"]
    D1[("D1<br/>sessions / approvals / questions /<br/>prompts / settings / devices /<br/>turns / notifications")]
    FCM["FCM v1 dispatcher"]
    API <--> D1
    API --> FCM
  end

  subgraph PHONE["Android app"]
    UI["MainActivity<br/>(SessionDetailScreen に<br/>inline approve / answer)"]
    SVC["Firebase Messaging<br/>Service"]
    SVC --> UI
  end

  CH <==>|"① approval relay<br/>② prompt inject<br/>③ heartbeat / 進捗"| API
  AQ ==>|"④ question relay<br/>(per-call long-poll)"| API
  HK ==>|"Stop 完了通知 /<br/>PostToolUse dismiss"| API
  UI <==>|"REST<br/>(bearer token)"| API
  FCM ==>|"data push"| SVC
```

**channel server (`channel/channel.mjs`) が担当する 3 つの flow** + **AskUserQuestion 専用 hook**:

| | 方向 | 中身 |
|---|---|---|
| **① Approval relay** | CC ↔ phone | `notifications/claude/channel/permission_request` を受けて backend `/v1/approvals` に POST → FCM push → スマホで Allow/Deny → poll で verdict 取得 → `notifications/claude/channel/permission` で返す |
| **② Prompt inject** | phone → CC | スマホが backend に積んだ prompt を 2s 周期で drain → `notifications/claude/channel` で CC のコンテキストに `<channel>` タグとして流し込む |
| **③ Heartbeat / 進捗** | CC → phone | 5〜15s 周期で transcript jsonl を読んで `current_prompt` / `current_blocks` を backend に upsert。スマホは backend を読んでリアルタイム表示 |
| **④ Question relay** (`hooks/ask-user-question.mjs`) | CC ↔ phone | AskUserQuestion 発火時に PermissionRequest hook として起動。 backend `/v1/questions` に POST → long-poll で answers を待つ → `hookSpecificOutput.decision.updatedInput.answers` を返して CC ローカル dialog を自動 close |

①② は Channels protocol 標準、③ は channel server プロセスの中で勝手にやってるオマケ、**④ は CC が AskUserQuestion を MCP channel に流さない事実が確定したため (2026-05-17 spike 検証参照)、独立 hook 経路にした**。

**hooks は別系統**。tool 実行後の dismiss と、ターン終了時の完了通知 push を担当 (`hooks/cc-remote-hook.mjs`)。channel server と独立。

### 承認 / 質問フロー (first responder wins)

PC のローカルダイアログとスマホの通知が **同時に live** で、先に答えた方が勝つ:

```mermaid
sequenceDiagram
  autonumber
  participant CC as Claude Code
  participant Rly as channel.mjs / ask-user-question.mjs
  participant BE as Backend (D1)
  participant PH as Android app

  CC->>Rly: permission_request (approval) /<br/>PermissionRequest hook (question)
  Note over CC: ローカルダイアログを表示 (live)
  Rly->>BE: POST /v1/approvals or /v1/questions
  Note over BE: ask_delay 経過後に push
  BE->>PH: FCM push (inline カード or 通知)

  alt PC で先に答えた
    Note over CC: ローカルで答え
    Note over BE: PostToolUse hook 経由で session-wide dismiss<br/>→ pending row が expired 化
    BE->>PH: FCM dismiss
  else Phone で先に答えた
    PH->>BE: POST /v1/approvals/:id/respond or /v1/questions/:id/respond
    Rly->>BE: poll → verdict / answers
    Rly->>CC: permission notification (approval) /<br/>updatedInput.answers (question)
    Note over CC: ローカルダイアログを自動 close
  end
```

**承認の「常に許可」**: phone で「Always allow」を選ぶと `add_to_allowlist=true` で返り、channel.mjs が tool パターンを `<cwd>/.claude/settings.local.json` に追記する (Bash / WebFetch のみ)。

**質問の遅延**: 承認用 `ask_delay_ms` (短め、default 10s) と質問用 `question_ask_delay_ms` (長め、default 30s) は D1 `settings` テーブルで個別に持つ。 質問は user が CLI で選択肢を読む時間を見越して長めの遅延を入れる設計。 Settings 画面で個別調整可。

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
