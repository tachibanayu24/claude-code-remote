package com.tachibanayu24.ccremote.data

import kotlinx.serialization.Serializable

/**
 * 質問 (AskUserQuestion) ドメイン。 構造化選択肢を持つので承認と schema が違う。
 * 承認 (Bash 等) は ApprovalModels.kt 側。
 *
 * AskUserQuestion ツールの tool_input.questions[] と同じ形を Android 側でも
 * 表現するための data class。 FCM の data payload には JSON 文字列で詰めて
 * 来るので、 QuestionPayload が parse して保持する。
 */

@Serializable
data class AskQuestionOption(
    val label: String,
    val description: String = "",
)

@Serializable
data class AskQuestion(
    val question: String,
    val header: String = "",
    val multiSelect: Boolean = false,
    val options: List<AskQuestionOption> = emptyList(),
)

/**
 * answers map の値: multiSelect=false は string、 multiSelect=true は string[]。
 * kotlinx.serialization は union 型を直接扱えないので、 JsonElement で持って
 * リクエスト送信時に正しい型に変換する。
 */
@Serializable
data class QuestionRespondRequest(
    val answers: kotlinx.serialization.json.JsonObject,
    val device_id: String? = null,
)

@Serializable
data class PendingQuestion(
    val id: String,
    val questions: List<AskQuestion>,
    val created_at: Long,
)
