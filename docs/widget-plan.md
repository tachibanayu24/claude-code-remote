# Widget Plan (Future Work)

MVP（通知 + Approve/Deny）完成後に検討するウィジェット系機能のアイデア集。実装の優先順位付けや個別の設計はここでは行わず、**何ができそうか** を網羅。

## 前提

- Android のみ
- 個人利用、Pixel 系端末 1 台 + Fitbit
- backend（Cloudflare Workers + D1）はすでに動いている前提
- データソース: backend に新規 GET エンドポイントを足せばだいたい賄える

## 1. Jetpack Glance（ホーム画面ウィジェット）

Android のホーム画面ウィジェットは **Jetpack Glance**（Compose for Widgets）が現行のベストプラクティス。

### サイズ別の使い分け

| サイズ | 用途 |
|---|---|
| 2x1 (small) | 「未承認件数バッジ」/「直近セッション状態」 |
| 4x2 (medium) | アクティブセッション一覧（プロジェクト名 + 状態アイコン） |
| 4x4 (large) | 上記 + 直近通知のフィード |

### インタラクション
- タップ → アプリ起動（特定の承認画面に直行）
- アクションボタン（GlanceModifier の clickable）→ backend POST で `/approvals/:id/respond` を即叩く
- ウィジェット内 1-tap Approve は「最新の承認待ち 1 件」に対しては実装可能、複数同時時は最新を優先

## 2. Live Updates（Android 14+ ongoing notification）

Android 14 で本格導入された **Live Updates**（リッチな ongoing notification）でセッション稼働状況を常駐表示。

- 通知シェードに「Claude Code: 3 セッション稼働中 / 1 件承認待ち」を pin
- ホームに戻らず即視認できる
- 承認待ち発生時に Live Update を更新して赤バッジ + Approve/Deny アクションを差し込む
- ウィジェットより視認頻度が高い（通知シェードは 1 日に何度も開く）

## 3. ロック画面ウィジェット（Android 12+）

Android 12 でロック画面ウィジェット API（`AppWidgetProviderInfo.WIDGET_CATEGORY_KEYGUARD`）が拡張された。

- 「未承認件数」だけのミニウィジェットをロック画面に置けば、画面を点けるだけで状態確認可能
- ただしロック画面でのアクション実行はセキュリティ的に制限あり（生体認証経由）

## 4. Fitbit / Wear OS

### Fitbit
- Fitbit SDK は CompanionApp + Watch app の 2 パート構成、開発エコシステムが Android アプリと別
- 現状の Fitbit ミラー通知（Android 通知の転送）が動いている範囲では十分
- **Complication（時計画面の小ウィジェット）に承認待ち件数を出す** のは別アプリ実装が必要、コスパ次第で

### Wear OS（持ってる場合）
- Tile API でウィジェット相当を実装可能
- Compose for Wear OS が現行ベストプラクティス
- ロック画面ウィジェット相当の使い方ができる

## 5. データ要件

ウィジェット用に backend に追加するエンドポイント案:

```
GET /summary
  → {
      pending_approvals: number,
      active_sessions: [
        { session_id, project_name, last_event_at, status }
      ],
      recent_notifications: [...]
    }
```

ウィジェットからの polling は Android の制約上 15〜30 分間隔が現実的。リアルタイム性が必要なら FCM data push でウィジェット更新トリガを送る方式（既存 push 経路を流用）。

## 6. 優先順位（あくまで案）

1. **Live Updates**（通知シェードに常駐）— 視認頻度・実装コスト共に良い
2. **小ウィジェット**（未承認件数）— 1-tap Approve の体験が良い
3. **Fitbit Complication** — 効果は大きいが実装コスト高
4. **大ウィジェット / Wear OS** — 必要性次第

## 7. 既存アーキとの整合性

- すべて backend（Workers + D1）と FCM をそのまま流用
- アプリ側に Glance Worker / Tile Service を追加するだけ
- 設計上の追加検討は不要
