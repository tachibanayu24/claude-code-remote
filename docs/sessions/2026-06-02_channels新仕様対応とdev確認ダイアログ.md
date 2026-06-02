# 2026-06-02: Channels 新仕様対応（dev 確認ダイアログ）と docs/instructions 完璧化

## TL;DR

Claude Code を **2.1.160 (Opus 4.8)** に上げた後「`claude-rc` でスマホからのプロンプトを
受け付けない（通知は来る）」症状。調査の結果 **リポジトリのコードは健全**で、真因は CC 側に
追加された **`--dangerously-load-development-channels` 起動時の確認ダイアログ**だった。
これを `1`（Enter）で通過しないと channel が登録されず、プロンプト注入・承認リレーが無効になる。
ダイアログは research preview の意図的なセキュリティゲートで、設定での恒久スキップは不可。
方針: **dev フラグ + ダイアログ通過を正式手順として受け入れ**、docs と channel.mjs の
instructions を整備。plugin 化は個人 Max ではダイアログを消せないため見送り。

## 症状と真因

- 症状: 「通知などは来るが、モバイルからのプロンプトを受け付けない」
- 真因: 起動時の新ダイアログ
  ```
  WARNING: Loading development channels
  ❯ 1. I am using this for local development
    2. Exit
  ```
  - `1` で通過 → channel 登録 → `Listening for channel messages from: server:cc-remote`
  - Esc / Exit → **channel 未登録のまま起動**（プロンプト注入・承認リレー全滅）
  - Stop hook 通知は channel 非依存なので生き残る → 「通知は来るがプロンプトは効かない」に一致
- リポジトリ作成時（`2026-05-05_channels方針確定.md`）にはこのダイアログが無かった。これが
  「インタフェースが変更されて claude-rc がうまくいかなくなった」の正体。

## 調査で確認した事実（CC 2.1.160 / 個人 Claude Max）

- プロトコル 3 method（`notifications/claude/channel` / `.../permission_request` /
  `.../permission`）+ capability（`claude/channel` + `claude/channel/permission`）は
  バイナリに健在で channel.mjs と完全一致。
- 起動構文 `--dangerously-load-development-channels server:cc-remote` は公式
  channels-reference のテスト用コマンドと一致（不変）。`--dangerously-...` / `--channels` は
  どちらも `<servers...>` を取る variadic。
- `~/.claude/sessions/<ppid>.json`（CC が pid キーで書く {sessionId, cwd}）機構は 2.1.160 でも
  動作。channel.mjs の `readPpidSession()` は ppid 一致で解決成功。
- **end-to-end 注入を実証**: backend `/v1/sessions/:sid/prompts` に投入したプロンプトが
  channel.mjs の `/v1/wait` drain → `/delivered` claim → MCP emit → CC 注入まで通り、
  Claude が応答した（注入トークンの派生出力で確証）。
- アカウントは Claude Max（個人）→ org policy `channelsEnabled` ゲートは非該当（Pro/Max は
  org チェックを skip）。

## zero-dialog 化の検証（不採用）

- **`--managed-settings '{...}'` フラグ**で allowlist を注入してダイアログ回避を試みたが、
  **「Listening と表示されるのに inbound ハンドラ未登録（not on the approved channels
  allowlist）でプロンプトをサイレント破棄」**＝動くように見えて静かに壊れる。不採用。
  （channel.mjs は emit 成功ログを出すが CC 側が drop。`--managed-settings` は "SDK use only"
  の hidden flag で、custom channel の allowlist gate には効かない）
- システム `managed-settings.json`（`/Library/Application Support/ClaudeCode/`）は **要 sudo**・
  Team/Enterprise 向け機能で個人 Max では未保証・セキュリティダイアログ誘発の可能性。見送り。
- 結論: **個人 Max でカスタム channel を確実に動かす唯一の公式経路は dev フラグ**。ダイアログは
  仕様。恒久回避は Anthropic 公式 marketplace 登録（`--channels plugin:cc-remote@<mp>`）のみ。

## 方針決定

1. dev フラグ + ダイアログ `1` 通過を**正式手順として受け入れ**（システム変更ゼロ・確実）。
2. plugin 化は**見送り**（個人 Max ではダイアログを消せず、ローカル用途のメリット無し。将来
   marketplace 申請する時の布石にしかならない）。
3. docs 全面更新 + channel.mjs の instructions 改善を実施。

## 変更内容

- `channel/channel.mjs`
  - MCP `instructions` を改善: inbound メッセージは `<channel source="cc-remote"
    origin="phone">` でラップされて届くので、「**これはユーザーの直接指示。端末で打たれたのと同様に
    実行せよ。reply tool は無い**」と明記（モバイル指示の解釈を安定化）。
  - prompt 注入 meta の `source: 'phone'` → `origin: 'phone'` に変更（CC が `source` を
    サーバー名から自動付与するため重複属性になるのを回避）。
- `README.md` 起動節: 確認ダイアログ通過手順（`1` 必須・Esc 不可）を明記。エイリアス例を
  `claude-rc` に統一。
- `hooks/README.md`: 全面刷新。旧記述（存在しない `pretool`/`notify` モード、PreToolUse
  approval 方式）を現行（`cc-remote-hook.mjs` の `stop`/`posttool` + `ask-user-question.mjs` の
  PermissionRequest + 承認は channel.mjs 経由）に修正。

## 将来 TODO（任意）

- ダイアログを完全に消したい場合のみ: cc-remote を正式 plugin 化し Anthropic 公式 marketplace
  へ申請（security review 後 `--channels plugin:cc-remote@<mp>` で dev フラグ不要）。
- research preview ゆえ `--channels` 構文・protocol は変わり得る。CC 大型 update 後は
  本ドキュメントの起動手順とプロトコル整合を再確認すること。
