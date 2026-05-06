package com.tachibanayu24.ccremote.widget

import android.content.Context
import android.content.Intent
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.DpSize
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.glance.ColorFilter
import androidx.glance.GlanceId
import androidx.glance.GlanceModifier
import androidx.glance.Image
import androidx.glance.ImageProvider
import androidx.glance.LocalContext
import androidx.glance.action.clickable
import androidx.glance.appwidget.GlanceAppWidget
import androidx.glance.appwidget.SizeMode
import androidx.glance.appwidget.action.actionStartActivity
import androidx.glance.appwidget.cornerRadius
import androidx.glance.appwidget.lazy.LazyColumn
import androidx.glance.appwidget.lazy.items
import androidx.glance.appwidget.provideContent
import androidx.glance.background
import androidx.glance.currentState
import androidx.glance.layout.Alignment
import androidx.glance.layout.Box
import androidx.glance.layout.Column
import androidx.glance.layout.Row
import androidx.glance.layout.Spacer
import androidx.glance.layout.fillMaxSize
import androidx.glance.layout.fillMaxWidth
import androidx.glance.layout.padding
import androidx.glance.layout.size
import androidx.glance.layout.width
import androidx.glance.text.FontFamily
import androidx.glance.text.Text
import androidx.glance.text.TextStyle
import androidx.glance.unit.ColorProvider
import com.tachibanayu24.ccremote.MainActivity
import com.tachibanayu24.ccremote.R
import kotlinx.serialization.json.Json

/**
 * Home-screen widget rendering active CC sessions. Stateless: data is loaded
 * by [WidgetSyncWorker] into the per-instance Preferences-backed state and
 * read here. Tapping a row opens the matching session in the app.
 *
 * Two responsive layouts: compact (≈4×2) and tall (≈4×4+). Both share the
 * same composable; LazyColumn scrolls when the list overflows.
 */
class CcRemoteWidget : GlanceAppWidget() {

    override val sizeMode = SizeMode.Responsive(
        setOf(
            DpSize(180.dp, 110.dp),
            DpSize(250.dp, 250.dp),
        ),
    )

    override suspend fun provideGlance(context: Context, id: GlanceId) {
        provideContent {
            val prefs = currentState<Preferences>()
            val state = prefs[STATE_JSON_KEY]
                ?.let { runCatching { JsonCodec.decodeFromString<WidgetState>(it) }.getOrNull() }
                ?: WidgetState()
            WidgetUi(state)
        }
    }
}

internal val STATE_JSON_KEY = stringPreferencesKey("widget_state_json")

internal val JsonCodec = Json { ignoreUnknownKeys = true }

// Hard-coded copies of the colors that already exist in `ui/theme/Color.kt`.
// Glance composables can't import Material Color tokens at runtime (different
// composition root), and lifting the theme palette into a multi-module spot
// would be churn for a 6-color reuse.
private val Surface = Color(0xFF1B1C26)
private val Orange = Color(0xFFE76F35)
private val OnBg = Color(0xFFE5E5E5)
private val OnBgMuted = Color(0xFFB5B5B5)
private val WorkingColor = Color(0xFF4ADE80)
private val AwaitingColor = Color(0xFFFACC15)
private val IdleColor = Color(0xFF94A3B8)

@Composable
private fun WidgetUi(state: WidgetState) {
    Box(
        modifier = GlanceModifier
            .fillMaxSize()
            .background(ColorProvider(Surface))
            .cornerRadius(16.dp)
            .padding(horizontal = 12.dp, vertical = 10.dp),
    ) {
        Column(modifier = GlanceModifier.fillMaxSize()) {
            Header(showSectionLabel = state.sessions.isNotEmpty())
            Spacer(GlanceModifier.size(4.dp))
            if (state.sessions.isEmpty()) {
                EmptyBody()
            } else {
                Body(state.sessions)
            }
        }
    }
}

@Composable
private fun Header(showSectionLabel: Boolean) {
    val context = LocalContext.current
    val openHomeIntent = Intent(context, MainActivity::class.java).apply {
        flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
    }
    Row(
        verticalAlignment = Alignment.CenterVertically,
        modifier = GlanceModifier
            .fillMaxWidth()
            .padding(start = 2.dp, bottom = 2.dp)
            .clickable(actionStartActivity(openHomeIntent)),
    ) {
        Image(
            provider = ImageProvider(R.drawable.ic_clawd),
            contentDescription = "cc-remote",
            colorFilter = ColorFilter.tint(ColorProvider(Orange)),
            modifier = GlanceModifier.size(36.dp),
        )
        if (showSectionLabel) {
            Spacer(GlanceModifier.width(10.dp))
            SectionLabel("active")
        }
    }
}

/**
 * Faded `— active —` caption that sits next to the clawd in the header,
 * mirroring the HomeScreen section separator.
 */
@Composable
private fun SectionLabel(label: String) {
    Text(
        text = "— $label —",
        style = TextStyle(
            color = ColorProvider(OnBgMuted),
            fontFamily = FontFamily.Monospace,
            fontSize = 10.sp,
        ),
    )
}

@Composable
private fun EmptyBody() {
    Box(
        contentAlignment = Alignment.Center,
        modifier = GlanceModifier.fillMaxSize(),
    ) {
        Text(
            text = "no active sessions",
            style = TextStyle(
                color = ColorProvider(OnBgMuted),
                fontFamily = FontFamily.Monospace,
                fontSize = 12.sp,
            ),
        )
    }
}

@Composable
private fun Body(sessions: List<WidgetSession>) {
    LazyColumn(
        modifier = GlanceModifier.fillMaxSize(),
    ) {
        items(sessions, itemId = { it.sessionId.hashCode().toLong() }) { s ->
            SessionRow(s)
        }
    }
}

@Composable
private fun SessionRow(session: WidgetSession) {
    val context = LocalContext.current
    val openIntent = Intent(context, MainActivity::class.java).apply {
        action = MainActivity.ACTION_OPEN_SESSION
        putExtra(MainActivity.EXTRA_SESSION_ID, session.sessionId)
        flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
    }
    Row(
        verticalAlignment = Alignment.CenterVertically,
        modifier = GlanceModifier
            .fillMaxWidth()
            .padding(vertical = 5.dp, horizontal = 4.dp)
            .clickable(actionStartActivity(openIntent)),
    ) {
        StateDot(session.state)
        Spacer(GlanceModifier.width(8.dp))
        Column {
            Text(
                text = session.repo,
                maxLines = 1,
                style = TextStyle(
                    color = ColorProvider(OnBgMuted),
                    fontFamily = FontFamily.Monospace,
                    fontSize = 10.sp,
                ),
            )
            Text(
                text = session.title,
                maxLines = 1,
                style = TextStyle(
                    color = ColorProvider(OnBg),
                    fontFamily = FontFamily.Monospace,
                    fontSize = 12.sp,
                ),
            )
        }
    }
}

@Composable
private fun StateDot(state: String) {
    val color = when (state) {
        "working" -> WorkingColor
        "awaiting_approval" -> AwaitingColor
        else -> IdleColor
    }
    // Glance's Box requires a content lambda; we just want a colored circle,
    // so the slot stays empty.
    Box(
        modifier = GlanceModifier
            .size(8.dp)
            .background(ColorProvider(color))
            .cornerRadius(4.dp),
        content = {},
    )
}
