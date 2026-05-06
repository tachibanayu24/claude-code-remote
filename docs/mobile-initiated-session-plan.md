# Mobile-Initiated Session Plan (Future Work)

モバイル端末から **新規 Claude Code セッションを起動** できるようにする構想。MVP（通知 + Approve/Deny + 追加指示）が落ち着いたあとに着手する想定。

> **⚠️ 本ドキュメントは予備調査メモ**
> 2026-05-05 時点の会話で出たアイデアを書き留めただけのもの。実装着手前に **以下の点で密な再調査が必須**:
> - Claude Agent SDK の `list_sessions()` / 起動 API の最新仕様（`-p` 以外の選択肢）
> - macOS launchd LaunchAgent の現行ベストプラクティス（power management, sleep, network reachability）
> - Cloudflare Workers での long-poll / WebSocket (Durable Objects) のコスト・制約
> - PTY 経由で `claude` を起動して継続対話を成立させる実証
> - Android 側 UX（プロジェクト選択・prompt 入力・PC オフライン時のハンドリング）の具体化
>
> 対象 OS は **macOS のみ**（プロジェクト全体方針として Android クライアント + macOS PC を想定）。Linux/Windows ホストは out of scope。

## 1. ゴール

「**過去に claudec を使ったことのあるプロジェクト一覧から選択して新規セッションを開始**」できる UX をモバイル側に持たせる。外出先で「あ、あの repo であれ試したい」を即起動できる体験。

## 2. アーキテクチャ概要

```
[Android]                [Workers backend]              [PC daemon (新規)]
  ├ GET /v1/projects ─────► D1 から DISTINCT cwd        (一覧表示は daemon 不要)
  │        ◄──── [{cwd, lastUsed, count}, ...]
  │
  └ POST /v1/spawn ────────► queue                       ◄─── long-poll
            {cwd, prompt}                                       │
                                                                ▼
                                              spawn('claude', [...flags, '-p', prompt], {cwd})
                                              起動後は既存 hook/channel が
                                              通知・assistant_text を phone に流す
```

ポイント:
- **「一覧」だけなら daemon 不要**。backend D1 の既存 `sessions.cwd` から DISTINCT を取るだけ。
- **「spawn」フェーズで初めて daemon が登場**。CC とは独立した常時起動プロセス。
- 起動後の通知・追加指示は既存仕組み（hooks + channel server）にそのまま乗る。

## 3. プロジェクト一覧のソース候補

| ソース | 範囲 | 取得難度 | 備考 |
|---|---|---|---|
| backend D1 | **過去に cc-remote 経由したプロジェクトのみ** | 楽（既存テーブル流用） | 「claudec を使ったことがある」のセマンティクスに最も素直 |
| `~/.claude/projects/` 走査 | CC 全体（claudec 以外含む） | 中（PC daemon が必要） | path encoding が `/` → `-` で曖昧。JSONL 内 `cwd` を信頼するのが安全 |
| Agent SDK `list_sessions()` | CC 全体 | 低（公式 API） | CLAUDE.md でも参照必須に挙げられている。最もきれい |

**第一案: backend D1**。要件と一致し、phone と backend だけで完結する。

## 4. PC Daemon の構成

### ファイル構成

```
daemon/
  daemon.mjs                       # 本体 (~150 行、依存ゼロで書ける見込み)
  com.cc-remote.daemon.plist       # launchd LaunchAgent 登録ファイル
  install.sh                       # plist を bootstrap するワンライナー
  uninstall.sh                     # bootout するワンライナー
```

ランタイムは Node（channel.mjs と揃える）。`fetch` / `child_process.spawn` は標準で揃うので **npm 依存ゼロで書ける**見込み。

### 動作モデル

「常駐 long-poll loop + ジョブ受信で子プロセス spawn」だけ。状態は持たない。

