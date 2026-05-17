package com.tachibanayu24.ccremote.data

import kotlinx.serialization.Serializable

/**
 * 承認 (Bash / Edit / Write 等の permission_request) ドメイン。
 * 質問 (AskUserQuestion) は QuestionModels.kt 側。
 */

@Serializable
data class ApprovalRespondRequest(
    val decision: String,
    val device_id: String? = null,
    val add_to_allowlist: Boolean = false,
)

@Serializable
data class PendingApproval(
    val id: String,
    val tool_name: String,
    val description: String = "",
    val input_preview: String = "",
    val created_at: Long,
    // 旧 backend 互換: フィールドが無い場合は旧挙動 (常に Always を出す) に倒す。
    val supports_always: Boolean = true,
)
