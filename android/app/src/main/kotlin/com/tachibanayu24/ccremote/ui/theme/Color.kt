package com.tachibanayu24.ccremote.ui.theme

import androidx.compose.ui.graphics.Color

// Clawd-inspired warm palette — matches Claude Code terminal vibe.
val Orange = Color(0xFFE76F35)
val OrangeMuted = Color(0xFFC85F2E)
val OrangeLight = Color(0xFFFFB088)
val DeepOrange = Color(0xFF8C3E1F)

// Slate-purple dusk: warmer than pure black, lets the orange Clawd accent
// read against the backdrop without fighting it. The verticalGradient runs
// from `BgGradientTop` (slightly lit at the top, like twilight) down to
// `BgGradientBottom` (nearly black, like a horizon). `Bg` itself is a midpoint
// reference used wherever Compose needs a single Color (e.g. the Material
// colorScheme.background).
val BgGradientTop = Color(0xFF15161F)
val BgGradientBottom = Color(0xFF06070C)
val Bg = Color(0xFF0B0C12)
val Surface = Color(0xFF1B1C26)
val SurfaceVariant = Color(0xFF272838)
val OnBg = Color(0xFFE5E5E5)
val OnBgMuted = Color(0xFFB5B5B5)

val Allow = Color(0xFF7BC97A)
val Deny = Color(0xFFE57373)