```js
// 概念コード — 実装時は再検証
while (true) {
  const res = await fetch(`${BACKEND}/v1/daemon/poll?device=${HOST}`, {
    headers: { Authorization: `Bearer ${SECRET}` },
    signal: AbortSignal.timeout(30_000),
  })
  if (res.status === 204) continue
  const { jobId, cwd, prompt } = await res.json()

  if (!isAllowedCwd(cwd)) { reportFail(jobId, 'cwd not allowed'); continue }

  const child = spawn(
    'claude',
    ['--dangerously-load-development-channels', 'server:cc-remote', '-p', prompt],
    { cwd, detached: true, stdio: ['ignore', logFd, logFd] },
  )
  child.unref()
  await reportStarted(jobId, child.pid)
}
```

設計ポイント:
- **long-poll が heartbeat 兼任**: backend は `last_poll_at` を握っておけば「PC オンライン？」を Android に返せる。
- **fire-and-forget**: spawn 後の CC は既存 hook/channel が `current_assistant_text` / approval を流す。daemon は子プロセスを追跡しない。`detached + unref` で daemon が落ちても CC は生き残る、逆も然り。
- **状態ゼロ**: 全部 backend D1 に置く。daemon 自体は再起動安全。

### allowlist

cwd の妥当性チェックは 2 案:
- **A. backend で持つ**: D1 の `sessions.cwd` から DISTINCT を取って「過去に使ったことのある repo のみ」。
- **B. PC daemon 側に config**: `~/.config/cc-remote/allowed-cwds.txt` をユーザが手で編集。

初期実装は **A デフォルト + B でオーバーライド可** で十分そう。

## 5. macOS で常時起動させる方法

**launchd LaunchAgent** に登録。`~/Library/LaunchAgents/com.cc-remote.daemon.plist` を 1 枚置けば OS が面倒を見る。

### LaunchAgent vs LaunchDaemon

- **LaunchAgent** (~/Library/LaunchAgents): ユーザログイン後に起動、ユーザ権限。**こちらを採用**。
- **LaunchDaemon** (/Library/LaunchDaemons): boot 直後に root で起動。今回は不要、むしろリスク。

理由: `~/.claude/` / `claude.ai login` セッション / user の `claude` バイナリに依存するので per-user agent が自然。

### plist の骨子（要再検証）

```xml
<key>Label</key>           <string>com.cc-remote.daemon</string>
<key>ProgramArguments</key>
<array>
  <string>/usr/local/bin/node</string>     <!-- Node のフルパス -->
  <string>/Users/yuto/.../daemon/daemon.mjs</string>
</array>
<key>RunAtLoad</key>       <true/>
<key>KeepAlive</key>       <true/>          <!-- クラッシュ時自動再起動 -->
<key>StandardErrorPath</key><string>/Users/yuto/.claude/cc-remote-daemon.log</string>
<key>StandardOutPath</key>  <string>/Users/yuto/.claude/cc-remote-daemon.log</string>
<key>EnvironmentVariables</key>
<dict>
  <key>BACKEND_URL</key>     <string>https://...</string>
  <key>CC_REMOTE_SECRET</key><string>...</string>
</dict>
```

### 操作コマンド

```bash
# 登録
launchctl bootstrap gui/$UID ~/Library/LaunchAgents/com.cc-remote.daemon.plist

# 停止
launchctl bootout gui/$UID/com.cc-remote.daemon

# 状態
launchctl list | grep cc-remote
launchctl print gui/$UID/com.cc-remote.daemon

# 強制再起動（plist 編集後の反映）
launchctl kickstart -k gui/$UID/com.cc-remote.daemon
```

### ライフサイクル別の挙動（要実機検証）

| イベント | 期待挙動 |
|---|---|
| ログイン | RunAtLoad で自動起動 |
| プロセス異常終了 | KeepAlive で自動再起動（ThrottleInterval=10s で暴走防止） |
| 蓋閉じスリープ | プロセス凍結、long-poll は OS が切る |
| スリープ復帰 | プロセス resume → 次の loop iteration で再 poll |
| OS 再起動 | 次のログインで自動復活 |
| ログアウト | プロセス停止（Agent はログインセッション帰属） |
| OS major update | `~/Library` 配下なので plist は保持される（要検証） |

