package com.tachibanayu24.ccremote.ui.code

import android.util.Log
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.tachibanayu24.ccremote.ui.theme.CodeFontFamily
import dev.snipme.highlights.Highlights
import dev.snipme.highlights.model.BoldHighlight
import dev.snipme.highlights.model.ColorHighlight
import dev.snipme.highlights.model.SyntaxLanguage
import dev.snipme.highlights.model.SyntaxThemes

/**
 * Render a self-contained code block with syntax highlighting and horizontal
 * scroll. `language = null` falls through to plain monospace (no spans).
 *
 * Usage: pass either an explicit [SyntaxLanguage] or the info string from a
 * markdown fence via [resolveLanguage]. The block sits in a tinted surface
 * to read as a code "card" against the chat background, but doesn't draw its
 * own border — the surface tint and corner radius are enough.
 */
@Composable
fun CodeBlock(
    code: String,
    language: SyntaxLanguage?,
    modifier: Modifier = Modifier,
) {
    val annotated = remember(code, language) { highlight(code, language) }
    val scroll = rememberScrollState()
    Surface(
        modifier = modifier.fillMaxWidth(),
        shape = RoundedCornerShape(6.dp),
        color = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.55f),
    ) {
        // Inner SelectionContainer so the user can long-press on the code
        // to copy it. Putting selection at this level (rather than relying
        // on an outer one in the parent) keeps the gesture region tight to
        // the visible code area — the parent can still wrap narration etc.
        // in its own SelectionContainer without conflict.
        SelectionContainer {
            Text(
                text = annotated,
                modifier = Modifier
                    .horizontalScroll(scroll)
                    .padding(horizontal = 12.dp, vertical = 10.dp),
                fontFamily = CodeFontFamily,
                style = MaterialTheme.typography.bodySmall,
                softWrap = false,
                color = MaterialTheme.colorScheme.onSurface,
            )
        }
    }
}

/**
 * Run Highlights and project its `ColorHighlight` / `BoldHighlight` spans
 * onto an AnnotatedString. The library returns RGB (no alpha) so we OR with
 * 0xFF000000 before handing to Compose's [Color].
 *
 * Off-by-one defensiveness: clamp span ends to code length — Highlights'
 * tokenizer occasionally returns ranges past the input on truncated inputs
 * we feed it from preview/diff hunks, and Compose throws on out-of-range.
 */
internal fun highlight(code: String, language: SyntaxLanguage?): AnnotatedString {
    if (language == null || language == SyntaxLanguage.DEFAULT || code.isEmpty()) {
        return AnnotatedString(code)
    }
    val highlights = runCatching {
        Highlights.Builder()
            .code(code)
            .language(language)
            .theme(SyntaxThemes.atom(darkMode = true))
            .build()
            .getHighlights()
    }.getOrElse { e ->
        // Plain-text fallback is safe, but silent failures hide real bugs
        // (Highlights tokenizer crashes, OOM on very long lines, ...).
        // Log so they surface in logcat without breaking the render.
        Log.w("CodeBlock", "highlight failed for $language", e)
        return AnnotatedString(code)
    }

    return buildAnnotatedString {
        append(code)
        for (h in highlights) {
            val start = h.location.start.coerceIn(0, code.length)
            val end = h.location.end.coerceIn(start, code.length)
            if (start == end) continue
            when (h) {
                is ColorHighlight -> addStyle(
                    SpanStyle(color = Color(h.rgb or 0xFF000000.toInt())),
                    start, end,
                )
                is BoldHighlight -> addStyle(
                    SpanStyle(fontWeight = FontWeight.Bold),
                    start, end,
                )
            }
        }
    }
}
