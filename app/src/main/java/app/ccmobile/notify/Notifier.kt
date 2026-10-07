package app.ccmobile.notify

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import app.ccmobile.MainActivity
import app.ccmobile.ui.resetTime
import app.ccmobile.R
import app.ccmobile.data.Approval
import app.ccmobile.data.SessionSummary

object Notifier {
    const val CHANNEL_APPROVALS = "approvals"
    const val CHANNEL_SERVICE = "service"
    const val CHANNEL_ACTIVITY = "activity"
    const val SERVICE_ID = 1
    /** Working and finished notifications, tagged with the session id. */
    private const val TASK_ID = 2
    const val EXTRA_SID = "sid"

    fun createChannels(context: Context) {
        val nm = context.getSystemService(NotificationManager::class.java)
        nm.createNotificationChannel(
            NotificationChannel(CHANNEL_APPROVALS, "Approvals", NotificationManager.IMPORTANCE_HIGH).apply {
                description = "Claude is waiting for you to allow or deny an action"
            },
        )
        nm.createNotificationChannel(
            NotificationChannel(CHANNEL_SERVICE, "Connection", NotificationManager.IMPORTANCE_MIN).apply {
                description = "Keeps the connection to the bridge open"
            },
        )
        nm.createNotificationChannel(
            NotificationChannel(CHANNEL_ACTIVITY, "Claude's progress", NotificationManager.IMPORTANCE_LOW).apply {
                description = "What Claude is doing in each running task, and when it finishes"
            },
        )
    }

    fun canPost(context: Context) =
        ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED

    fun openSessionIntent(context: Context, sid: String?): PendingIntent {
        val intent = Intent(context, MainActivity::class.java)
            .addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP)
            .apply { sid?.let { putExtra(EXTRA_SID, it) } }
        return PendingIntent.getActivity(context, sid.hashCode(), intent, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
    }

    fun showApproval(context: Context, approval: Approval) {
        if (!canPost(context)) return
        fun action(decision: String, label: String) = NotificationCompat.Action(
            0, label,
            PendingIntent.getBroadcast(
                context, (approval.requestId + decision).hashCode(),
                ApprovalReceiver.intent(context, approval, decision),
                PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
            ),
        )
        if (approval.questions.isNotEmpty()) {
            // A question needs an answer chosen in the app, which notification buttons can't give.
            val q = approval.questions.first()
            val question = NotificationCompat.Builder(context, CHANNEL_APPROVALS)
                .setSmallIcon(R.drawable.ic_shield)
                .setContentTitle("Claude has a question")
                .setContentText(q.question)
                .setSubText(approval.sessionTitle)
                .setStyle(NotificationCompat.BigTextStyle().bigText(q.question + "\n" + q.options.joinToString(" · ") { it.label }))
                .setCategory(NotificationCompat.CATEGORY_REMINDER)
                .setPriority(NotificationCompat.PRIORITY_HIGH)
                .setContentIntent(openSessionIntent(context, approval.sid))
                .setAutoCancel(true)
                .build()
            @Suppress("MissingPermission")
            NotificationManagerCompat.from(context).notify(approval.requestId, 0, question)
            return
        }
        val notification = NotificationCompat.Builder(context, CHANNEL_APPROVALS)
            .setSmallIcon(R.drawable.ic_shield)
            .setContentTitle("Allow ${approval.toolName}?")
            .setContentText(approval.summary)
            .setSubText(approval.sessionTitle)
            .setStyle(NotificationCompat.BigTextStyle().bigText(approval.detail.take(600)))
            .setCategory(NotificationCompat.CATEGORY_REMINDER)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setContentIntent(openSessionIntent(context, approval.sid))
            .setAutoCancel(true)
            .addAction(action("deny", "Deny"))
            .addAction(action("allow", "Allow once"))
            .build()
        @Suppress("MissingPermission")
        NotificationManagerCompat.from(context).notify(approval.requestId, 0, notification)
    }

    /** Ongoing notification for a working task: what Claude is doing and for how long. Android 16 shows it as a Live Update. */
    fun showWorking(context: Context, session: SessionSummary, since: Long) {
        if (!canPost(context)) return
        val waiting = session.status == "needs_approval"
        val notification = NotificationCompat.Builder(context, CHANNEL_ACTIVITY)
            .setSmallIcon(R.drawable.ic_terminal)
            .setContentTitle(session.title)
            .setContentText(if (waiting) "Waiting for you to approve" else session.lastActivity.ifBlank { "Working…" })
            .setSubText(session.repoName)
            .setShortCriticalText(if (waiting) "Approve" else "Working")
            .setProgress(0, 0, !waiting)
            .setWhen(since)
            .setShowWhen(true)
            .setUsesChronometer(true)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setSilent(true)
            .setRequestPromotedOngoing(true)
            .setCategory(NotificationCompat.CATEGORY_PROGRESS)
            .setContentIntent(openSessionIntent(context, session.id))
            .addAction(
                0, "Interrupt",
                PendingIntent.getBroadcast(
                    context, ("interrupt" + session.id).hashCode(), InterruptReceiver.intent(context, session.id),
                    PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
                ),
            )
            .build()
        @Suppress("MissingPermission")
        NotificationManagerCompat.from(context).notify(session.id, TASK_ID, notification)
    }

    /** Replaces a task's working notification with one saying it finished. */
    fun showFinished(context: Context, session: SessionSummary) {
        if (!canPost(context)) return
        val notification = NotificationCompat.Builder(context, CHANNEL_ACTIVITY)
            .setSmallIcon(R.drawable.ic_check)
            .setContentTitle(if (session.status == "error") "Stopped with an error" else "Finished")
            .setContentText(session.title)
            .setSubText(session.repoName)
            .setStyle(NotificationCompat.BigTextStyle().bigText(listOf(session.title, session.lastActivity).filter { it.isNotBlank() }.joinToString("\n")))
            .setContentIntent(openSessionIntent(context, session.id))
            .setAutoCancel(true)
            .build()
        @Suppress("MissingPermission")
        NotificationManagerCompat.from(context).notify(session.id, TASK_ID, notification)
    }

    /** Replaces a task's working notification when a usage limit pauses it. */
    fun showLimited(context: Context, session: SessionSummary) {
        if (!canPost(context)) return
        val at = session.resumeAt?.let { resetTime(it) }
        val text = when {
            session.autoContinue && at != null -> "Continues by itself at $at."
            at != null -> "Resets around $at. Open the task to continue."
            else -> "Open the task to continue."
        }
        val notification = NotificationCompat.Builder(context, CHANNEL_ACTIVITY)
            .setSmallIcon(R.drawable.ic_alert)
            .setContentTitle("Paused: ${session.lastActivity.ifBlank { "usage limit reached" }.lowercase()}")
            .setContentText(text)
            .setSubText(session.repoName)
            .setStyle(NotificationCompat.BigTextStyle().bigText("${session.title}\n$text"))
            .setContentIntent(openSessionIntent(context, session.id))
            .setAutoCancel(true)
            .build()
        @Suppress("MissingPermission")
        NotificationManagerCompat.from(context).notify(session.id, TASK_ID, notification)
    }

    fun cancelTask(context: Context, sid: String) {
        NotificationManagerCompat.from(context).cancel(sid, TASK_ID)
    }

    fun cancelApproval(context: Context, requestId: String) {
        NotificationManagerCompat.from(context).cancel(requestId, 0)
    }
}