### sleep の現実問題（一番のクセモノ）

launchd ではどうにもならない領域:

| シナリオ | 挙動 | 緩和策 |
|---|---|---|
| 蓋開けっぱでデスクトップ放置 | OS スリープ後にネット切れる | `pmset noidle` / `caffeinate -i` 常駐 |
| 蓋閉じ + 電源接続 | Power Nap 有効ならネットは生きるが CPU は寝る | システム設定 → バッテリー → アダプタ接続時スリープしない + Power Nap on |
| 蓋閉じ + バッテリー | 完全スリープ、確実に届かない | 諦める or 母艦化 |
| ネット切替 | long-poll 失敗 → loop で即再接続 | 自動回復想定 |

外出中も確実に動かすなら **Mac mini か Linux box を母艦** にする運用判断が必要。本プロジェクトは macOS only なので Mac mini 母艦 + ノート PC 副次、が現実解。

### 開発時の運用

plist 常駐だと print デバッグが面倒なので、開発中は bootout して手で:

```bash
BACKEND_URL=... CC_REMOTE_SECRET=... node daemon/daemon.mjs
```

完成したら plist に戻す。

## 6. 実装順序の提案

1. backend に `GET /v1/projects` エンドポイント（D1 集約 only。当日できる）
2. Android にプロジェクト一覧画面（読み取り only。起動できなくても価値ある）
3. PC daemon 雛形 + `POST /v1/spawn` + `GET /v1/daemon/poll`
4. launchd plist + install スクリプト
5. Android に prompt 入力 → start ボタン
6. 任意 path 手入力、resume、PC online 状態表示などの改善

`1〜2` だけでも UX として刺さる。`3 以降` を別 phase に切り出せるのが設計上のメリット。

## 7. ハマりそうなポイント / 要再調査

実装着手時に深掘りすべき項目（このメモは表面しか見ていない）:

1. **launchd の PATH 問題**: `claude` バイナリのフルパス指定 or `zsh -lc "claude ..."` ラップ。GUI セッションの PATH を継がない仕様の現状確認。
2. **`-p` モードの限界**: ワンショットなので追加指示の体験と噛み合わない可能性。継続対話には PTY 経由で起動 + stdin リレーが必要。**ここは要 PoC**。
3. **Agent SDK の活用余地**: SDK で起動した方がフックの噛み合わせが良い可能性。要確認。
4. **複数 PC の扱い**: `device=${HOST}` で識別する方針だが、phone 側 UI で「どの PC？」の選択は将来要件。
5. **スリープ復帰時の long-poll 挙動**: TCP keepalive、network change 検知、再接続戦略の実機検証。
6. **secret 管理**: hooks/.env と plist EnvironmentVariables で同じ token を 2 箇所に置くか、共通 source に集約するか。chmod 600 plist は実用的か。
7. **Cloudflare Workers の long-poll コスト**: 30s 接続 × 常時 = CPU 時間課金への影響。WebSocket (Durable Objects) との比較。
8. **basename 重複**: `~/Workspace/foo/api` と `~/work/foo/api` で UI 表示衝突。フルパス tooltip / 親 dir 併記。
9. **PTY 経由起動の実装難度**: phase 2 として切り出すか、初手で踏み込むか。`node-pty` 等の依存が daemon の "依存ゼロ" 方針と衝突する点も含めて検討。

## 8. 規模感（楽観見積もり、要再評価）

- daemon.mjs: ~150 行（hooks の `cc-remote-hook.mjs` と同程度）
- backend 追加: `POST /v1/spawn` `GET /v1/daemon/poll` `GET /v1/projects` の 3 本
- launchd 仕込み + 動作確認: 1 時間以内
- Android UI 一覧: 半日〜1 日
- Android UI prompt 入力 + start: 半日〜1 日

ただし **PTY 継続対話に踏み込む場合は別物の規模になる**。phase 切り出し必須。
