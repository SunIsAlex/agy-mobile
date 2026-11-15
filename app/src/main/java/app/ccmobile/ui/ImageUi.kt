package app.ccmobile.ui

import android.graphics.BitmapFactory
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.gestures.calculatePan
import androidx.compose.foundation.gestures.calculateZoom
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.pager.HorizontalPager
import androidx.compose.foundation.pager.rememberPagerState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.IntSize
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import app.ccmobile.R
import app.ccmobile.data.ImageRef
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/** Fetches an image's bytes from the bridge by ref, or null if it can't. */
typealias ImageLoader = suspend (ref: String) -> ByteArray?

private sealed interface Loaded {
    data object Loading : Loaded
    data object Failed : Loaded
    data class Ready(val bitmap: ImageBitmap) : Loaded
}

/** Decodes no larger than [maxPx] on the long side, so thumbnails don't hold full frames. */
private fun decode(bytes: ByteArray, maxPx: Int): ImageBitmap? {
    val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
    BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
    var sample = 1
    while (maxOf(bounds.outWidth, bounds.outHeight) / (sample * 2) >= maxPx) sample *= 2
    val options = BitmapFactory.Options().apply { inSampleSize = sample }
    return BitmapFactory.decodeByteArray(bytes, 0, bytes.size, options)?.asImageBitmap()
}

@Composable
private fun BridgeImage(
    ref: String, load: ImageLoader, maxPx: Int, contentScale: ContentScale,
    contentDescription: String?, modifier: Modifier = Modifier,
) {
    val state by produceState<Loaded>(Loaded.Loading, ref, maxPx) {
        value = load(ref)?.let { bytes -> withContext(Dispatchers.Default) { decode(bytes, maxPx) } }
            ?.let { Loaded.Ready(it) } ?: Loaded.Failed
    }
    Box(modifier, contentAlignment = Alignment.Center) {
        when (val s = state) {
            Loaded.Loading -> CircularProgressIndicator(Modifier.size(16.dp), color = C.Muted, strokeWidth = 2.dp)
            Loaded.Failed -> CcIcon(R.drawable.ic_image, C.Faint, 20.dp, "Image unavailable")
            is Loaded.Ready -> Image(s.bitmap, contentDescription, Modifier.fillMaxSize(), contentScale = contentScale)
        }
    }
}

/** A row of thumbnails for the images a tool call returned; tapping one opens it. */
@Composable
fun ToolImages(images: List<ImageRef>, load: ImageLoader, onOpen: (Int) -> Unit, modifier: Modifier = Modifier) {
    Row(
        modifier.fillMaxWidth().horizontalScroll(rememberScrollState()),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        images.forEachIndexed { i, image ->
            if (image.ref == null) {
                Box(
                    Modifier.size(112.dp).clip(RoundedCornerShape(10.dp)).background(C.Code),
                    contentAlignment = Alignment.Center,
                ) { Text("Not kept", color = C.Faint, fontSize = 12.sp) }
            } else {
                BridgeImage(
                    image.ref, load, maxPx = 400, contentScale = ContentScale.Crop,
                    contentDescription = "Image AGY looked at, ${i + 1} of ${images.size}. Opens full screen.",
                    modifier = Modifier
                        .size(112.dp)
                        .clip(RoundedCornerShape(10.dp))
                        .background(C.Code)
                        .border(1.dp, C.Border, RoundedCornerShape(10.dp))
                        .clickable(role = Role.Image) { onOpen(i) },
                )
            }
        }
    }
}

/** Full-screen viewer: swipe between [images], pinch or double-tap to zoom. */
@Composable
fun ImageViewer(images: List<ImageRef>, start: Int, caption: String, load: ImageLoader, onClose: () -> Unit) {
    val shown = images.filter { it.ref != null }
    if (shown.isEmpty()) return
    Dialog(onDismissRequest = onClose, properties = DialogProperties(usePlatformDefaultWidth = false)) {
        val pager = rememberPagerState(initialPage = start.coerceIn(0, shown.lastIndex)) { shown.size }
        var zoomed by remember { mutableStateOf(false) }
        Box(Modifier.fillMaxSize().background(Color.Black)) {
            HorizontalPager(pager, userScrollEnabled = !zoomed, modifier = Modifier.fillMaxSize()) { page ->
                ZoomableImage(shown[page].ref!!, load, onZoomed = { if (page == pager.currentPage) zoomed = it })
            }
            Row(
                Modifier.fillMaxWidth().safeDrawingPadding().padding(4.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                IconBtn(R.drawable.ic_x, "Close", onClose)
                Column(Modifier.weight(1f)) {
                    if (shown.size > 1) Text("${pager.currentPage + 1} of ${shown.size}", color = C.Text, fontSize = 14.sp)
                    if (caption.isNotBlank()) Text(caption, color = C.Muted, fontSize = 12.sp, fontFamily = Mono, maxLines = 1, overflow = TextOverflow.Ellipsis)
                }
            }
        }
    }
}

@Composable
private fun ZoomableImage(ref: String, load: ImageLoader, onZoomed: (Boolean) -> Unit) {
    var scale by remember { mutableFloatStateOf(1f) }
    var offset by remember { mutableStateOf(Offset.Zero) }
    var size by remember { mutableStateOf(IntSize.Zero) }
    fun set(newScale: Float, newOffset: Offset) {
        scale = newScale.coerceIn(1f, 6f)
        // Keep the image covering the screen edge it's panned towards.
        val maxX = size.width * (scale - 1) / 2
        val maxY = size.height * (scale - 1) / 2
        offset = Offset(newOffset.x.coerceIn(-maxX, maxX), newOffset.y.coerceIn(-maxY, maxY))
        onZoomed(scale > 1f)
    }
    BridgeImage(
        ref, load, maxPx = 2048, contentScale = ContentScale.Fit, contentDescription = "Image Claude looked at",
        modifier = Modifier
            .fillMaxSize()
            .onSizeChanged { size = it }
            .pointerInput(Unit) {
                detectTapGestures(onDoubleTap = { if (scale > 1f) set(1f, Offset.Zero) else set(2.5f, Offset.Zero) })
            }
            .pointerInput(Unit) {
                // Pinch always zooms; one finger pans only when zoomed, so it can swipe pages otherwise.
                awaitEachGesture {
                    awaitFirstDown(requireUnconsumed = false)
                    do {
                        val event = awaitPointerEvent()
                        if (event.changes.size > 1 || scale > 1f) {
                            set(scale * event.calculateZoom(), offset + event.calculatePan())
                            event.changes.forEach { it.consume() }
                        }
                    } while (event.changes.any { it.pressed })
                }
            }
            .graphicsLayer(scaleX = scale, scaleY = scale, translationX = offset.x, translationY = offset.y),
    )
}
