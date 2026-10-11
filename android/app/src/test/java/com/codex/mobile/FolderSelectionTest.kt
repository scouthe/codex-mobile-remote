package com.codex.mobile

import android.content.ContentProvider
import android.content.ContentValues
import android.database.Cursor
import android.database.MatrixCursor
import android.net.Uri
import android.provider.DocumentsContract
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import org.robolectric.shadows.ShadowContentResolver
import java.io.IOException

@RunWith(RobolectricTestRunner::class)
@Config(manifest = Config.NONE, sdk = [28])
class FolderSelectionTest {
    private val provider = TestDocuments()
    private val tree = Uri.parse("content://fixture.docs/tree/root")

    @Before fun registerProvider() {
        ShadowContentResolver.registerProviderInternal("fixture.docs", provider)
    }

    @Test fun nestedImageAndTextFilesKeepTheirPathsAndMimeTypes() {
        provider.children["root"] = listOf(
            TestDocuments.Entry("photo", "image.png", "image/png", 12),
            TestDocuments.Entry("sub", "notes", DocumentsContract.Document.MIME_TYPE_DIR, 0),
        )
        provider.children["sub"] = listOf(TestDocuments.Entry("text", "readme.md", "text/markdown", 10))
        val files = FolderSelection.collect(RuntimeEnvironment.getApplication().contentResolver, tree)
        assertEquals(listOf("project/image.png", "project/notes/readme.md"), files.map { it.relativePath })
        assertEquals(listOf("image/png", "text/markdown"), files.map { it.mimeType })
        assertEquals(3, provider.queries)
    }

    @Test fun emptyFolderIsHandledWithoutInventingFiles() {
        assertTrue(FolderSelection.collect(RuntimeEnvironment.getApplication().contentResolver, tree).isEmpty())
    }

    @Test fun providerCyclesAndDuplicateFilesDoNotLoopOrDuplicate() {
        val photo = TestDocuments.Entry("photo", "a.png", "image/png", 1)
        provider.children["root"] = listOf(photo, photo, TestDocuments.Entry("root", "cycle", DocumentsContract.Document.MIME_TYPE_DIR, 0))
        assertEquals(1, FolderSelection.collect(RuntimeEnvironment.getApplication().contentResolver, tree).size)
        assertEquals(2, provider.queries)
    }

    @Test fun excessiveFileCountIsRejectedBeforeFilesAreRead() {
        provider.children["root"] = (0..FolderSelection.MAX_FILES).map { TestDocuments.Entry("f$it", "f$it.txt", "text/plain", 0) }
        assertThrows(IOException::class.java) { FolderSelection.collect(RuntimeEnvironment.getApplication().contentResolver, tree) }
    }

    @Test fun oversizedFileIsRejectedBeforeMaterializingIt() {
        provider.children["root"] = listOf(TestDocuments.Entry("huge", "huge.png", "image/png", FolderSelection.MAX_FILE_BYTES + 1))
        assertThrows(IOException::class.java) { FolderSelection.collect(RuntimeEnvironment.getApplication().contentResolver, tree) }
    }

    @Test fun aggregateByteLimitIsEnforced() {
        provider.children["root"] = (1..3).map { TestDocuments.Entry("f$it", "f$it.txt", "text/plain", FolderSelection.MAX_FILE_BYTES) }
        assertThrows(IOException::class.java) { FolderSelection.collect(RuntimeEnvironment.getApplication().contentResolver, tree) }
    }

    class TestDocuments : ContentProvider() {
        data class Entry(val id: String, val name: String, val mime: String, val size: Long)
        val children = HashMap<String, List<Entry>>()
        var queries = 0
        override fun onCreate() = true
        override fun query(uri: Uri, projection: Array<out String>?, selection: String?, selectionArgs: Array<out String>?, sortOrder: String?): Cursor {
            queries += 1
            val rows = if (uri.lastPathSegment == "children") children[DocumentsContract.getDocumentId(uri)].orEmpty()
                else listOf(Entry("root", "project", DocumentsContract.Document.MIME_TYPE_DIR, 0))
            return MatrixCursor(projection).apply {
                rows.forEach { entry -> addRow(projection!!.map { column -> when (column) {
                    DocumentsContract.Document.COLUMN_DOCUMENT_ID -> entry.id
                    DocumentsContract.Document.COLUMN_DISPLAY_NAME -> entry.name
                    DocumentsContract.Document.COLUMN_MIME_TYPE -> entry.mime
                    DocumentsContract.Document.COLUMN_SIZE -> entry.size
                    else -> null
                } }.toTypedArray<Any?>()) }
            }
        }
        override fun getType(uri: Uri): String? = null
        override fun insert(uri: Uri, values: ContentValues?): Uri? = null
        override fun delete(uri: Uri, selection: String?, selectionArgs: Array<out String>?) = 0
        override fun update(uri: Uri, values: ContentValues?, selection: String?, selectionArgs: Array<out String>?) = 0
    }
}
