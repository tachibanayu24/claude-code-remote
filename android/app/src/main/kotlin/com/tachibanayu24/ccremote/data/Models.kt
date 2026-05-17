package com.tachibanayu24.ccremote.data

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonObject

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
    val blocks: List<Block> = emptyList(),
)

@Serializable
data class PromptCreateRequest(val text: String)

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
data class ToolUsage(val name: String, val count: Int)

/**
 * One block of assistant output. `kind` discriminates:
 *  - `"text"`     → `text` populated; other fields null.
 *  - `"tool_use"` → `name` + `input` populated; `text` null.
 * Single class (rather than a sealed hierarchy) keeps kotlinx.serialization
 * happy without a custom discriminator setting.
 */
@Serializable
data class Block(
    val kind: String,
    val text: String? = null,
    val name: String? = null,
    val input: JsonObject? = null,
)

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
data class PendingApproval(
    val id: String,
    val tool_name: String,
    val description: String = "",
    val input_preview: String = "",
    val created_at: Long,
    // 旧 backend 互換: フィールドが無い場合は旧挙動 (常に Always を出す) に倒す。
    val supports_always: Boolean = true,
)

@Serializable
data class QueuedPrompt(
    val id: String,
    val text: String,
    val created_at: Long,
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
data class PendingQuestion(
    val id: String,
    val questions: List<AskQuestion>,
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

/**
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
data class NotificationSettings(
    val ask_delay_ms: Long,
    val stop_threshold_ms: Long,
    val updated_at: Long = 0L,
)

@Serializable
data class NotificationSettingsUpdate(
    val ask_delay_ms: Long? = null,
    val stop_threshold_ms: Long? = null,
)
