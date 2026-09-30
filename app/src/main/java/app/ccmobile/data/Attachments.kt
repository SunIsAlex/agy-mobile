package app.ccmobile.data

import android.content.Context
import android.graphics.Bitmap
import android.graphics.ImageDecoder
import android.net.Uri
import android.provider.OpenableColumns
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.ByteArrayOutputStream
import java.io.IOException
import java.util.Base64
import kotlin.math.roundToInt

/** A file picked for the next message, read into memory and ready to send to the bridge. */
class PendingAttachment(
    val name: String,
    val mime: String,
    val size: Int,
    val base64: String,
    val thumbnail: Bitmap?,
) {
    val isImage: Boolean get() = mime.startsWith("image/")
}

object Attachments {
    /** Matches MAX_ATTACHMENT_BYTES in ccm-bridge.mjs. */
    const val MAX_BYTES = 20 * 1024 * 1024
    const val MAX_COUNT = 10

    /** Longest image edge sent to Claude; larger images are scaled down by the API anyway. */
    private const val MAX_IMAGE_EDGE = 1568
    private const val THUMB_EDGE = 144

    /**
     * Reads [uri]. Photos are scaled down and re-encoded as JPEG (PNG if transparent) so they stay
     * well under the API's inline image limit; other files are sent as they are.
     */
    suspend fun load(context: Context, uri: Uri): PendingAttachment = withContext(Dispatchers.IO) {
        val resolver = context.contentResolver
        var name = uri.lastPathSegment?.substringAfterLast('/') ?: "file"
        var size = -1L
        resolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE), null, null, null)?.use { c ->
            if (c.moveToFirst()) {
                c.getString(0)?.let { name = it }
                if (!c.isNull(1)) size = c.getLong(1)
            }
        }
        val mime = resolver.getType(uri) ?: "application/octet-stream"
        if (size > MAX_BYTES) throw IOException("$name is over 20 MB")

        if (mime.startsWith("image/") && mime != "image/gif" && mime != "image/svg+xml") {
            runCatching { encodeImage(context, uri, name) }.getOrNull()?.let { return@withContext it }
        }
        val bytes = resolver.openInputStream(uri)?.use { input ->
            val out = ByteArrayOutputStream()
            val buf = ByteArray(64 * 1024)
            while (true) {
                val n = input.read(buf)
                if (n < 0) break
                out.write(buf, 0, n)
                if (out.size() > MAX_BYTES) throw IOException("$name is over 20 MB")
            }
            out.toByteArray()
        } ?: throw IOException("Couldn't read $name")
        if (bytes.isEmpty()) throw IOException("$name is empty")
        PendingAttachment(name, mime, bytes.size, Base64.getEncoder().encodeToString(bytes), null)
    }

    private fun encodeImage(context: Context, uri: Uri, name: String): PendingAttachment {
        val bitmap = ImageDecoder.decodeBitmap(ImageDecoder.createSource(context.contentResolver, uri)) { decoder, info, _ ->
            val scale = MAX_IMAGE_EDGE.toFloat() / maxOf(info.size.width, info.size.height)
            if (scale < 1f) decoder.setTargetSize((info.size.width * scale).roundToInt(), (info.size.height * scale).roundToInt())
            decoder.allocator = ImageDecoder.ALLOCATOR_SOFTWARE
        }
        val png = bitmap.hasAlpha()
        val out = ByteArrayOutputStream()
        bitmap.compress(if (png) Bitmap.CompressFormat.PNG else Bitmap.CompressFormat.JPEG, 85, out)
        val bytes = out.toByteArray()
        val stem = name.substringBeforeLast('.', name)
        val thumbScale = THUMB_EDGE.toFloat() / maxOf(bitmap.width, bitmap.height)
        val thumb = if (thumbScale < 1f) {
            Bitmap.createScaledBitmap(bitmap, (bitmap.width * thumbScale).roundToInt().coerceAtLeast(1), (bitmap.height * thumbScale).roundToInt().coerceAtLeast(1), true)
        } else bitmap
        return PendingAttachment(
            name = if (png) "$stem.png" else "$stem.jpg",
            mime = if (png) "image/png" else "image/jpeg",
            size = bytes.size,
            base64 = Base64.getEncoder().encodeToString(bytes),
            thumbnail = thumb,
        )
    }
}
