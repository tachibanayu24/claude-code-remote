package com.tachibanayu24.ccremote.ui.theme

import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.googlefonts.Font
import androidx.compose.ui.text.googlefonts.GoogleFont
import com.tachibanayu24.ccremote.R

/**
 * Downloadable Google Font provider — Play Services delivers the font at
 * runtime, so the APK doesn't carry the .ttf. The first cold launch may
 * fall through to `FontFamily.Monospace` for a few hundred ms while the
 * download completes; subsequent runs hit the on-device cache.
 */
private val GoogleFontProvider = GoogleFont.Provider(
    providerAuthority = "com.google.android.gms.fonts",
    providerPackage = "com.google.android.gms",
    certificates = R.array.com_google_android_gms_fonts_certs,
)

private val FiraCode = GoogleFont("Fira Code")

/**
 * Code font used by CodeBlock / DiffView / ChatMarkdown's inline code spans.
 * Falls back to the system monospace if the download fails or hasn't landed
 * yet (Compose hands `FontFamily.Monospace` glyphs in the meantime).
 */
val CodeFontFamily: FontFamily = FontFamily(
    Font(googleFont = FiraCode, fontProvider = GoogleFontProvider, weight = FontWeight.Normal),
    Font(googleFont = FiraCode, fontProvider = GoogleFontProvider, weight = FontWeight.Bold),
)
