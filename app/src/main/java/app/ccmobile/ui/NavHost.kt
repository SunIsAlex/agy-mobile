package app.ccmobile.ui

import androidx.activity.BackEventCompat
import androidx.activity.compose.PredictiveBackHandler
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.CubicBezierEasing
import androidx.compose.animation.core.FastOutSlowInEasing
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.unit.dp
import app.ccmobile.Nav
import app.ccmobile.Screen
import app.ccmobile.data.Repository
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.launch

private sealed interface NavTransition {
    data class Push(val from: Screen, val to: Screen) : NavTransition
    data class Pop(val from: Screen, val to: Screen) : NavTransition
    data class Predictive(val from: Screen, val to: Screen) : NavTransition
}

/**
 * Navigation host managing screen transitions and Android predictive back gestures.
 *
 * Supported motions:
 * - Forward push: incoming screen slides in from right with fade, outgoing screen shifts left with parallax.
 * - Backward pop: outgoing screen slides out to right with fade, incoming screen shifts in from left.
 * - Predictive back gesture: tracks gesture progress in real-time. The top screen scales down into a rounded card
 *   following the user's touch with elevation shadow, while the destination screen underneath scales up and fades in.
 *   On commit, the top card animates off-screen and pops; on cancel, it springs smoothly back to full screen.
 */
@Composable
fun PredictiveNavHost(
    nav: Nav,
    repository: Repository,
    modifier: Modifier = Modifier,
) {
    val scope = rememberCoroutineScope()
    var transition by remember { mutableStateOf<NavTransition?>(null) }
    val progress = remember { Animatable(0f) }
    var swipeEdge by remember { mutableIntStateOf(BackEventCompat.EDGE_LEFT) }
    var touchY by remember { mutableFloatStateOf(0f) }

    DisposableEffect(nav) {
        nav.pushHandler = { nextScreen ->
            if (transition == null && nav.stack.lastOrNull() != nextScreen) {
                val current = nav.stack.last()
                nav.rawPush(nextScreen)
                transition = NavTransition.Push(from = current, to = nextScreen)
                scope.launch {
                    progress.snapTo(0f)
                    progress.animateTo(
                        targetValue = 1f,
                        animationSpec = tween(
                            durationMillis = 280,
                            easing = CubicBezierEasing(0.05f, 0.7f, 0.1f, 1f)
                        )
                    )
                    transition = null
                }
            } else if (transition != null) {
                nav.rawPush(nextScreen)
            }
        }
        nav.popHandler = {
            if (transition == null && nav.stack.size > 1) {
                val current = nav.stack.last()
                val target = nav.stack[nav.stack.lastIndex - 1]
                transition = NavTransition.Pop(from = current, to = target)
                scope.launch {
                    progress.snapTo(0f)
                    progress.animateTo(
                        targetValue = 1f,
                        animationSpec = tween(
                            durationMillis = 240,
                            easing = CubicBezierEasing(0.0f, 0.0f, 0.2f, 1f)
                        )
                    )
                    nav.rawPop()
                    transition = null
                }
            }
        }
        onDispose {
            nav.pushHandler = null
            nav.popHandler = null
        }
    }

    // Predictive back gesture: driven by system gesture navigation
    PredictiveBackHandler(enabled = nav.stack.size > 1 && transition == null) { progressFlow: Flow<BackEventCompat> ->
        val current = nav.stack.last()
        val target = nav.stack[nav.stack.lastIndex - 1]
        swipeEdge = BackEventCompat.EDGE_LEFT
        touchY = 0f
        transition = NavTransition.Predictive(from = current, to = target)

        try {
            progress.snapTo(0f)
            progressFlow.collect { event ->
                swipeEdge = event.swipeEdge
                touchY = event.touchY
                progress.snapTo(event.progress)
            }

            // User released to commit back navigation
            progress.animateTo(
                targetValue = 1f,
                animationSpec = tween(durationMillis = 200, easing = FastOutSlowInEasing)
            )
            nav.rawPop()
        } catch (e: CancellationException) {
            // User cancelled back gesture
            progress.animateTo(
                targetValue = 0f,
                animationSpec = tween(durationMillis = 180, easing = FastOutSlowInEasing)
            )
        } finally {
            transition = null
        }
    }

    // If stack is reset externally (e.g. pairing clear/add), cancel any pending animation
    LaunchedEffect(nav.stack.toList()) {
        val t = transition ?: return@LaunchedEffect
        val target = when (t) {
            is NavTransition.Push -> t.to
            is NavTransition.Pop -> t.to
            is NavTransition.Predictive -> t.to
        }
        if (target !in nav.stack) {
            transition = null
        }
    }

    val density = LocalDensity.current
    val currentScreen = nav.stack.last()

    Box(modifier = modifier.fillMaxSize().background(C.Bg)) {
        when (val t = transition) {
            null -> {
                // Resting state: single active screen
                RenderScreen(currentScreen, repository, nav)
            }
            is NavTransition.Push -> {
                val p = progress.value
                // Underneath layer: previous screen exiting to left with parallax
                Box(
                    Modifier
                        .fillMaxSize()
                        .graphicsLayer {
                            translationX = -size.width * 0.20f * p
                            alpha = 1f - 0.30f * p
                        }
                ) {
                    RenderScreen(t.from, repository, nav)
                }
                // Scrim
                Box(
                    Modifier
                        .fillMaxSize()
                        .background(Color.Black.copy(alpha = 0.25f * p))
                )
                // Top layer: new screen entering from right
                Box(
                    Modifier
                        .fillMaxSize()
                        .graphicsLayer {
                            translationX = size.width * (1f - p)
                            alpha = (p * 2f).coerceAtMost(1f)
                        }
                ) {
                    RenderScreen(t.to, repository, nav)
                }
            }
            is NavTransition.Pop -> {
                val p = progress.value
                // Underneath layer: target screen entering from left
                Box(
                    Modifier
                        .fillMaxSize()
                        .graphicsLayer {
                            translationX = -size.width * 0.20f * (1f - p)
                            alpha = 0.70f + 0.30f * p
                        }
                ) {
                    RenderScreen(t.to, repository, nav)
                }
                // Scrim
                Box(
                    Modifier
                        .fillMaxSize()
                        .background(Color.Black.copy(alpha = 0.25f * (1f - p)))
                )
                // Top layer: current screen exiting to right
                Box(
                    Modifier
                        .fillMaxSize()
                        .graphicsLayer {
                            translationX = size.width * p
                            alpha = (1f - p).coerceAtLeast(0f)
                        }
                ) {
                    RenderScreen(t.from, repository, nav)
                }
            }
            is NavTransition.Predictive -> {
                val p = progress.value
                // Underneath layer: destination screen zooms up and fades in
                Box(
                    Modifier
                        .fillMaxSize()
                        .graphicsLayer {
                            val scale = 0.92f + 0.08f * p
                            scaleX = scale
                            scaleY = scale
                            alpha = 0.80f + 0.20f * p
                            translationX = -size.width * 0.12f * (1f - p)
                        }
                ) {
                    RenderScreen(t.to, repository, nav)
                }
                // Scrim between layers
                Box(
                    Modifier
                        .fillMaxSize()
                        .background(Color.Black.copy(alpha = 0.25f * (1f - p)))
                )
                // Top layer: card scaling down, rounding corners, following touch
                val cornerRadius = (p * 28f).coerceAtMost(28f).dp
                val elevation = (p * 10f).coerceAtMost(10f).dp
                Box(
                    Modifier
                        .fillMaxSize()
                        .shadow(elevation, shape = RoundedCornerShape(cornerRadius))
                        .clip(RoundedCornerShape(cornerRadius))
                        .graphicsLayer {
                            val scale = (1f - 0.10f * p.coerceAtMost(0.85f)).coerceAtLeast(0.85f)
                            scaleX = scale
                            scaleY = scale

                            val sign = if (swipeEdge == BackEventCompat.EDGE_RIGHT) -1f else 1f
                            val shiftX = if (p <= 0.85f) {
                                sign * size.width * 0.38f * (p / 0.85f)
                            } else {
                                val commitRatio = (p - 0.85f) / 0.15f
                                sign * (size.width * 0.38f + size.width * 0.70f * commitRatio)
                            }
                            translationX = shiftX

                            if (size.height > 0 && touchY > 0) {
                                val normalizedY = ((touchY - size.height / 2f) / (size.height / 2f)).coerceIn(-1f, 1f)
                                translationY = normalizedY * with(density) { 24.dp.toPx() } * p.coerceAtMost(0.85f)
                            }

                            alpha = if (p > 0.85f) (1f - (p - 0.85f) / 0.15f).coerceIn(0f, 1f) else 1f
                        }
                ) {
                    RenderScreen(t.from, repository, nav)
                }
            }
        }
    }
}

