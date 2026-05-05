package com.tachibanayu24.ccremote.data

import kotlinx.serialization.Serializable

data class Config(
    val backendUrl: String,
    val sharedSecret: String,
    val deviceId: String,
)

@Serializable
data class DeviceRegisterRequest(
    val device_id: String,
    val fcm_token: String,
    val name: String? = null,
)

@Serializable
data class ApprovalRespondRequest(
    val decision: String,
    val device_id: String? = null,
    val add_to_allowlist: Boolean = false,
)

@Serializable
data class HookStopRequest(
    val session_id: String,
    val cwd: String,
    val ai_title: String? = null,
    val elapsed_ms: Long? = null,
    val full_message: String? = null,
)

@Serializable
data class PromptCreateRequest(val text: String)

@Serializable
data class Session(
    val cwd: String,
    val session_id: String? = null,
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
data class ToolUsage(val name: String, val count: Int)

@Serializable
data class Turn(
    val id: String,
    val user_prompt: String? = null,
    val assistant_text: String? = null,
    val tool_summary: List<ToolUsage> = emptyList(),
    val elapsed_ms: Long? = null,
    val ended_at: Long,
)

@Serializable
data class PendingApproval(
    val id: String,
    val tool_name: String,
    val description: String = "",
    val input_preview: String = "",
    val created_at: Long,
)

@Serializable
data class QueuedPrompt(
    val id: String,
    val text: String,
    val created_at: Long,
)

@Serializable
data class SessionDetailHeader(
    val cwd: String,
    val session_id: String? = null,
    val project_name: String,
    val ai_title: String? = null,
    val current_prompt: String? = null,
    val current_assistant_text: String? = null,
    val last_heartbeat: Long,
    val jsonl_mtime: Long? = null,
)

@Serializable
data class SessionDetailResponse(
    val session: SessionDetailHeader,
    val turns: List<Turn>,
    val pending_approvals: List<PendingApproval> = emptyList(),
    val queued_prompts: List<QueuedPrompt> = emptyList(),
)
