package com.tachibanayu24.ccremote.data

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonObject

/**
 * 全ドメイン横断の data class 置き場。 ドメイン固有 (Approval / Question /
 * Session / Settings) は別ファイル。 ここに置く基準は「複数ドメインから参照
 * されるか、 ドメインを持たない infrastructure か」。
 */

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
data class PromptCreateRequest(val text: String)

@Serializable
data class HookStopRequest(
    val session_id: String,
    val cwd: String,
    val ai_title: String? = null,
    val elapsed_ms: Long? = null,
    val blocks: List<Block> = emptyList(),
)
