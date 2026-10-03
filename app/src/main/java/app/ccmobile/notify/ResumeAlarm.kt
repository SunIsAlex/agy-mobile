package app.ccmobile.notify

import android.app.AlarmManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.PowerManager
import app.ccmobile.data.ConnState
import app.ccmobile.repository
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull

/**
 * Wakes the phone when a task paused by a usage limit can continue. The bridge compares the reset
 * time with the clock every 30 seconds, but nothing runs while Android is in deep sleep, so an
 * alarm at that time wakes the phone and asks the bridge to check straight away ('tick').
 */
object ResumeAlarm {
    private var scheduled: Long? = null

    /** Sets the alarm for [at] (epoch ms), or cancels it when null. */
    fun schedule(context: Context, at: Long?) {
        if (at == scheduled) return
        scheduled = at
        val alarms = context.getSystemService(AlarmManager::class.java)
        val intent = PendingIntent.getBroadcast(
            context, 0, Intent(context, ResumeAlarmReceiver::class.java),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        when {
            at == null -> alarms.cancel(intent)
            Build.VERSION.SDK_INT < 31 || alarms.canScheduleExactAlarms() ->
                alarms.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, intent)
            // Without the exact-alarm permission Android may run it some minutes late.
            else -> alarms.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, intent)
        }
    }
}

class ResumeAlarmReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val result = goAsync()
        // Long enough for the bridge to continue the task; BridgeService holds its own wake lock
        // from when the task reports working again.
        val lock = context.getSystemService(PowerManager::class.java)
            .newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "ccmobile:resume")
        lock.acquire(60_000)
        val repo = context.repository
        if (repo.client.state.value !is ConnState.Connected) repo.connect()
        CoroutineScope(Dispatchers.Main).launch {
            withTimeoutOrNull(20_000) {
                repo.client.state.first { it is ConnState.Connected }
                repo.tick()
            }
            result.finish()
        }
    }
}
