# Architecture — claude-code-remote

このプロジェクトの「どこに何があるか」 を 1 ファイルで把握するための地図。 機能追加や読み解き時はまずここを見る。

`handover.md` は時系列の経緯と全体像、 `architecture.md` は静的な構造とモジュール責務の俯瞰、 `sessions/` は個別の意思決定ログ、 という分担。

---

## モジュール責務マップ

```
backend/                     Cloudflare Workers + Hono + D1 + FCM
├── src/
│   ├── index.ts             route mount のみ
│   ├── auth.ts              bearer token middleware
│   ├── db.ts                nowSec / readJson / cleanup* helper
│   ├── fcm.ts               FCM v1 RS256 JWT 署名 + sendFcm
│   ├── push.ts              notify*Request / notify*Resolved (FCM fan-out)
│   ├── format.ts            basename / previewLine / formatElapsed (表示整形)
│   ├── settings.ts          readSettings (D1 + defaults fallback)
│   ├── approvals.ts         approval ドメイン helpers (parse/encode/dismiss/push payload)
│   ├── questions.ts         question ドメイン helpers (parse/encode/dismiss/push payload)
│   ├── types.ts             全 type 定義
│   └── routes/
│       ├── devices.ts       /v1/devices/register
│       ├── approvals.ts     /v1/approvals/* (CRUD + respond + notify + dismiss)
│       ├── questions.ts     /v1/questions/* (CRUD + respond + notify + dismiss + wait)
│       ├── hooks.ts         /v1/hook/{stop,posttool} (PC hook 受け)
│       ├── sessions.ts      /v1/sessions* (list / detail)
│       ├── prompts.ts       /v1/sessions/:sid/prompts + /v1/prompts/:id/delivered
│       ├── settings.ts      /v1/settings (GET / PUT)
│       └── wait.ts          /v1/wait (channel.mjs long-poll、 heartbeat 同居)
└── migrations/0001..0016    schema 履歴

channel/                     MCP channel server (常駐、 CC が spawn)
├── channel.mjs              本体: approval relay + prompt drain + heartbeat
└── lib/
    ├── api.mjs              apiPost + config (BACKEND_URL / SHARED_SECRET)
    ├── session.mjs          readPpidSession + inspectSession (jsonl snapshot)
    └── allowlist.mjs        deriveAllowPattern + appendAllowPattern

hooks/                       per-call hook scripts
├── cc-remote-hook.mjs       Stop / PostToolUse (薄い forwarder)
├── ask-user-question.mjs    PermissionRequest=AskUserQuestion 専用 long-poll
├── spike-aq-probe.mjs       (アーカイブ: 2026-05-17 spike 検証用、本実装後も残置)
└── lib/
    ├── env.mjs              ~/.claude/hooks/.env loader
    ├── cwd.mjs              cwd helpers
    └── jsonl.mjs            jsonl パーサ群 (channel.mjs と hook 両方から import)

android/app/src/main/kotlin/com/tachibanayu24/ccremote/
├── MainActivity.kt          single-Activity、 Compose ナビゲーション
├── CcRemoteApp.kt           Application class
├── data/
│   ├── Models.kt            全 type 定義 (Phase C で分割予定)
│   ├── BackendClient.kt     Ktor HTTP client (OkHttp engine、 singleton)
│   ├── BackendClientHolder.kt  Holder (Config 変更時に再生成)
│   ├── ConfigStore.kt       DataStore による Config 永続化
│   ├── ToolCall.kt          tool_use input の typed accessor
│   └── ApprovalCommandFormatter.kt  Bash/Edit/... の表示用要約
├── notification/
│   ├── CcRemoteMessagingService.kt  FCM dispatcher
│   ├── NotificationFactory.kt   showApproval / showQuestion / showInfo
│   ├── ApprovalPayload.kt    FCM data → ApprovalPayload
│   ├── QuestionPayload.kt    FCM data → QuestionPayload
│   └── ApprovalActionReceiver.kt  通知の Allow/Deny アクションハンドラ
├── ui/
│   ├── MainViewModel.kt     UiState + ナビ + 全画面の data source
│   ├── Screen.kt            sealed class (Home / Detail / Settings)
│   ├── HomeScreen.kt        セッション一覧
│   ├── SessionDetailScreen.kt  チャット + inline approve/answer + prompt input
│   ├── SetupScreen.kt       backend URL + secret 初期設定
│   ├── SettingsScreen.kt    ask_delay / question_ask_delay / stop_threshold + debug
│   ├── ToolCallBlock.kt     tool_use 種別ごとの inline renderer
│   ├── QuestionForm.kt      AskUserQuestion 用の選択肢フォーム
│   ├── ChatMarkdown.kt      markdown レンダ
│   ├── ClawdLogo.kt         背景マスコット
│   ├── code/                CodeBlock + syntax 認識
│   ├── diff/                DiffView + DiffParser
│   └── theme/               Material 3 theme + custom color/typo
└── widget/                  ホームスクリーンウィジェット
```

---

## 4 つのデータフロー

### ① Approval relay (Bash 等の承認)

