package app.ccmobile.data

import android.content.Context
import androidx.core.content.edit

class Settings(context: Context) {
    private val prefs = context.getSharedPreferences("settings", Context.MODE_PRIVATE)
    private val drafts = context.getSharedPreferences("drafts", Context.MODE_PRIVATE)

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
    /** Reasoning effort passed to `--effort` (low, medium, high, xhigh, max), or blank for the model's default. */
    var effort: String
        get() = prefs.getString("effort", "")!!
        set(v) = prefs.edit { putString("effort", v) }
    /** Whether new tasks continue by themselves once a usage limit resets. */
    var autoContinue: Boolean
        get() = prefs.getBoolean("autoContinue", false)
        set(v) = prefs.edit { putBoolean("autoContinue", v) }
    /**
     * When to hold a wake lock while Claude works: "never", "charging" or "always". Long renders
     * keep the CPU busy for hours, so on battery the default lets the phone sleep (pausing them).
     */
    var keepAwake: String
        get() = prefs.getString("keepAwake", "charging")!!
        set(v) = prefs.edit { putString("keepAwake", v) }
    /** Start this phone's bridge again through Termux when it stops (Android kills background processes). */
    var reviveBridge: Boolean
        get() = prefs.getBoolean("reviveBridge", true)
        set(v) = prefs.edit { putBoolean("reviveBridge", v) }
    /** "system", "light" or "dark". */
    var theme: String
        get() = prefs.getString("theme", "system")!!
        set(v) = prefs.edit { putString("theme", v) }
    /** Text size in the Terminal screen. */
    var terminalFont: Int
        get() = prefs.getInt("terminalFont", 13)
        set(v) = prefs.edit { putInt("terminalFont", v) }
    var notify: Boolean
        get() = prefs.getBoolean("notify", true)
        set(v) = prefs.edit { putBoolean("notify", v) }
    var lastRepo: String
        get() = prefs.getString("lastRepo", "")!!
        set(v) = prefs.edit { putString("lastRepo", v) }

    /**
     * Unsent message text, by task id ("" for the new-task box). Saved as it's typed so it
     * survives leaving the screen, and Android killing the app while it's in the background.
     */
    fun draft(key: String): String = drafts.getString(key, "")!!
    fun setDraft(key: String, text: String) = drafts.edit { if (text.isEmpty()) remove(key) else putString(key, text) }

    fun config(): BridgeConfig? = if (token.isBlank()) null else BridgeConfig(host, port, token)
}
