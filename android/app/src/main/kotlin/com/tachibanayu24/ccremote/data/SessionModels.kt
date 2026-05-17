package com.tachibanayu24.ccremote.data

import kotlinx.serialization.Serializable

/**
 * セッション (一覧 / 詳細) ドメイン。 backend `/v1/sessions*` レスポンスの形。
 */

@Serializable
data class Session(
    val session_id: String,
    val cwd: String,
    val project_name: String,
    val ai_title: String? = null,
    val current_prompt: String? = null,
    val state: String,  // working | awaiting_approval | idle | closed
    val pending_count: Int = 0,
    val heartbeat_age_sec: Long = 0L,
    val jsonl_age_ms: Long? = null,
)

@Serializable
data class SessionsResponse(val sessions: List<Session>)

@Serializable
data class Turn(
    val id: String,
    val user_prompt: String? = null,
    val blocks: List<Block> = emptyList(),
    val tool_summary: List<ToolUsage> = emptyList(),
    val elapsed_ms: Long? = null,
    val ended_at: Long,
)

@Serializable
data class SessionDetailHeader(
    val session_id: String,
    val cwd: String,
    val project_name: String,
    val ai_title: String? = null,
    val current_prompt: String? = null,
    val current_blocks: List<Block> = emptyList(),
    val last_heartbeat: Long,
    val jsonl_mtime: Long? = null,
)

@Serializable
data class QueuedPrompt(
    val id: String,
    val text: String,
    val created_at: Long,
)

@Serializable
data class SessionDetailResponse(
    val session: SessionDetailHeader,
    val turns: List<Turn>,
    val pending_approvals: List<PendingApproval> = emptyList(),
    val queued_prompts: List<QueuedPrompt> = emptyList(),
    val pending_questions: List<PendingQuestion> = emptyList(),
)
