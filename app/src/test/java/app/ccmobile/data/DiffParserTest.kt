package app.ccmobile.data

import org.junit.Assert.assertEquals
import org.junit.Test

class DiffParserTest {
    private val sample = """
diff --git a/chat/StreamController.kt b/chat/StreamController.kt
index 1111111..2222222 100644
--- a/chat/StreamController.kt
+++ b/chat/StreamController.kt
@@ -21,4 +21,5 @@ class StreamController
   private val events =
-  lifecycleScope.launch {
+  viewModelScope.launch {
+    api.stream(prompt)
   }
\ No newline at end of file
diff --git a/new.txt b/new.txt
new file mode 100644
index 0000000..ce01362
--- /dev/null
+++ b/new.txt
@@ -0,0 +1 @@
+hello
diff --git a/logo.png b/logo.png
index 1..2 100644
Binary files a/logo.png and b/logo.png differ
""".trimStart()

    @Test
    fun parsesFilesStatusesAndLineNumbers() {
        val files = DiffParser.parse(sample)
        assertEquals(listOf("chat/StreamController.kt", "new.txt", "logo.png"), files.map { it.path })
        assertEquals(listOf("modified", "added", "binary"), files.map { it.status })

        val first = files[0]
        assertEquals(2, first.added)
        assertEquals(1, first.removed)
        val body = first.lines.filter { it.kind != LineKind.Hunk && it.kind != LineKind.Meta }
        assertEquals(listOf(21 to 21, 22 to null, null to 22, null to 23, 23 to 24), body.map { it.oldNo to it.newNo })
        assertEquals(LineKind.Meta, first.lines.last().kind)

        assertEquals(1, files[1].added)
        assertEquals(1, files[1].lines.last().newNo)
    }

    @Test
    fun emptyDiffHasNoFiles() {
        assertEquals(emptyList<FileDiff>(), DiffParser.parse(""))
    }

    @Test
    fun deletedFilePreservesOldPathInsteadOfDevNull() {
        val raw = """
diff --git a/sub b/dir/old.kt b/sub b/dir/old.kt
deleted file mode 100644
index abcdef1..0000000
--- a/sub b/dir/old.kt
+++ /dev/null
@@ -1,2 +0,0 @@
-line 1
-line 2
""".trimStart()
        val file = DiffParser.parse(raw).single()
        assertEquals("sub b/dir/old.kt", file.path)
        assertEquals("deleted", file.status)
        assertEquals(0, file.added)
        assertEquals(2, file.removed)
    }
}
