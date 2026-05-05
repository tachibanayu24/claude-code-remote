package com.tachibanayu24.ccremote.ui

/**
 * Top-level screen the activity is currently rendering. Replaces the
 * ad-hoc booleans (`showSettings`, `selectedCwd != null`) so adding a
 * screen doesn't require touching every conditional in MainActivity.
 */
sealed interface Screen {
    object Home : Screen
    data class Detail(val sessionId: String) : Screen
    object Settings : Screen
}