```
CC -[permission_request MCP notify]-> channel.mjs
                                      ├-[POST /v1/approvals]-> backend -> D1
                                      └-[ask_delay 経過後 /notify]-> FCM -> phone
phone -[POST /v1/approvals/:id/respond]-> backend
                                          ├-> D1 (status=allow|deny)
                                          └-> FCM resolve push
channel.mjs <-[/v1/wait long-poll で verdict]- backend
            └-[permission MCP notify]-> CC (CLI dialog close)

PC 早勝ち: JSONL に tool_result 出る -> channel.mjs が /v1/approvals/:id/dismiss
PostToolUse hook: tool 完了で /v1/hook/posttool -> dismissPendingApprovals
```

### ② Question relay (AskUserQuestion)

```
CC -[PreToolUse=AskUserQuestion fires PermissionRequest hook]-> ask-user-question.mjs
                                      ├-[POST /v1/questions]-> backend -> D1
                                      └-[ask_delay 経過後 /notify]-> FCM -> phone
phone -[POST /v1/questions/:id/respond]-> backend
                                          ├-> D1 (status=resolved, answers)
                                          └-> FCM resolve push
ask-user-question.mjs <-[/v1/questions/:id/wait long-poll]- backend
                      └-[stdout JSON: decision.updatedInput.answers]-> CC (CLI dialog close)

PC 早勝ち: PostToolUse hook が /v1/hook/posttool -> dismissPendingQuestionsBySession
       -> D1 (status=expired) -> /notify は status check で skip
```

### ③ Completion notification (Stop hook)

```
CC -[Stop fires]-> cc-remote-hook.mjs stop
                   └-[POST /v1/hook/stop]-> backend
                                            ├-> D1 (turns insert)
                                            ├-> dismissPendingApprovals + dismissPendingQuestionsBySession (session_id 単位)
                                            └-[if elapsed > stop_threshold]-> FCM -> phone
```

### ④ Prompt inject (phone → CC)

```
phone -[POST /v1/sessions/:sid/prompts]-> backend -> D1 (prompts.queued)
backend <-[/v1/wait long-poll]- channel.mjs
channel.mjs -[POST /v1/prompts/:id/delivered]-> backend (claim)
channel.mjs -[MCP notify: notifications/claude/channel]-> CC (busy 中は attachment 形式)
```

---

## 拡張ガイド: 「どこに何を書くか」

### 新しい interaction type を追加したい (例: file picker、 confirmation dialog 等)

1. backend/migrations に新 table (or 既存テーブル拡張)
2. backend/src/types.ts に request/response type
3. backend/src/<domain>.ts に domain helper (encode/decode/dismiss + push payload)
4. backend/src/routes/<domain>.ts に CRUD + respond + wait + notify route
5. backend/src/push.ts に notify*Request/Resolved
6. backend/src/routes/hooks.ts の PostToolUse path に session-wide dismiss を追加
7. hook 側: MCP channel に流れるなら channel.mjs 拡張、 流れないなら専用 PermissionRequest hook を `hooks/` に新規追加
8. Android:
   - data/Models.kt (Phase C 後はドメイン別ファイル)
   - notification/<Domain>Payload.kt
   - notification/NotificationFactory.kt に show* 関数
   - ui/<domain>/ または ui/ 直下に Composable
   - MainViewModel に action method
9. README.md と docs/handover.md を更新 (= 重要)

### 新しい backend route を追加したい

1. backend/src/types.ts に request/response type
2. backend/src/routes/<name>.ts に Hono app
3. backend/src/index.ts に mount
4. (テスト) `npx tsc --noEmit` + 動作確認

### 新しい Android 画面を追加したい

1. ui/<Name>Screen.kt に Composable
2. ui/Screen.kt の sealed class に新 case
3. MainActivity.kt の `when (screen)` に分岐追加
4. MainViewModel.kt に open*/close* method
5. 必要なら data/ に通信メソッド追加

---

## 用語集

| 語 | 意味 |
|---|---|
| **approval** | Bash/Edit/Write 等 CC が permission を求めるツール。二択 (allow/deny) + always 拡張あり |
| **question** | AskUserQuestion ツール。構造化質問 (1-4 問、 multiSelect 可) |
| **interaction** | approval と question の総称 (= user に何か聞いて応答を受ける流れ) |
| **request_id** | approval / question の D1 row UUID。 hook input の `request_id` は CC 由来 (MCP channel 経由) と backend 由来 (long-poll responder) で同義 |
| **session_id** | CC subprocess を一意に識別する CC 由来の UUID。 `~/.claude/sessions/<ppid>.json` から取得 |
| **first responder wins** | CLI dialog と phone notification が並行で出て、 先に応答した側が tool_result に採用、 もう片方が dismiss される設計 |
| **ask_delay** | 通知を出すまでの遅延 (= 短い CLI 即答時に phone をうるさくしない)。 承認用 `ask_delay_ms` と質問用 `question_ask_delay_ms` を別々に持つ |
| **PostToolUse hook の session-wide dismiss** | `cc-remote-hook.mjs posttool` が session_id 全 pending を expire させる流儀 (= PC 早勝ちで phone UI クリア) |

---

## 参考リンク

- 初期設計: `sessions/2026-05-04_実装方針確定.md`
- Channels 採用: `sessions/2026-05-05_channels方針確定.md`
- AskUserQuestion 設計: `sessions/2026-05-17_AskUserQuestion-spike検証と設計.md`
- 公式 hooks: https://code.claude.com/docs/en/hooks
- Channels: https://code.claude.com/docs/en/channels
