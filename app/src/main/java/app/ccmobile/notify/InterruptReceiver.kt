package app.ccmobile.notify

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import app.ccmobile.repository

/** Handles the Interrupt button on a working notification. */
class InterruptReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val sid = intent.getStringExtra(Notifier.EXTRA_SID) ?: return
        context.repository.interrupt(sid)
    }

    companion object {
        fun intent(context: Context, sid: String) =
            Intent(context, InterruptReceiver::class.java).putExtra(Notifier.EXTRA_SID, sid)
    }
}
