package app.ccmobile.data

import android.content.Context
import androidx.core.content.edit

class Settings(context: Context) {
    private val prefs = context.getSharedPreferences("settings", Context.MODE_PRIVATE)

    var host: String
        get() = prefs.getString("host", "127.0.0.1")!!
        set(v) = prefs.edit { putString("host", v) }
    var port: Int
        get() = prefs.getInt("port", 8765)
        set(v) = prefs.edit { putInt("port", v) }
    var token: String
        get() = prefs.getString("token", "")!!
        set(v) = prefs.edit { putString("token", v) }

    /** Claude Code permission mode for new tasks: default | acceptEdits | plan | bypassPermissions (YOLO). */
    var mode: String
        get() = prefs.getString("mode", "default")!!
        set(v) = prefs.edit { putString("mode", v) }

    /** Model alias passed to `--model`, or blank for the CLI's default. */
    var model: String
        get() = prefs.getString("model", "")!!
        set(v) = prefs.edit { putString("model", v) }
    /** Whether new tasks start with Phone use on (only offered when the bridge has root). */
    var phone: Boolean
        get() = prefs.getBoolean("phone", false)
        set(v) = prefs.edit { putBoolean("phone", v) }
    var notify: Boolean
        get() = prefs.getBoolean("notify", true)
        set(v) = prefs.edit { putBoolean("notify", v) }
    var lastRepo: String
        get() = prefs.getString("lastRepo", "")!!
        set(v) = prefs.edit { putString("lastRepo", v) }

    fun config(): BridgeConfig? = if (token.isBlank()) null else BridgeConfig(host, port, token)
}
