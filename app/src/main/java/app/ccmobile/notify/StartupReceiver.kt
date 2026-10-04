package app.ccmobile.notify

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import app.ccmobile.repository

/**
 * Starts the background service after a reboot or an app update, as if the app had been opened,
 * so the bridge connection, notifications and restarting a stopped bridge carry on by themselves.
 */
class StartupReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != Intent.ACTION_BOOT_COMPLETED && intent.action != Intent.ACTION_MY_PACKAGE_REPLACED) return
        val settings = context.repository.settings
        if (settings.notify && settings.config() != null && Notifier.canPost(context)) BridgeService.start(context)
    }
}
