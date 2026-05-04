# 2026-05-05 Android スケルトン実装

backend + hook が動いた状態で Android アプリ側を着手。Kotlin + Compose + Material 3 のスケルトンを `android/` 以下に構築。

## 完了したこと

### プロジェクト構成
- `android/` 配下に Gradle KTS + Version Catalog (`gradle/libs.versions.toml`) でプロジェクトを構築
- AGP 8.7.3、Kotlin 2.0.21、Compose BOM 2024.12.01、Firebase BOM 33.7.0、Ktor 3.0.2
- Compose Compiler plugin (`org.jetbrains.kotlin.plugin.compose`) を Kotlin 2.0+ の標準パターンで導入
- minSdk 26 / targetSdk 35 / compileSdk 35 / JDK 17
- パッケージ: `com.tachibanayu24.ccremote`

### 実装したコンポーネント

**UI（Compose）**
- `MainActivity`: edge-to-edge 化、通知権限リクエスト、Setup/Home 切り替え
- `SetupScreen`: Backend URL + Shared Secret 入力 → `/health` 疎通確認 → device 登録
- `HomeScreen`: 設定 / device_id / FCM token のステータスカード、テスト通知ボタン、設定リセット
- `theme/`: Clawd 風オレンジ `#E76F35` のダーク palette、monospace を要所で適用、Material 3 `darkColorScheme`
- 両画面の冒頭に Clawd ASCII (`▐▛███▜▌` ...) を Compose Text で描画して Claude Code 公式感

**通知**
- `CcRemoteMessagingService` (FirebaseMessagingService): data push 受信、`onNewToken` で backend 再登録、`onMessageReceived` で type に応じて通知を組み立て
- `NotificationFactory`: 承認用通知（`approval` チャネル, HIGH）と情報通知（`info` チャネル, DEFAULT）を生成。承認用は Approve / Deny の action button 付き
- `ApprovalActionReceiver` (BroadcastReceiver): action タップを `goAsync()` で受けて backend POST、通知をキャンセル

**データ層**
- `ConfigStore`: DataStore Preferences で `backend_url`, `shared_secret`, `device_id` を永続化（device_id は初回 UUID 生成）
- `BackendClient` (Ktor + OkHttp engine): `/health`, `/v1/devices/register`, `/v1/approvals/:id/respond`, `/v1/notifications` を呼ぶ。Bearer token は `defaultRequest` でヘッダ付与
- `MainViewModel`: 設定保存時に `/health` でバリデーション → DataStore 保存 → FCM token 取得 → device 登録 まで一連で実行

**リソース**
- アプリアイコン: ピクセルアート風 Clawd 様シルエット（独自）。Adaptive icon foreground は 8x8 グリッドで創作、background は単色オレンジ
- 通知小アイコン: 白シルエット版（`ic_clawd`）
- アクションアイコン: Material 風 check / close
- バックアップ・データ抽出ルールで `cc_remote_config` を除外（共有秘密が cloud backup に乗らないように）

## 未完了（ユーザー側で実機確認が必要）

- Android Studio で `android/` を開いて Gradle Sync（wrapper jar が自動生成される）
- `google-services.json` を `android/app/` 直下に配置
- 実機で起動 → Setup 画面で Backend URL + Shared Secret 入力
- 「テスト通知を送る」で FCM 経由の通知到達確認
- PC 側で hook を `~/.claude/settings.json` に登録 → 実 Claude Code セッションで承認フローのフル E2E

## 設計上のメモ

### 「Claude Code 公式感」の出し方
- ダーク背景 + Clawd オレンジ単色のミニマル palette
- monospace フォント（`FontFamily.Monospace`）を ID / URL / ラベル等に適用してターミナル感
- ASCII の Clawd を Compose Text として直接画面に描画（CLI と統一感）
- アイコンも box-drawing character の輪郭を pixel art として再構成、ベタ塗り Anthropic 風

### Anthropic 知財との距離
- Clawd 公式素材（CLI に出るアスキーアート、SNS 公開イラスト等）は repo にコミットしない
- アプリのピクセル絵は独自に組んだベクター。Clawd を「意識した類似デザイン」のレベル
- public repo として fork されても Anthropic 商用素材を再配布しない

### Compose Compiler plugin
Kotlin 2.0+ では `kotlinComposerCompiler` 同梱ではなく独立 plugin (`org.jetbrains.kotlin.plugin.compose`) が必要。version catalog で `kotlin-compose` として管理。

### POST_NOTIFICATIONS 権限
Android 13+ は実行時許可が必要。MainActivity で `enableEdgeToEdge()` の後にチェックして `ActivityResultContracts.RequestPermission()` でリクエスト。

## 残タスク（このセッションで完了しない）

- 実機ビルド検証（AS で Sync → ビルド → 実機 install）
- `google-services.json` 配置（ユーザー側）
- フル E2E テスト
- 通知履歴一覧画面（Phase 2 として）

## 参考

- 全体設計: [`../handover.md`](../handover.md)
- Android setup: [`../../android/README.md`](../../android/README.md)
- 前セッション (backend + hook): [`./2026-05-05_phase0-phase1-backend実装.md`](./2026-05-05_phase0-phase1-backend実装.md)
