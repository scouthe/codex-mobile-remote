package com.codex.mobile

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat

/**
 * Keeps the WebView event connection alive while a remote Codex task is
 * active and mirrors the latest task state into an Android notification.
 * It never starts a local Codex process.
 */
class CodexForegroundService : Service() {

    companion object {
        private const val CHANNEL_ID = "codex_remote_tasks"
        private const val NOTIFICATION_ID = 1001
        private const val ACTION_SHOW = "com.codex.mobile.action.SHOW_TASK"
        private const val ACTION_CLEAR = "com.codex.mobile.action.CLEAR_TASK"
        private const val EXTRA_STATE = "state"
        private const val EXTRA_TITLE = "title"
        private const val EXTRA_DETAIL = "detail"
        private const val EXTRA_SERVER_URL = "server_url"

        private val TERMINAL_STATES = setOf("completed", "failed", "canceled", "cancelled")

        fun showTask(
            context: Context,
            state: String,
            title: String,
            detail: String,
            serverUrl: String,
        ) {
            val intent = Intent(context, CodexForegroundService::class.java).apply {
                action = ACTION_SHOW
                putExtra(EXTRA_STATE, state)
                putExtra(EXTRA_TITLE, title)
                putExtra(EXTRA_DETAIL, detail)
                putExtra(EXTRA_SERVER_URL, serverUrl)
            }
            try {
                ContextCompat.startForegroundService(context, intent)
            } catch (_: RuntimeException) {
                // Android 12+ can reject a foreground-service start while the
                // app is backgrounded. The WebView will still show the state
                // when it resumes; never crash the remote client for a badge.
            }
        }

        fun clearTask(context: Context) {
            context.stopService(Intent(context, CodexForegroundService::class.java))
            context.getSystemService(NotificationManager::class.java)?.cancel(NOTIFICATION_ID)
        }
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        createNotificationChannel()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_CLEAR -> {
                stopForeground(STOP_FOREGROUND_REMOVE)
                stopSelf()
                return START_NOT_STICKY
            }

            ACTION_SHOW -> {
                val state = intent.getStringExtra(EXTRA_STATE).orEmpty().lowercase()
                val title = intent.getStringExtra(EXTRA_TITLE)
                    ?.takeIf(String::isNotBlank)
                    ?: getString(R.string.notification_task_running)
                val detail = intent.getStringExtra(EXTRA_DETAIL)
                    ?.takeIf(String::isNotBlank)
                    ?: getString(R.string.notification_task_default_detail)
                val serverUrl = intent.getStringExtra(EXTRA_SERVER_URL).orEmpty()
                val terminal = state in TERMINAL_STATES
                val notification = buildNotification(state, title, detail, serverUrl, terminal)

                startForeground(NOTIFICATION_ID, notification)
                if (terminal) {
                    // Keep the completion result visible without keeping a data
                    // sync foreground service alive indefinitely.
                    stopForeground(STOP_FOREGROUND_DETACH)
                    stopSelf()
                }
            }

            else -> {
                stopSelf()
            }
        }
        return START_NOT_STICKY
    }

    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val channel = NotificationChannel(
            CHANNEL_ID,
            getString(R.string.notification_channel_name),
            NotificationManager.IMPORTANCE_DEFAULT,
        ).apply {
            description = getString(R.string.notification_channel_description)
            setShowBadge(true)
        }
        getSystemService(NotificationManager::class.java).createNotificationChannel(channel)
    }

    private fun buildNotification(
        state: String,
        title: String,
        detail: String,
        serverUrl: String,
        terminal: Boolean,
    ): Notification {
        val launchIntent = Intent(this, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
            putExtra(EXTRA_SERVER_URL, serverUrl)
        }
        val launchPendingIntent = PendingIntent.getActivity(
            this,
            0,
            launchIntent,
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        val stopPendingIntent = PendingIntent.getService(
            this,
            1,
            Intent(this, CodexForegroundService::class.java).apply { action = ACTION_CLEAR },
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )

        val displayTitle = when (state) {
            "queued" -> "Queued · $title"
            "waiting_approval", "waiting_user_input" -> "Action needed · $title"
            "completed" -> "Completed · $title"
            "failed" -> "Failed · $title"
            "canceled", "cancelled" -> "Canceled · $title"
            else -> title
        }

        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(displayTitle)
            .setContentText(detail)
            .setStyle(NotificationCompat.BigTextStyle().bigText(detail))
            .setContentIntent(launchPendingIntent)
            .setOnlyAlertOnce(state !in setOf("waiting_approval", "waiting_user_input"))
            .setOngoing(!terminal)
            .setAutoCancel(terminal)
            .setCategory(
                if (state in setOf("waiting_approval", "waiting_user_input")) {
                    NotificationCompat.CATEGORY_REMINDER
                } else {
                    NotificationCompat.CATEGORY_PROGRESS
                },
            )
            .addAction(
                0,
                getString(R.string.notification_stop_monitoring),
                stopPendingIntent,
            )
            .build()
    }
}
