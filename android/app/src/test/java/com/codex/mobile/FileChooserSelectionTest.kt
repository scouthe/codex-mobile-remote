package com.codex.mobile

import android.app.Activity
import android.content.ClipData
import android.content.Intent
import android.net.Uri
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(manifest = Config.NONE, sdk = [28])
class FileChooserSelectionTest {
    @Test
    fun galleryResultWithOnlyClipDataReachesTheWebView() {
        val first = Uri.parse("content://photos/one")
        val second = Uri.parse("content://photos/two")
        val intent = Intent().apply {
            clipData = ClipData.newRawUri("photos", first).apply { addItem(ClipData.Item(second)) }
        }
        assertNull(intent.data)
        assertArrayEquals(arrayOf(first, second), FileChooserSelection.read(Activity.RESULT_OK, intent))
    }

    @Test
    fun singlePhotoInsideClipDataAlsoReachesTheWebView() {
        val photo = Uri.parse("content://photos/one")
        val intent = Intent().apply { clipData = ClipData.newRawUri("photo", photo) }
        assertArrayEquals(arrayOf(photo), FileChooserSelection.read(Activity.RESULT_OK, intent))
    }

    @Test
    fun cameraResultWithDataStillWorks() {
        val photo = Uri.parse("content://camera/one")
        assertArrayEquals(arrayOf(photo), FileChooserSelection.read(Activity.RESULT_OK, Intent().setData(photo)))
    }

    @Test
    fun duplicateUrisAreAttachedOnce() {
        val photo = Uri.parse("content://photos/one")
        val intent = Intent().setData(photo).apply { clipData = ClipData.newRawUri("photo", photo) }
        assertArrayEquals(arrayOf(photo), FileChooserSelection.read(Activity.RESULT_OK, intent))
    }

    @Test
    fun cancellationOrMissingResultDoesNotAttachStaleFiles() {
        assertNull(FileChooserSelection.read(Activity.RESULT_CANCELED, Intent().setData(Uri.parse("content://old"))))
        assertNull(FileChooserSelection.read(Activity.RESULT_OK, null))
    }
}
