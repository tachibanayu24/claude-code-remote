package com.tachibanayu24.ccremote.widget

import kotlinx.serialization.Serializable

/**
 * Snapshot the widget renders from. Persisted as a JSON string in Glance's
 * Preferences-backed state per widget instance, refreshed by
 * [WidgetSyncWorker] on FCM events / periodic ticks / launches.
 *
 * Only the fields the widget actually shows are kept here so the persisted
 * blob stays small and we don't tie the widget to the full `Session` shape
 * (which carries fields like `cwd` / `current_prompt` we never render).
 */
@Serializable
data class WidgetState(
    val sessions: List<WidgetSession> = emptyList(),
    val lastSyncMs: Long = 0L,
    val error: String? = null,
)

@Serializable
data class WidgetSession(
    val sessionId: String,
    /** Repo / project name. Rendered small + muted on the first line. */
    val repo: String,
    /** ai_title or `#id6` fallback. Rendered as the primary label. */
    val title: String,
    /** working | awaiting_approval | idle (closed is filtered out upstream) */
    val state: String,
)
