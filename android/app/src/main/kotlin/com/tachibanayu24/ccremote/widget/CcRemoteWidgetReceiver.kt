package com.tachibanayu24.ccremote.widget

import android.appwidget.AppWidgetManager
import android.content.Context
import android.content.Intent
import androidx.glance.appwidget.GlanceAppWidget
import androidx.glance.appwidget.GlanceAppWidgetReceiver

/**
 * The system entry point for our widget. Glance's [GlanceAppWidgetReceiver]
 * handles the RemoteViews wiring; we only need to:
 *  - point it at our [CcRemoteWidget] implementation,
 *  - kick off a one-shot sync whenever the system asks for an update so the
 *    widget shows fresh data right away,
 *  - register/unregister the WorkManager periodic sync as the widget is
 *    added or fully removed from the home screen.
 */
class CcRemoteWidgetReceiver : GlanceAppWidgetReceiver() {

    override val glanceAppWidget: GlanceAppWidget = CcRemoteWidget()

    override fun onUpdate(
        context: Context,
        appWidgetManager: AppWidgetManager,
        appWidgetIds: IntArray,
    ) {
        super.onUpdate(context, appWidgetManager, appWidgetIds)
        WidgetSyncWorker.enqueueOnce(context)
    }

    override fun onEnabled(context: Context) {
        super.onEnabled(context)
        // First widget instance — start the periodic background refresh.
        WidgetSyncWorker.enqueuePeriodic(context)
        WidgetSyncWorker.enqueueOnce(context)
    }

    override fun onDisabled(context: Context) {
        super.onDisabled(context)
        // Last widget removed — stop wasting battery on background pulls.
        WidgetSyncWorker.cancelPeriodic(context)
    }

    override fun onReceive(context: Context, intent: Intent) {
        super.onReceive(context, intent)
        // Hook for future custom broadcast actions if needed (e.g. retry).
    }
}
