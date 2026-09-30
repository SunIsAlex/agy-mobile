package app.ccmobile.ui

import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontFamily

/** Palette from the design canvas: warm slate ground, clay accent. */
object C {
    val Bg = Color(0xFF141413)
    val Surface = Color(0xFF1F1E1C)
    val Surface2 = Color(0xFF2A2926)
    val Surface3 = Color(0xFF34332F)
    val Card = Color(0xFF1B1A18)
    val Code = Color(0xFF111110)
    val Border = Color(0xFF2C2B28)
    val BorderStrong = Color(0xFF45433E)
    val Text = Color(0xFFF0EEE6)
    val TextSoft = Color(0xFFD6D3C9)
    val Muted = Color(0xFFA8A59B)
    val Faint = Color(0xFF8F8C83)
    val Clay = Color(0xFFD97757)
    val ClayText = Color(0xFFE8A283)
    val ClayBg = Color(0xFF3A2A22)
    val ClayPill = Color(0xFFF0B79C)
    val PermBg = Color(0xFF221F1C)
    val PermBorder = Color(0xFF5A3A2C)
    val Green = Color(0xFF8FC78D)
    val GreenBg = Color(0xFF1F3021)
    val GreenPill = Color(0xFFA9D9A7)
    val Red = Color(0xFFEC9486)
    val AddBg = Color(0xFF1C3320)
    val AddText = Color(0xFFC6E8C4)
    val DelBg = Color(0xFF3A1F1C)
    val DelText = Color(0xFFF2C2BA)
}

val Serif = FontFamily.Serif
val Mono = FontFamily.Monospace

@Composable
fun CcTheme(content: @Composable () -> Unit) {
    MaterialTheme(
        colorScheme = darkColorScheme(
            primary = C.Clay,
            onPrimary = C.Bg,
            secondary = C.ClayText,
            background = C.Bg,
            onBackground = C.Text,
            surface = C.Bg,
            onSurface = C.Text,
            surfaceVariant = C.Surface,
            onSurfaceVariant = C.Muted,
            surfaceContainer = C.Surface,
            surfaceContainerHigh = C.Surface2,
            surfaceContainerHighest = C.Surface3,
            outline = C.BorderStrong,
            outlineVariant = C.Border,
            error = C.Red,
        ),
        content = content,
    )
}
