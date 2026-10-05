package app.ccmobile.ui

import android.content.res.Configuration
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontFamily

/** Every color the UI uses, so light and dark are two values of one shape. */
data class Palette(
    val dark: Boolean,
    val bg: Color, val surface: Color, val surface2: Color, val surface3: Color, val card: Color, val code: Color,
    val border: Color, val borderStrong: Color, val divider: Color,
    val text: Color, val textSoft: Color, val muted: Color, val faint: Color,
    val clay: Color, val onClay: Color, val clayText: Color, val clayBg: Color, val clayPill: Color,
    val permBg: Color, val permBorder: Color,
    val green: Color, val greenBg: Color, val greenPill: Color, val red: Color, val amber: Color, val amberBg: Color,
    val addBg: Color, val addText: Color, val addMark: Color, val delBg: Color, val delText: Color, val delMark: Color,
    val hunkBg: Color, val contextMark: Color,
)

/** The design canvas palette: warm slate ground, clay accent. */
val DarkPalette = Palette(
    dark = true,
    bg = Color(0xFF141413), surface = Color(0xFF1F1E1C), surface2 = Color(0xFF2A2926), surface3 = Color(0xFF34332F),
    card = Color(0xFF1B1A18), code = Color(0xFF111110),
    border = Color(0xFF2C2B28), borderStrong = Color(0xFF45433E), divider = Color(0xFF242320),
    text = Color(0xFFF0EEE6), textSoft = Color(0xFFD6D3C9), muted = Color(0xFFA8A59B), faint = Color(0xFF8F8C83),
    clay = Color(0xFFD97757), onClay = Color(0xFF141413), clayText = Color(0xFFE8A283), clayBg = Color(0xFF3A2A22), clayPill = Color(0xFFF0B79C),
    permBg = Color(0xFF221F1C), permBorder = Color(0xFF5A3A2C),
    green = Color(0xFF8FC78D), greenBg = Color(0xFF1F3021), greenPill = Color(0xFFA9D9A7),
    red = Color(0xFFEC9486), amber = Color(0xFFFAB219), amberBg = Color(0xFF3A3020),
    addBg = Color(0xFF1C3320), addText = Color(0xFFC6E8C4), addMark = Color(0xFF7FAE7D),
    delBg = Color(0xFF3A1F1C), delText = Color(0xFFF2C2BA), delMark = Color(0xFFB87A70),
    hunkBg = Color(0xFF191917), contextMark = Color(0xFF6F6C64),
)

/**
 * The same warm palette on paper: ivory ground, clay accent. Accents and status colors are darker
 * than in dark mode so text in them stays readable on a light background.
 */
val LightPalette = Palette(
    dark = false,
    bg = Color(0xFFFAF9F5), surface = Color(0xFFF0EEE6), surface2 = Color(0xFFE8E6DC), surface3 = Color(0xFFDEDBD0),
    card = Color(0xFFFFFFFF), code = Color(0xFFF3F1EA),
    border = Color(0xFFE5E2D8), borderStrong = Color(0xFFC9C5B9), divider = Color(0xFFEAE7DE),
    text = Color(0xFF1F1E1D), textSoft = Color(0xFF3D3C38), muted = Color(0xFF686760), faint = Color(0xFF75736B),
    clay = Color(0xFFB5552F), onClay = Color(0xFFFFFFFF), clayText = Color(0xFFA9512F), clayBg = Color(0xFFF7E4DB), clayPill = Color(0xFF94401F),
    permBg = Color(0xFFFCF4EF), permBorder = Color(0xFFE8C2AF),
    green = Color(0xFF2F7A2E), greenBg = Color(0xFFE2F1E0), greenPill = Color(0xFF2A6628),
    red = Color(0xFFB5402E), amber = Color(0xFF8F5B08), amberBg = Color(0xFFF8EBD1),
    addBg = Color(0xFFE3F3E1), addText = Color(0xFF1D5A1B), addMark = Color(0xFF4E8E4B),
    delBg = Color(0xFFFAE3DF), delText = Color(0xFF8C2A1C), delMark = Color(0xFFB0574A),
    hunkBg = Color(0xFFEFEDE6), contextMark = Color(0xFFA19E95),
)

/**
 * The current palette. Each color reads Compose state, so switching the theme recomposes
 * everything that uses one; set it with [applyTheme].
 */
object C {
    var palette by mutableStateOf(DarkPalette)
    val Bg get() = palette.bg
    val Surface get() = palette.surface
    val Surface2 get() = palette.surface2
    val Surface3 get() = palette.surface3
    val Card get() = palette.card
    val Code get() = palette.code
    val Border get() = palette.border
    val BorderStrong get() = palette.borderStrong
    val Divider get() = palette.divider
    val Text get() = palette.text
    val TextSoft get() = palette.textSoft
    val Muted get() = palette.muted
    val Faint get() = palette.faint
    val Clay get() = palette.clay
    /** Text and icons on clay (buttons). */
    val OnClay get() = palette.onClay
    val ClayText get() = palette.clayText
    val ClayBg get() = palette.clayBg
    val ClayPill get() = palette.clayPill
    val PermBg get() = palette.permBg
    val PermBorder get() = palette.permBorder
    val Green get() = palette.green
    val GreenBg get() = palette.greenBg
    val GreenPill get() = palette.greenPill
    val Red get() = palette.red
    val Amber get() = palette.amber
    val AmberBg get() = palette.amberBg
    val AddBg get() = palette.addBg
    val AddText get() = palette.addText
    val AddMark get() = palette.addMark
    val DelBg get() = palette.delBg
    val DelText get() = palette.delText
    val DelMark get() = palette.delMark
    val HunkBg get() = palette.hunkBg
    val ContextMark get() = palette.contextMark
}

/** Settings.theme values and labels. */
val themeLabels = listOf("system" to "System", "light" to "Light", "dark" to "Dark")

/** Picks the palette for [theme] ("system", "light" or "dark"); "system" follows [configuration]. */
fun applyTheme(theme: String, configuration: Configuration) {
    val systemDark = configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK == Configuration.UI_MODE_NIGHT_YES
    C.palette = when (theme) {
        "light" -> LightPalette
        "dark" -> DarkPalette
        else -> if (systemDark) DarkPalette else LightPalette
    }
}

val Serif = FontFamily.Serif
val Mono = FontFamily.Monospace

@Composable
fun CcTheme(content: @Composable () -> Unit) {
    val p = C.palette
    val scheme = if (p.dark) {
        darkColorScheme(
            primary = p.clay, onPrimary = p.onClay, secondary = p.clayText,
            background = p.bg, onBackground = p.text, surface = p.bg, onSurface = p.text,
            surfaceVariant = p.surface, onSurfaceVariant = p.muted,
            surfaceContainer = p.surface, surfaceContainerHigh = p.surface2, surfaceContainerHighest = p.surface3,
            outline = p.borderStrong, outlineVariant = p.border, error = p.red,
        )
    } else {
        lightColorScheme(
            primary = p.clay, onPrimary = p.onClay, secondary = p.clayText,
            background = p.bg, onBackground = p.text, surface = p.bg, onSurface = p.text,
            surfaceVariant = p.surface, onSurfaceVariant = p.muted,
            surfaceContainer = p.card, surfaceContainerHigh = p.card, surfaceContainerHighest = p.surface2,
            outline = p.borderStrong, outlineVariant = p.border, error = p.red,
        )
    }
    MaterialTheme(colorScheme = scheme, content = content)
}
