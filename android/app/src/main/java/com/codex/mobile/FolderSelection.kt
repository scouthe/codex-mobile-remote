package com.codex.mobile

import android.content.ContentResolver
import android.net.Uri
import android.provider.DocumentsContract
import java.io.IOException

/** Enumerates only a directory explicitly granted by Android's document picker. */
internal object FolderSelection {
    const val MAX_FILES = 200
    const val MAX_DIRECTORIES = 1024
    const val MAX_FILE_BYTES = 20L * 1024 * 1024
    const val MAX_TOTAL_BYTES = 40L * 1024 * 1024

    data class File(val uri: Uri, val name: String, val mimeType: String, val relativePath: String)
    private data class Directory(val id: String, val path: String)

    fun collect(resolver: ContentResolver, tree: Uri): List<File> {
        val rootId = DocumentsContract.getTreeDocumentId(tree)
        val rootUri = DocumentsContract.buildDocumentUriUsingTree(tree, rootId)
        val rootName = resolver.query(rootUri, arrayOf(DocumentsContract.Document.COLUMN_DISPLAY_NAME), null, null, null)
            ?.use { cursor -> if (cursor.moveToFirst()) cursor.getString(0) else null }
            ?: "folder"
        val directories = ArrayDeque<Directory>()
        directories.add(Directory(rootId, safeName(rootName)))
        val seen = HashSet<String>()
        val files = ArrayList<File>()
        var totalBytes = 0L
        var directoryCount = 0
        while (directories.isNotEmpty()) {
            if (Thread.currentThread().isInterrupted) throw IOException("Folder selection was canceled.")
            val directory = directories.removeFirst()
            if (!seen.add(directory.id)) continue
            if (++directoryCount > MAX_DIRECTORIES) throw IOException("Folder contains too many subfolders.")
            val children = DocumentsContract.buildChildDocumentsUriUsingTree(tree, directory.id)
            val projection = arrayOf(
                DocumentsContract.Document.COLUMN_DOCUMENT_ID,
                DocumentsContract.Document.COLUMN_DISPLAY_NAME,
                DocumentsContract.Document.COLUMN_MIME_TYPE,
                DocumentsContract.Document.COLUMN_SIZE,
            )
            val cursor = resolver.query(children, projection, null, null, null)
                ?: throw IOException("Cannot read this folder.")
            cursor.use {
                while (it.moveToNext()) {
                    val id = it.getString(0) ?: continue
                    val name = safeName(it.getString(1) ?: "file")
                    val mime = it.getString(2) ?: "application/octet-stream"
                    val path = "${directory.path}/$name"
                    if (mime == DocumentsContract.Document.MIME_TYPE_DIR) {
                        if (directories.size >= MAX_DIRECTORIES) throw IOException("Folder contains too many subfolders.")
                        directories.add(Directory(id, path))
                        continue
                    }
                    if (!seen.add(id)) continue
                    if (files.size >= MAX_FILES) throw IOException("Select a folder with at most $MAX_FILES files.")
                    val size = if (it.isNull(3)) 0L else it.getLong(3).coerceAtLeast(0L)
                    if (size > MAX_FILE_BYTES) throw IOException("A folder file exceeds the 20 MiB limit.")
                    totalBytes += size
                    if (totalBytes > MAX_TOTAL_BYTES) throw IOException("Folder files exceed the 40 MiB limit.")
                    files.add(File(DocumentsContract.buildDocumentUriUsingTree(tree, id), name, mime, path))
                }
            }
        }
        return files
    }

    private fun safeName(name: String): String = name.replace('/', '_').replace('\\', '_')
        .takeIf { it.isNotBlank() && it != "." && it != ".." } ?: "folder"
}
