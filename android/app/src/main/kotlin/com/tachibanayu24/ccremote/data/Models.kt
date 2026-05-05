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
data class Session(
    val cwd: String,
    val session_id: String? = null,
    val project_name: String,
    val ai_title: String? = null,
    val state: String,  // working | awaiting_approval | idle | closed
    val pending_count: Int = 0,
    val heartbeat_age_sec: Long = 0L,
    val jsonl_age_ms: Long? = null,
)

@Serializable
data class SessionsResponse(val sessions: List<Session>)
