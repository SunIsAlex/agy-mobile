package app.ccmobile.data

import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import app.ccmobile.repository

/** The two bridges that can run on this phone; both are started through Termux. */
enum class BridgeKind(val label: String, val port: Int, val command: String, val detail: String) {
    Termux(
        "Termux", 8765,
        "DIR=$( [ -d ~/agy-mobile ] && echo ~/agy-mobile || echo ~/claude-code-mobile ); node \$DIR/bridge/ccm-bridge.mjs --pair",
        "Runs in Termux. Works on any phone.",
    ),
    Chroot(
        "Debian chroot", 8766,
        "DIR=$( [ -d ~/agy-mobile ] && echo ~/agy-mobile || echo ~/claude-code-mobile ); sh \$DIR/chroot/ccm-chroot start && sh \$DIR/chroot/ccm-chroot pair",
        "Rooted phones, after ccm-chroot install. Antigravity CLI (agy) and apt tools; keeps running without Termux.",
    ),
}

/**
 * Starts a bridge with Termux's RUN_COMMAND service (Android apps can't run Termux's programs
 * themselves). Needs Termux's allow-external-apps = true and this app's RUN_COMMAND permission.
 * The bridge opens a pairing link once it's up; see [Repository.expectPairing].
 */
object BridgeLauncher {
    const val PERMISSION = "com.termux.permission.RUN_COMMAND"
    private const val TERMUX = "com.termux"
    private const val HOME = "/data/data/com.termux/files/home"

    fun termuxInstalled(context: Context): Boolean =
        runCatching { context.packageManager.getPackageInfo(TERMUX, 0) }.isSuccess

    fun permitted(context: Context): Boolean =
        context.checkSelfPermission(PERMISSION) == PackageManager.PERMISSION_GRANTED

    /**
     * What Termux runs: the Termux bridge detached, so the command returns while it keeps running.
     * Without [pair] it starts the bridge only, so nothing opens on screen.
     */
    private fun script(kind: BridgeKind, pair: Boolean): String = when (kind) {
        BridgeKind.Termux -> {
            val cmd = if (pair) kind.command else kind.command.removeSuffix(" --pair")
            "mkdir -p ~/.local/state/ccm-bridge && " +
                "(setsid nohup sh -c '$cmd' >> ~/.local/state/ccm-bridge/bridge.log 2>&1 < /dev/null &) && " +
                "sleep 3 && tail -n 3 ~/.local/state/ccm-bridge/bridge.log"
        }
        BridgeKind.Chroot -> if (pair) kind.command else kind.command.substringBefore(" && ")
    }

    /** The bridge this app is set up for, if it's one of this phone's. */
    fun localKind(settings: Settings): BridgeKind? =
        BridgeKind.entries.firstOrNull { it.port == settings.port }?.takeIf { settings.host == "127.0.0.1" || settings.host == "localhost" }

    /** Asks Termux to start [kind] (and pair this app with it, unless not [pair]); throws if Termux can't be reached. */
    fun start(context: Context, kind: BridgeKind, pair: Boolean = true) {
        val result = PendingIntent.getBroadcast(
            context, kind.ordinal,
            Intent(context, BridgeStartReceiver::class.java).putExtra(EXTRA_KIND, kind.name),
            // Termux fills in the result, so it must be mutable.
            PendingIntent.FLAG_MUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        val intent = Intent("com.termux.RUN_COMMAND")
            .setClassName(TERMUX, "com.termux.app.RunCommandService")
            .putExtra("com.termux.RUN_COMMAND_PATH", "/data/data/com.termux/files/usr/bin/bash")
            .putExtra("com.termux.RUN_COMMAND_ARGUMENTS", arrayOf("-lc", script(kind, pair)))
            .putExtra("com.termux.RUN_COMMAND_WORKDIR", HOME)
            .putExtra("com.termux.RUN_COMMAND_BACKGROUND", true)
            .putExtra("com.termux.RUN_COMMAND_PENDING_INTENT", result)
        if (pair) context.repository.expectPairing(kind.port)
        context.startService(intent)
    }

    const val EXTRA_KIND = "kind"
}

/** Termux's report on a start command: shows the error if it failed. */
class BridgeStartReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val kind = intent.getStringExtra(BridgeLauncher.EXTRA_KIND)?.let { runCatching { BridgeKind.valueOf(it) }.getOrNull() } ?: return
        val result = intent.getBundleExtra("result") ?: return
        val internalError = result.getInt("err", -1) != -1 // -1 is Activity.RESULT_OK
        val exit = result.getInt("exitCode", 0)
        if (!internalError && exit == 0) return
        val why = listOf(result.getString("errmsg"), result.getString("stderr"), result.getString("stdout"))
            .firstOrNull { !it.isNullOrBlank() }?.trim()?.lines()?.lastOrNull()
            ?: "exit code $exit"
        context.repository.reportError("Couldn't start the ${kind.label} bridge: $why")
    }
}
