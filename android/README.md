# android — claude-code-remote Android アプリ

Kotlin + Jetpack Compose + Material 3 で構築。FCM data push を受信し、ロック画面通知から Approve / Deny を直接タップできる。

## 必要なもの

- Android Studio Ladybug 以降（AGP 8.7+ / Kotlin 2.0+ / Compose Compiler plugin 対応）
- JDK 17（Android Studio に同梱）
- Android SDK 26〜35
- 自分の Android 端末（実機推奨。エミュレータでも FCM は動く）
- Firebase プロジェクトの `google-services.json`（前段で取得済み）

## セットアップ手順

### 1. Android Studio で開く

```
File → Open → claude-code-remote/android を選択
```

初回 Sync 時に Gradle wrapper jar が自動生成される。深掘りせず "Trust Project" でそのまま Sync 完了を待つ。

### 2. `google-services.json` を配置

```sh
cp ~/Downloads/google-services.json android/app/google-services.json
```

このファイルは `.gitignore` に登録済みなのでコミットされない（個人用 Firebase プロジェクトの ID + API キーが入っている）。

### 3. ビルド & 実機インストール

USB デバッグを有効にした端末を接続 → AS の Run ボタン（▶︎）でビルド & インストール & 起動。

### 4. アプリでセットアップ

起動すると Setup 画面が出る:

- **Backend URL**: `https://claude-code-remote.<your-subdomain>.workers.dev`
- **Shared Secret**: `backend/.dev.vars` の `SHARED_SECRET` の値

「接続して登録」をタップすると、`/health` で疎通確認 → FCM トークン取得 → backend に device 登録。

### 5. 動作確認

ホーム画面で「テスト通知を送る」ボタン → backend が FCM 送信 → 端末に通知が届けば一連の経路 OK。

PC 側で hook 経由の承認待ちが起きると、通知の Approve / Deny ボタンから直接応答できる（アプリ起動なし）。

## アーキテクチャ

```
MainActivity (Compose)
  ├─ SetupScreen          初回設定
  └─ HomeScreen           設定済み時のステータス画面

CcRemoteMessagingService  FCM 受信 → NotificationFactory 呼び出し
ApprovalActionReceiver    通知ボタン → backend POST
NotificationFactory       data 種別ごとに通知を組み立てる
ConfigStore               DataStore Preferences で設定永続化
BackendClient             Ktor HTTP クライアント
```

## デザイン方針

- ダークテーマ固定（Material 3, `darkColorScheme`）
- アクセントカラー: Clawd 風オレンジ `#E76F35`
- monospace を要所で使用（URL / token / ID）
- アプリアイコン: ピクセルアート風 Clawd 様シルエット（独自イラスト、Anthropic 公式素材は不使用）
- セットアップ画面・ホーム画面の冒頭に Clawd ASCII を Compose Text で描画