@Composable
private fun RenderScreen(screen: Screen, repository: Repository, nav: Nav) {
    key(screen) {
        when (screen) {
            Screen.Tasks -> TasksScreen(
                repository,
                onOpen = { nav.push(Screen.Session(it)) },
                onSettings = { nav.push(Screen.Settings) },
                onUsage = { nav.push(Screen.Usage) },
                onProcesses = { nav.push(Screen.Processes) },
                onTerminal = { nav.push(Screen.Terminal) },
            )
            is Screen.Session -> SessionScreen(
                repository,
                screen.sid,
                onBack = nav::pop,
                onDiff = { nav.push(Screen.Diff(screen.sid)) }
            )
            is Screen.Diff -> DiffScreen(
                repository,
                screen.sid,
                onBack = nav::pop
            )
            Screen.Usage -> UsageScreen(
                repository,
                onBack = nav::pop
            )
            Screen.Terminal -> TerminalScreen(
                repository,
                onBack = nav::pop
            )
            Screen.Login -> TerminalScreen(
                repository,
                onBack = nav::pop,
                login = true
            )
            Screen.Processes -> ProcessesScreen(
                repository,
                onBack = nav::pop,
                onOpenTask = { nav.push(Screen.Session(it)) }
            )
            Screen.Settings -> SettingsScreen(
                repository,
                onBack = if (nav.stack.size > 1) nav::pop else null,
                onLogin = { nav.push(Screen.Login) }
            )
        }
    }
}
