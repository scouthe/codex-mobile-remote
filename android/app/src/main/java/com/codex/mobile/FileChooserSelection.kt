package com.codex.mobile

import android.content.Intent
import android.net.Uri
import android.app.Activity

/** Keep the activity result parsing independent of Activity/WebView lifetime. */
internal object FileChooserSelection {
    fun read(resultCode: Int, intent: Intent?): Array<Uri>? {
        if (resultCode != Activity.RESULT_OK || intent == null) return null
        // Photo/document providers often return ClipData even for one photo.
        // Chromium's parseResult reads only intent.data and loses these results.
        val selected = LinkedHashSet<Uri>()
        intent.clipData?.let { clip ->
            for (index in 0 until clip.itemCount) clip.getItemAt(index).uri?.let(selected::add)
        }
        intent.data?.let(selected::add)
        return selected.takeIf { it.isNotEmpty() }?.toTypedArray()
    }
}
