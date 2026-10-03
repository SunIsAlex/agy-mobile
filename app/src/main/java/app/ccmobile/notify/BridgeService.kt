package app.ccmobile.notify

import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.PowerManager
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat
import androidx.lifecycle.LifecycleService
import androidx.lifecycle.lifecycleScope
import app.ccmobile.R
import app.ccmobile.data.ConnState
import app.ccmobile.data.SessionSummary
import app.ccmobile.repository
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.launch

/**
 * Keeps the process, and so the bridge connection, alive while the app is in the background,
 * and turns approval requests into notifications.
 */
class BridgeService : LifecycleService() {
    private var shown = emptySet<String>()
    /** Active sessions with a working notification: when each was first seen working, and what it last showed. */
    private val working = HashMap<String, Long>()
    private val posted = HashMap<String, List<String>>()
    // Held while Claude works or runs background jobs: with the screen off, Android's deep sleep
    // would otherwise pause the bridge in Termux and the task with it.
    private val wakeLock by lazy {
        getSystemService(PowerManager::class.java)
            .newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "ccmobile:working")
            .apply { setReferenceCounted(false) }
    }
    private var keepAwake = false

    override fun onCreate() {
        super.onCreate()
        ServiceCompat.startForeground(this, Notifier.SERVICE_ID, status("Connecting…"), ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE)
        val repo = this.repository
        if (repo.client.state.value is ConnState.Idle) repo.connect()

        lifecycleScope.launch {
            combine(repo.approvals, repo.foreground) { approvals, foreground ->
                if (foreground) emptyList() else approvals
            }.collect { approvals ->
                val ids = approvals.map { it.requestId }.toSet()
                (shown - ids).forEach { Notifier.cancelApproval(this@BridgeService, it) }
                approvals.filter { it.requestId !in shown }.forEach { Notifier.showApproval(this@BridgeService, it) }
                shown = ids
            }
        }
        lifecycleScope.launch {
            combine(repo.client.state, repo.sessions, repo.foreground) { state, sessions, foreground ->
                Triple(state is ConnState.Connected, sessions, foreground)
            }.collect { (connected, sessions, foreground) -> showWorking(connected, sessions, foreground) }
        }
        lifecycleScope.launch {
            combine(repo.client.state, repo.sessions) { state, sessions -> (state is ConnState.Connected) to sessions }
                .collect { (connected, sessions) ->
                    if (!connected) return@collect // statuses are stale; keep the last decision
                    keepAwake = sessions.any { it.status == "working" || it.background.isNotEmpty() }
                    if (keepAwake) wakeLock.acquire(WAKE_LOCK_MS) else if (wakeLock.isHeld) wakeLock.release()
                    ResumeAlarm.schedule(
                        this@BridgeService,
                        sessions.filter { it.status == "limited" && it.autoContinue }.mapNotNull { it.resumeAt }.minOrNull(),
                    )
                }
        }
        lifecycleScope.launch {
            // The wake lock times out as a safety net; renew it while long work (an encode) goes on.
            while (true) {
                delay(WAKE_LOCK_MS / 2)
                if (keepAwake) wakeLock.acquire(WAKE_LOCK_MS)
            }
        }
        lifecycleScope.launch {
            combine(repo.client.state, repo.sessions) { state, sessions ->
                val working = sessions.count { it.status == "working" }
                val waiting = sessions.count { it.status == "needs_approval" }
                when (state) {
                    is ConnState.Connected -> listOfNotNull(
                        "Connected to ${state.host}",
                        working.takeIf { it > 0 }?.let { "$it working" },
                        waiting.takeIf { it > 0 }?.let { "$it waiting for you" },
                    ).joinToString(" · ")
                    is ConnState.Failed -> "Disconnected: ${state.message}"
                    else -> "Connecting…"
                }
            }.collect { text ->
                if (Notifier.canPost(this@BridgeService)) {
                    @Suppress("MissingPermission")
                    NotificationManagerCompat.from(this@BridgeService).notify(Notifier.SERVICE_ID, status(text))
                }
            }
        }
    }

    /**
     * Keeps one working notification per active session. When a session stops working, its
     * notification goes away, or, if the app is in the background, turns into a "Finished" one.
     * While disconnected the statuses are stale, so notifications are removed without a verdict.
     */
    private fun showWorking(connected: Boolean, sessions: List<SessionSummary>, foreground: Boolean) {
        val active = if (connected) sessions.filter { it.isActive } else emptyList()
        val ids = active.map { it.id }.toSet()
        for (sid in working.keys - ids) {
            working.remove(sid)
            posted.remove(sid)
            val session = sessions.firstOrNull { it.id == sid }
            if (connected && !foreground && session != null && session.status in setOf("idle", "error")) {
                Notifier.showFinished(this, session)
            } else if (connected && !foreground && session?.status == "limited") {
                Notifier.showLimited(this, session)
            } else {
                Notifier.cancelTask(this, sid)
            }
        }
        for (session in active) {
            val since = working.getOrPut(session.id) { System.currentTimeMillis() }
            // Session events arrive with every message; only repost when the text changes,
            // since Android drops updates that come faster than a few a second.
            val shows = listOf(session.title, session.status, session.lastActivity)
            if (posted.put(session.id, shows) != shows) Notifier.showWorking(this, session, since)
        }
    }

    override fun onDestroy() {
        if (wakeLock.isHeld) wakeLock.release()
        working.keys.forEach { Notifier.cancelTask(this, it) }
        super.onDestroy()
    }

    private fun status(text: String) = NotificationCompat.Builder(this, Notifier.CHANNEL_SERVICE)
        .setSmallIcon(R.drawable.ic_terminal)
        .setContentTitle("CC Mobile")
        .setContentText(text)
        .setOngoing(true)
        .setContentIntent(Notifier.openSessionIntent(this, null))
        .build()

    companion object {
        private const val WAKE_LOCK_MS = 30 * 60_000L

        fun start(context: Context) = ContextCompat.startForegroundService(context, Intent(context, BridgeService::class.java))
        fun stop(context: Context) = context.stopService(Intent(context, BridgeService::class.java))
    }
}
