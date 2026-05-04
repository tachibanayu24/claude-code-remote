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
    val reason: String? = null,
    val device_id: String? = null,
    val add_to_allowlist: Boolean = false,
)

@Serializable
data class TestNotificationRequest(
    val session_id: String,
    val cwd: String,
    val project_name: String,
    val kind: String,
    val title: String,
    val body: String? = null,
)
