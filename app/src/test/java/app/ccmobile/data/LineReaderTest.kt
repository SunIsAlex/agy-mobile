package app.ccmobile.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import java.io.StringReader

class LineReaderTest {
    @Test fun readsLinesAndSkipsOversizedOnes() {
        val long = "x".repeat(200_000) // spans several 64K reads
        val r = LineReader(StringReader("a\n\n$long\nb\n${"y".repeat(10)}\ntail"), maxChars = 100_000)
        assertEquals(LineReader.Line.Text("a"), r.next())
        assertEquals(LineReader.Line.Text(""), r.next())
        assertEquals(LineReader.Line.TooLong(200_000), r.next())
        assertEquals(LineReader.Line.Text("b"), r.next())
        assertEquals(LineReader.Line.Text("yyyyyyyyyy"), r.next())
        assertNull(r.next())
    }

    @Test fun keepsLinesAtTheLimit() {
        val r = LineReader(StringReader("${"z".repeat(70_000)}\n"), maxChars = 70_000)
        assertEquals(70_000, (r.next() as LineReader.Line.Text).text.length)
    }
}
