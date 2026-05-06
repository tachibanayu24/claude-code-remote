package com.tachibanayu24.ccremote.widget

import android.content.Context
import androidx.glance.appwidget.GlanceAppWidgetManager
import androidx.glance.appwidget.state.updateAppWidgetState
import androidx.glance.appwidget.updateAll
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import com.tachibanayu24.ccremote.data.BackendClientHolder
import com.tachibanayu24.ccremote.data.ConfigStore
import com.tachibanayu24.ccremote.data.Session
import kotlinx.serialization.encodeToString
import java.util.concurrent.TimeUnit

/**
 * Backs the Glance widget with fresh session data. Runs in three modes:
 *  - one-shot on FCM events / widget add / app refresh ([enqueueOnce])
 *  - periodic 15-minute fallback while the widget is on the home screen
 *    ([enqueuePeriodic])
 *  - cancelled when the last widget instance is removed ([cancelPeriodic])
 *
 * Stores a serialized [WidgetState] in Glance's per-instance Preferences.
 * The widget composable reads it back and renders without ever touching the
 * network from its own process.
 */
class WidgetSyncWorker(
    context: Context,
    params: WorkerParameters,
) : CoroutineWorker(context, params) {

    override suspend fun doWork(): Result {
        val ctx = applicationContext
        // Skip silently when the user hasn't completed setup yet — there's
        // nothing to render and no point burning a retry slot for it.
        ConfigStore.current(ctx) ?: return Result.success()
        val client = BackendClientHolder.ensure(ctx) ?: return Result.success()

        return try {
            val active = client.listSessions()
                .filter { it.state != "closed" }
                .map { it.toWidgetSession() }
            val state = WidgetState(
                sessions = active,
                lastSyncMs = System.currentTimeMillis(),
                error = null,
            )
            writeState(state)
            CcRemoteWidget().updateAll(ctx)
            Result.success()
        } catch (t: Throwable) {
            Result.retry()
        }
    }

    private suspend fun writeState(state: WidgetState) {
        val json = JsonCodec.encodeToString(state)
        val mgr = GlanceAppWidgetManager(applicationContext)
        val ids = mgr.getGlanceIds(CcRemoteWidget::class.java)
        ids.forEach { id ->
            updateAppWidgetState(applicationContext, id) { prefs ->
                prefs[STATE_JSON_KEY] = json
            }
        }
    }

    companion object {
        private const val ONCE_NAME = "cc_remote_widget_sync_once"
        private const val PERIODIC_NAME = "cc_remote_widget_sync_periodic"
        private const val PERIODIC_MINUTES = 15L

        private fun networkConstraints() = Constraints.Builder()
            .setRequiredNetworkType(NetworkType.CONNECTED)
            .build()

        /** Run a single sync ASAP. Replaces any pending one-shot run. */
        fun enqueueOnce(context: Context) {
            val req = OneTimeWorkRequestBuilder<WidgetSyncWorker>()
                .setConstraints(networkConstraints())
                .build()
            WorkManager.getInstance(context).enqueueUniqueWork(
                ONCE_NAME,
                ExistingWorkPolicy.REPLACE,
                req,
            )
        }

        /** Keep the widget warm with a periodic refresh while it's installed. */
        fun enqueuePeriodic(context: Context) {
            val req = PeriodicWorkRequestBuilder<WidgetSyncWorker>(
                PERIODIC_MINUTES, TimeUnit.MINUTES,
            )
                .setConstraints(networkConstraints())
                .build()
            WorkManager.getInstance(context).enqueueUniquePeriodicWork(
                PERIODIC_NAME,
                ExistingPeriodicWorkPolicy.KEEP,
                req,
            )
        }

        fun cancelPeriodic(context: Context) {
            WorkManager.getInstance(context).cancelUniqueWork(PERIODIC_NAME)
        }
    }
}

/**
 * Split into repo + title so the widget can render two lines: a muted repo
 * caption above a primary title (ai_title when CC has named the session,
 * else the same `#abcd1f` shorthand the app uses elsewhere).
 */
private fun Session.toWidgetSession(): WidgetSession {
    val title = ai_title?.takeIf { it.isNotBlank() }
        ?: "#" + session_id.takeLast(6)
    return WidgetSession(
        sessionId = session_id,
        repo = project_name,
        title = title,
        state = state,
    )
}
