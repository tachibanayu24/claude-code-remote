package com.tachibanayu24.ccremote.notification

import com.tachibanayu24.ccremote.data.AskQuestion
import kotlinx.serialization.json.Json

/**
 * AskUserQuestion 用 FCM payload。 承認 (`ApprovalPayload`) と並列の概念だが、
 * 構造はかなり違う: 質問は複数 (1〜4 件) で、 各質問に複数 option があり、
 * multiSelect 指定もある。 通知の Body に詰めて action buttons だけで回答する
 * ことは不可能なので、 タップで `QuestionActivity` を開いて Compose UI で回答する
 * という方針を取る。
 *
 * `questions` フィールドは FCM data に JSON 文字列で詰めてあるので parse。
 */
data class QuestionPayload(
    val requestId: String,
    val sessionId: String,
    val project: String,
    val sessionLabel: String,
    val questions: List<AskQuestion>,
) {
    val notificationId: Int get() = requestId.hashCode()

    val titleHead: String get() = sessionLabel.ifBlank { project }

    val title: String get() = "❓ $titleHead"

    val subText: String? get() = if (sessionLabel.isNotBlank()) project else null

    /**
     * 通知の Body に表示する 1 行サマリ。最初の質問の header (なければ
     * question 本文) を出すだけ。複数質問あっても通知段階では「タップして開く」
     * 前提なので詳細は要らない。
     */
    val notificationBody: String
        get() {
            val first = questions.firstOrNull() ?: return ""
            val head = first.header.ifBlank { first.question }
            return if (questions.size > 1) "$head (他 ${questions.size - 1} 問)" else head
        }

    companion object {
        private val jsonParser = Json { ignoreUnknownKeys = true }

        fun fromFcm(data: Map<String, String>): QuestionPayload? {
            val requestId = data["request_id"] ?: return null
            val questionsRaw = data["questions"] ?: return null
            val questions = runCatching {
                jsonParser.decodeFromString<List<AskQuestion>>(questionsRaw)
            }.getOrNull() ?: return null
            if (questions.isEmpty()) return null
            return QuestionPayload(
                requestId = requestId,
                sessionId = data["session_id"].orEmpty(),
                project = data["project"].orEmpty(),
                sessionLabel = data["session_label"].orEmpty(),
                questions = questions,
            )
        }
    }
}
