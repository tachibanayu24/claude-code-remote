package com.tachibanayu24.ccremote.data

import kotlinx.serialization.Serializable

/**
 * Backend `/v1/settings` で扱う通知タイミング設定。 D1 `settings` テーブル
 * 1 行と対応。 phone Settings 画面で個別調整される。
 */

@Serializable
data class NotificationSettings(
    val ask_delay_ms: Long,
    val stop_threshold_ms: Long,
    // AskUserQuestion 用の遅延。 承認 (ask_delay_ms) が CLI 即応答前提なのに対し、
    // 質問は選択肢を読む時間が要るので default 30s と長め。 古い backend
    // からの読み出しでフィールドが無い場合は default にフォールバック。
    val question_ask_delay_ms: Long = 30_000L,
    val updated_at: Long = 0L,
)

@Serializable
data class NotificationSettingsUpdate(
    val ask_delay_ms: Long? = null,
    val stop_threshold_ms: Long? = null,
    val question_ask_delay_ms: Long? = null,
)
