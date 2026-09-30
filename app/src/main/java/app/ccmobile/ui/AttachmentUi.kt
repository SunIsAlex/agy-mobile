package app.ccmobile.ui

import android.net.Uri
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshots.SnapshotStateList
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.ccmobile.R
import app.ccmobile.data.Attachments
import app.ccmobile.data.PendingAttachment
import kotlinx.coroutines.launch

/** Paperclip button with a Photos / Files menu; picked files are read and appended to [attachments]. */
@Composable
fun AttachButton(attachments: SnapshotStateList<PendingAttachment>, onError: (String) -> Unit) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var loading by remember { mutableIntStateOf(0) }
    var menu by remember { mutableStateOf(false) }
    fun add(uris: List<Uri>) {
        val room = Attachments.MAX_COUNT - attachments.size
        if (uris.size > room) onError("Up to ${Attachments.MAX_COUNT} attachments per message")
        for (uri in uris.take(room.coerceAtLeast(0))) {
            loading++
            scope.launch {
                runCatching { Attachments.load(context, uri) }
                    .onSuccess { attachments.add(it) }
                    .onFailure { onError(it.message ?: "Couldn't attach that file") }
                loading--
            }
        }
    }
    val photos = rememberLauncherForActivityResult(ActivityResultContracts.PickMultipleVisualMedia(Attachments.MAX_COUNT)) { add(it) }
    val files = rememberLauncherForActivityResult(ActivityResultContracts.OpenMultipleDocuments()) { add(it) }
    Box {
        if (loading > 0) {
            Box(Modifier.size(48.dp), contentAlignment = Alignment.Center) { CircularProgressIndicator(Modifier.size(18.dp), color = C.Clay, strokeWidth = 2.dp) }
        } else {
            IconBtn(R.drawable.ic_attach, "Attach", { menu = true }, tint = C.TextSoft, enabled = attachments.size < Attachments.MAX_COUNT)
        }
        DropdownMenu(expanded = menu, onDismissRequest = { menu = false }) {
            DropdownMenuItem(
                text = { Text("Photos") }, leadingIcon = { CcIcon(R.drawable.ic_image, C.TextSoft, 18.dp) },
                onClick = { menu = false; photos.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly)) },
            )
            DropdownMenuItem(
                text = { Text("Files") }, leadingIcon = { CcIcon(R.drawable.ic_file, C.TextSoft, 18.dp) },
                onClick = { menu = false; files.launch(arrayOf("*/*")) },
            )
        }
    }
}

/** Removable chips for the attachments waiting to be sent. */
@Composable
fun AttachmentChips(attachments: SnapshotStateList<PendingAttachment>, modifier: Modifier = Modifier) {
    if (attachments.isEmpty()) return
    Row(modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        attachments.forEach { a ->
            Row(
                Modifier.height(40.dp).clip(RoundedCornerShape(10.dp)).background(C.Surface2).padding(start = 4.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(6.dp),
            ) {
                val thumb = a.thumbnail
                if (thumb != null) {
                    Image(thumb.asImageBitmap(), null, Modifier.size(32.dp).clip(RoundedCornerShape(7.dp)), contentScale = ContentScale.Crop)
                } else {
                    Box(Modifier.size(32.dp), contentAlignment = Alignment.Center) { CcIcon(R.drawable.ic_file, C.Muted, 18.dp) }
                }
                Text(a.name, color = C.TextSoft, fontSize = 12.sp, maxLines = 1, overflow = TextOverflow.MiddleEllipsis, modifier = Modifier.widthIn(max = 130.dp))
                IconBtn(R.drawable.ic_x, "Remove ${a.name}", { attachments.remove(a) }, tint = C.Muted)
            }
        }
    }
}

/** Attachment names under a sent message in the transcript. */
@Composable
fun SentAttachments(names: List<String>) {
    Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        names.forEach { name ->
            val image = name.substringAfterLast('.', "").lowercase() in setOf("jpg", "jpeg", "png", "gif", "webp", "heic")
            Row(
                Modifier.height(30.dp).clip(RoundedCornerShape(8.dp)).background(C.Surface).padding(horizontal = 8.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(5.dp),
            ) {
                CcIcon(if (image) R.drawable.ic_image else R.drawable.ic_file, C.Muted, 14.dp)
                Text(name, color = C.Muted, fontSize = 12.sp, maxLines = 1, overflow = TextOverflow.MiddleEllipsis, modifier = Modifier.widthIn(max = 180.dp))
            }
        }
    }
}
