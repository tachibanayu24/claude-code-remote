# claude-code-remote

Claude Code を複数セッション並行運用するときの通知・遠隔操作基盤。

## 動機

VS Code のターミナルタブで Claude Code を複数並行実行していると、入力待ち / 権限承認待ち / 処理完了 に気づきづらい。スマホ（Android）+ Fitbit に通知を飛ばしたい。最終的には承認の遠隔操作や追加指示送信もスマホから行いたい。

## 現状の到達点（2026-05-04）

- ntfy.sh (`https://ntfy.sh/claude-code-tachibanayu24`) でスマホ通知が動く状態
- Android + Fitbit へのミラー通知も確認済み
- iOS は集中モード等の制約で不安定（Android に絞って進める）

## 進む方向

自作 Android アプリ + ローカルバックエンド構成で、以下を実現する:

1. 通知（応答完了 / 権限承認待ち / マイルストーン）
2. スマホから Approve/Deny を直接押す（PreToolUse hook で待機 → stdout で decision を返す方式）
3. 複数セッション一覧ダッシュボード
4. （余裕があれば）スマホから追加プロンプト投入

詳細は `docs/handover.md` 参照。
