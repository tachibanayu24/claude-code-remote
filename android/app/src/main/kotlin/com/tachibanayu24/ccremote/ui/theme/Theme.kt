package com.tachibanayu24.ccremote.ui.theme

import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color

private val DarkColors = darkColorScheme(
    primary = Orange,
    onPrimary = Color(0xFF1A0E08),
    primaryContainer = DeepOrange,
    onPrimaryContainer = OrangeLight,
    secondary = OrangeMuted,
    onSecondary = Color.White,
    tertiary = OrangeLight,
    onTertiary = Color(0xFF1A0E08),
    background = Bg,
    onBackground = OnBg,
    surface = Surface,
    onSurface = OnBg,
    surfaceVariant = SurfaceVariant,
    onSurfaceVariant = OnBgMuted,
    outline = Color(0xFF3A3A3A),
    error = Deny,
    onError = Color.White,
)

@Composable
fun CcRemoteTheme(content: @Composable () -> Unit) {
    MaterialTheme(
        colorScheme = DarkColors,
        typography = AppTypography,
        content = content,
    )
}
