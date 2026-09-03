package com.codex.mobile

import android.Manifest
import android.annotation.SuppressLint
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.net.http.SslError
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.OpenableColumns
import android.util.Base64
import android.util.Log
import android.view.View
import android.webkit.ConsoleMessage
import android.webkit.CookieManager
import android.webkit.JavascriptInterface
import android.webkit.PermissionRequest
import android.webkit.SslErrorHandler
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.CheckBox
import android.widget.EditText
import android.widget.ImageButton
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.TextView
import androidx.activity.result.contract.ActivityResultContracts
import androidx.activity.OnBackPressedCallback
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import androidx.core.view.OnApplyWindowInsetsListener
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.lifecycle.Lifecycle
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.util.UUID

/**
 * A lightweight native shell for a codexapp instance running on the user's
 * computer. No Termux environment, Node.js process, Codex binary, or local
 * HTTP server is started on Android.
 */
class MainActivity : AppCompatActivity() {

    companion object {
        private const val TAG = "CodexRemote"
        private const val ANDROID_BRIDGE_NAME = "CodexAndroid"
        private const val CLIENT_PREFS = "codex_remote_client"
        private const val CLIENT_ID_KEY = "client_id"
        private const val MAX_SHARED_FILE_BYTES = 20 * 1024 * 1024
    }

    private lateinit var webView: WebView
    private lateinit var appContent: View
    private lateinit var setupOverlay: View
    private lateinit var configurationForm: LinearLayout
    private lateinit var profilesContainer: LinearLayout
    private lateinit var profileLabelInput: EditText
    private lateinit var serverUrlInput: EditText
    private lateinit var passwordInput: EditText
    private lateinit var allowHttpCheckBox: CheckBox
    private lateinit var newProfileButton: Button
    private lateinit var saveProfileButton: Button
    private lateinit var connectButton: Button
    private lateinit var retryButton: Button
    private lateinit var cancelButton: Button
    private lateinit var statusText: TextView
    private lateinit var statusDetail: TextView
    private lateinit var progressBar: ProgressBar
    private lateinit var connectionStatusDot: TextView
    private lateinit var connectionStatusText: TextView
    private lateinit var settingsButton: ImageButton

    private lateinit var connectionStore: RemoteConnectionStore
    private lateinit var connectionManager: RemoteConnectionManager
    private lateinit var endpointSelector: EndpointSelector
    private var profiles: List<RemoteConnectionStore.Profile> = emptyList()
    private var currentProfile: RemoteConnectionStore.Profile? = null
    private var editingProfileId: String? = null
    private var currentBaseUri: Uri? = null
    private var fileChooserCallback: ValueCallback<Array<Uri>>? = null
    private var mainFrameFailed = false
    private var pageReady = false
    private var passwordAttempted = false
    private var pendingNotification: TaskNotification? = null
    private var shareDispatched = false

    private val shareLock = Any()
    private var pendingShareText: String? = null
    private val pendingShareUris = LinkedHashMap<String, SharedContent>()

    private data class TaskNotification(
        val state: String,
        val title: String,
        val detail: String,
    )

    private data class SharedContent(
        val uri: Uri,
        val name: String,
        val mimeType: String,
    )

    private val fileChooserLauncher = registerForActivityResult(
        ActivityResultContracts.StartActivityForResult(),
    ) { result ->
        val callback = fileChooserCallback
        fileChooserCallback = null
        callback?.onReceiveValue(
            if (result.resultCode == RESULT_OK) {
                WebChromeClient.FileChooserParams.parseResult(result.resultCode, result.data)
            } else {
                null
            },
        )
    }

    private val notificationPermissionLauncher = registerForActivityResult(
        ActivityResultContracts.RequestPermission(),
    ) { granted ->
        val pending = pendingNotification
        pendingNotification = null
        if (granted && pending != null) {
            CodexForegroundService.showTask(
                this,
                pending.state,
                pending.title,
                pending.detail,
                currentProfile?.baseUrl.orEmpty(),
            )
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)

        bindViews()
        applySystemBarInsets()
        connectionStore = RemoteConnectionStore(this)
        connectionManager = RemoteConnectionManager(
            context = this,
            onNetworkAvailable = ::onNetworkAvailable,
            onNetworkLost = ::onNetworkLost,
        )
        endpointSelector = EndpointSelector()

        setupWebView()
        setupControls()
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                when {
                    setupOverlay.visibility == View.VISIBLE && pageReady -> {
                        setupOverlay.visibility = View.GONE
                        appContent.visibility = View.VISIBLE
                    }
                    webView.canGoBack() -> webView.goBack()
                    else -> finish()
                }
            }
        })
        collectShareIntent(intent)

        profiles = connectionStore.loadProfiles()
        if (profiles.isEmpty()) {
            showConfiguration()
        } else {
            renderProfiles()
            autoSelectAndConnect()
        }
    }

    override fun onStart() {
        super.onStart()
        connectionManager.start()
    }

    override fun onStop() {
        CookieManager.getInstance().flush()
        connectionManager.stop()
        super.onStop()
    }

    override fun onResume() {
        super.onResume()
        dispatchWindowEvent("codex-native-resume")
        requestPendingNotificationPermission()
    }

    override fun onPause() {
        dispatchWindowEvent("codex-native-pause")
        CookieManager.getInstance().flush()
        super.onPause()
    }

    override fun onDestroy() {
        connectionManager.stop()
        endpointSelector.shutdown()
        fileChooserCallback?.onReceiveValue(null)
        fileChooserCallback = null
        webView.apply {
            stopLoading()
            removeJavascriptInterface(ANDROID_BRIDGE_NAME)
            webChromeClient = null
            webViewClient = WebViewClient()
            destroy()
        }
        super.onDestroy()
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        collectShareIntent(intent)
        if (pageReady) dispatchPendingShare()
    }

    private fun bindViews() {
        webView = findViewById(R.id.webView)
        appContent = findViewById(R.id.appContent)
        setupOverlay = findViewById(R.id.setupOverlay)
        configurationForm = findViewById(R.id.configurationForm)
        profilesContainer = findViewById(R.id.profilesContainer)
        profileLabelInput = findViewById(R.id.profileLabelInput)
        serverUrlInput = findViewById(R.id.serverUrlInput)
        passwordInput = findViewById(R.id.passwordInput)
        allowHttpCheckBox = findViewById(R.id.allowHttpCheckBox)
        newProfileButton = findViewById(R.id.newProfileButton)
        saveProfileButton = findViewById(R.id.saveProfileButton)
        connectButton = findViewById(R.id.connectButton)
        retryButton = findViewById(R.id.retryButton)
        cancelButton = findViewById(R.id.cancelButton)
        statusText = findViewById(R.id.statusText)
        statusDetail = findViewById(R.id.statusDetail)
        progressBar = findViewById(R.id.progressBar)
        connectionStatusDot = findViewById(R.id.connectionStatusDot)
        connectionStatusText = findViewById(R.id.connectionStatusText)
        settingsButton = findViewById(R.id.settingsButton)
    }

    /** Keep the toolbar and setup form below the Android status bar. */
    private fun applySystemBarInsets() {
        val listener = OnApplyWindowInsetsListener { view, insets ->
            val systemBars = insets.getInsets(WindowInsetsCompat.Type.systemBars())
            view.setPadding(view.paddingLeft, systemBars.top, view.paddingRight, view.paddingBottom)
            insets
        }
        ViewCompat.setOnApplyWindowInsetsListener(appContent, listener)
        ViewCompat.setOnApplyWindowInsetsListener(setupOverlay, listener)
        ViewCompat.requestApplyInsets(appContent)
        ViewCompat.requestApplyInsets(setupOverlay)
    }

    private fun setupControls() {
        newProfileButton.setOnClickListener { beginNewProfile() }
        saveProfileButton.setOnClickListener { saveProfile() }
        connectButton.setOnClickListener { autoSelectAndConnect() }
        retryButton.setOnClickListener {
            if (profiles.isNotEmpty()) autoSelectAndConnect() else showConfiguration()
        }
        cancelButton.setOnClickListener {
            if (pageReady) {
                setupOverlay.visibility = View.GONE
                appContent.visibility = View.VISIBLE
            } else {
                finish()
            }
        }
        settingsButton.setOnClickListener { showConfiguration() }
        settingsButton.setOnLongClickListener {
            confirmClearConnection()
            true
        }
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun setupWebView() {
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG)

        CookieManager.getInstance().apply {
            setAcceptCookie(true)
            setAcceptThirdPartyCookies(webView, false)
        }

        webView.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            databaseEnabled = false
            allowFileAccess = false
            allowContentAccess = true
            allowFileAccessFromFileURLs = false
            allowUniversalAccessFromFileURLs = false
            mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
            javaScriptCanOpenWindowsAutomatically = false
            setSupportMultipleWindows(false)
            setSupportZoom(false)
            mediaPlaybackRequiresUserGesture = true
            userAgentString = "$userAgentString CodexRemoteAndroid/${BuildConfig.VERSION_NAME}"
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) safeBrowsingEnabled = true
        }

        webView.addJavascriptInterface(AndroidBridge(), ANDROID_BRIDGE_NAME)
        webView.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(
                view: WebView,
                request: WebResourceRequest,
            ): Boolean {
                val uri = request.url
                if (request.isForMainFrame && isAllowedInWebView(uri)) return false
                if (!request.isForMainFrame) return false
                return openExternal(uri)
            }

            override fun onPageStarted(view: WebView, url: String, favicon: Bitmap?) {
                super.onPageStarted(view, url, favicon)
                if (!mainFrameFailed) setConnectionStatus(false, getString(R.string.status_connecting_short))
            }

            override fun onPageFinished(view: WebView, url: String) {
                super.onPageFinished(view, url)
                if (mainFrameFailed || !isAllowedInWebView(Uri.parse(url))) return
                trySavedPasswordOrShowPage()
            }

            override fun onReceivedError(
                view: WebView,
                request: WebResourceRequest,
                error: WebResourceError,
            ) {
                super.onReceivedError(view, request, error)
                if (!request.isForMainFrame) return
                onMainFrameFailure(error.description?.toString() ?: getString(R.string.error_connection))
            }

            override fun onReceivedSslError(
                view: WebView,
                handler: SslErrorHandler,
                error: SslError,
            ) {
                // Never provide a certificate bypass for a remote command UI.
                handler.cancel()
                if (isAllowedInWebView(Uri.parse(error.url))) {
                    onMainFrameFailure(getString(R.string.error_tls_certificate))
                } else {
                    Log.w(TAG, "Rejected certificate for subresource: ${error.url}")
                }
            }
        }

        webView.webChromeClient = object : WebChromeClient() {
            override fun onConsoleMessage(consoleMessage: ConsoleMessage): Boolean {
                if (BuildConfig.DEBUG) {
                    Log.d(
                        TAG,
                        "[WebView] ${consoleMessage.sourceId()}:" +
                            "${consoleMessage.lineNumber()} ${consoleMessage.message()}",
                    )
                }
                return true
            }

            override fun onProgressChanged(view: WebView, newProgress: Int) {
                if (setupOverlay.visibility == View.VISIBLE && configurationForm.visibility == View.GONE) {
                    statusDetail.text = getString(R.string.status_loading_percent, newProgress)
                    statusDetail.visibility = View.VISIBLE
                }
            }

            override fun onShowFileChooser(
                webView: WebView,
                filePathCallback: ValueCallback<Array<Uri>>,
                fileChooserParams: FileChooserParams,
            ): Boolean {
                this@MainActivity.fileChooserCallback?.onReceiveValue(null)
                this@MainActivity.fileChooserCallback = filePathCallback
                return try {
                    fileChooserLauncher.launch(fileChooserParams.createIntent())
                    true
                } catch (error: Exception) {
                    Log.w(TAG, "Unable to open file chooser", error)
                    this@MainActivity.fileChooserCallback = null
                    filePathCallback.onReceiveValue(null)
                    false
                }
            }

            override fun onPermissionRequest(request: PermissionRequest) {
                // Camera/microphone access is not required by the remote shell.
                request.deny()
            }
        }
    }

    private fun saveProfile() {
        val raw = serverUrlInput.text.toString().trim()
        val candidate = if (raw.contains("://")) raw else "https://$raw"
        val normalized = RemoteConnectionStore.normalizeUrl(candidate)
        if (normalized == null) {
            serverUrlInput.error = getString(R.string.error_invalid_url)
            return
        }

        val uri = Uri.parse(normalized)
        if (uri.scheme.equals("http", ignoreCase = true) && !allowHttpCheckBox.isChecked) {
            allowHttpCheckBox.error = getString(R.string.error_http_confirmation)
            return
        }

        val password = passwordInput.text.toString().takeIf(String::isNotBlank)
        val profileId = editingProfileId?.trim().takeIf { !it.isNullOrEmpty() }
            ?: UUID.randomUUID().toString()
        val profile = RemoteConnectionStore.Profile(
            id = profileId,
            label = profileLabelInput.text.toString(),
            baseUrl = normalized,
            password = password,
        )
        val replacementIndex = profiles.indexOfFirst { it.id == profileId }
        val nextProfiles = profiles.toMutableList().apply {
            if (replacementIndex >= 0) {
                set(replacementIndex, profile)
            } else {
                add(profile)
            }
        }
        try {
            connectionStore.saveProfiles(nextProfiles)
        } catch (error: Exception) {
            showConfiguration(getString(R.string.error_save_connection, error.message.orEmpty()))
            return
        }
        profiles = connectionStore.loadProfiles()
        editingProfileId = profileId
        renderProfiles()
        fillConfiguration(profiles.firstOrNull { it.id == profileId } ?: profile)
        autoSelectAndConnect()
    }

    private fun autoSelectAndConnect() {
        if (profiles.isEmpty()) {
            showConfiguration()
            return
        }
        endpointSelector.cancel()
        showSelecting(profiles.size)
        endpointSelector.select(profiles) { selected, results ->
            if (selected == null) {
                showConfiguration(getString(R.string.error_connection))
                return@select
            }
            val reachableCount = results.count { it.reachable }
            if (reachableCount == 0) {
                showConfiguration(getString(R.string.error_no_reachable_servers))
                return@select
            }
            Log.d(TAG, "Selected ${selected.label} (${selected.baseUrl}); $reachableCount/${results.size} endpoints reachable")
            connect(selected)
        }
    }

    private fun connect(profile: RemoteConnectionStore.Profile) {
        currentProfile = profile
        editingProfileId = profile.id
        currentBaseUri = Uri.parse(profile.baseUrl)
        mainFrameFailed = false
        pageReady = false
        passwordAttempted = false
        fillConfiguration(profile)
        showConnecting(profile.baseUrl)
        webView.visibility = View.VISIBLE
        webView.loadUrl(
            "${profile.baseUrl}/",
            mapOf(
                "X-Codex-Client-Type" to "android",
                "X-Codex-Client-Mode" to "observer",
            ),
        )
    }

    private fun trySavedPasswordOrShowPage() {
        val password = currentProfile?.password
        if (password.isNullOrEmpty() || passwordAttempted) {
            showWebContent()
            return
        }

        passwordAttempted = true
        val quotedPassword = JSONObject.quote(password)
        val script = """
            (async function () {
              if (!document.getElementById('pw') || !document.getElementById('f')) return 'not-needed';
              try {
                const response = await fetch('/auth/login', {
                  method: 'POST',
                  headers: {'Content-Type': 'application/json'},
                  body: JSON.stringify({password: $quotedPassword})
                });
                if (!response.ok) return 'rejected';
                window.location.replace('/');
                return 'accepted';
              } catch (_) {
                return 'network-error';
              }
            })();
        """.trimIndent()
        webView.evaluateJavascript(script) { encoded ->
            when (encoded?.trim('"')) {
                "accepted" -> Unit // The replacement navigation will finish shortly.
                "rejected" -> showConfiguration(getString(R.string.error_saved_password))
                "network-error" -> onMainFrameFailure(getString(R.string.error_connection))
                else -> showWebContent()
            }
        }
    }

    private fun showWebContent() {
        pageReady = true
        mainFrameFailed = false
        setupOverlay.visibility = View.GONE
        appContent.visibility = View.VISIBLE
        webView.visibility = View.VISIBLE
        setConnectionStatus(true, currentBaseUri?.host ?: getString(R.string.status_connected))
        dispatchNativeReady()
        dispatchPendingShare()
    }

    private fun onMainFrameFailure(message: String) {
        mainFrameFailed = true
        pageReady = false
        setConnectionStatus(false, getString(R.string.status_disconnected))
        showConfiguration(message)
        // Keep the saved endpoint list visible after a failed connection. The
        // user can choose another address or retry explicitly; automatic
        // retries used to hide this form behind an endless reconnect loop.
    }

    private fun onNetworkAvailable() {
        if (mainFrameFailed) {
            setConnectionStatus(false, getString(R.string.status_disconnected))
        } else if (pageReady) {
            setConnectionStatus(true, currentBaseUri?.host ?: getString(R.string.status_connected))
            dispatchWindowEvent("codex-native-network-online")
        }
    }

    private fun onNetworkLost() {
        setConnectionStatus(false, getString(R.string.status_offline))
        dispatchWindowEvent("codex-native-network-offline")
    }

    private fun showConfiguration(error: String? = null) {
        endpointSelector.cancel()
        currentProfile?.let {
            editingProfileId = it.id
            fillConfiguration(it)
        }
        renderProfiles()
        setupOverlay.visibility = View.VISIBLE
        configurationForm.visibility = View.VISIBLE
        progressBar.visibility = View.GONE
        statusText.text = if (error == null) {
            getString(R.string.setup_title)
        } else {
            getString(R.string.error_connection_title)
        }
        statusDetail.text = error ?: getString(R.string.setup_description)
        statusDetail.visibility = View.VISIBLE
        retryButton.visibility = if (currentProfile == null) View.GONE else View.VISIBLE
        cancelButton.visibility = if (pageReady) View.VISIBLE else View.GONE
    }

    private fun showSelecting(profileCount: Int) {
        setupOverlay.visibility = View.VISIBLE
        configurationForm.visibility = View.GONE
        progressBar.visibility = View.VISIBLE
        statusText.text = getString(R.string.status_selecting_server)
        statusDetail.text = getString(R.string.status_testing_servers, profileCount)
        statusDetail.visibility = View.VISIBLE
        retryButton.visibility = View.GONE
        cancelButton.visibility = View.GONE
    }

    private fun showConnecting(serverUrl: String, status: String = getString(R.string.status_connecting)) {
        setupOverlay.visibility = View.VISIBLE
        configurationForm.visibility = View.GONE
        progressBar.visibility = View.VISIBLE
        statusText.text = status
        statusDetail.text = Uri.parse(serverUrl).host ?: serverUrl
        statusDetail.visibility = View.VISIBLE
        retryButton.visibility = View.GONE
        cancelButton.visibility = View.GONE
    }

    private fun fillConfiguration(profile: RemoteConnectionStore.Profile) {
        profileLabelInput.setText(profile.label)
        serverUrlInput.setText(profile.baseUrl)
        passwordInput.setText(profile.password.orEmpty())
        allowHttpCheckBox.isChecked = Uri.parse(profile.baseUrl).scheme.equals("http", true)
        saveProfileButton.text = getString(R.string.save_profile)
    }

    private fun beginNewProfile() {
        editingProfileId = null
        profileLabelInput.text.clear()
        serverUrlInput.text.clear()
        passwordInput.text.clear()
        allowHttpCheckBox.isChecked = false
        saveProfileButton.text = getString(R.string.add_profile)
        profileLabelInput.requestFocus()
    }

    private fun renderProfiles() {
        if (!::profilesContainer.isInitialized) return
        profilesContainer.removeAllViews()
        if (profiles.isEmpty()) {
            val empty = TextView(this).apply {
                text = getString(R.string.no_saved_profiles)
                setTextColor(ContextCompat.getColor(this@MainActivity, R.color.codex_muted_text))
                textSize = 12f
                setPadding(0, dp(4), 0, dp(4))
            }
            profilesContainer.addView(empty)
            return
        }

        profiles.forEach { profile ->
            val row = LinearLayout(this).apply {
                orientation = LinearLayout.HORIZONTAL
                gravity = android.view.Gravity.CENTER_VERTICAL
                setPadding(dp(10), dp(6), dp(4), dp(6))
                setBackgroundResource(R.drawable.remote_input_background)
            }
            val summary = TextView(this).apply {
                text = "${profile.label}\n${profile.baseUrl}"
                setTextColor(ContextCompat.getColor(this@MainActivity, R.color.codex_primary_text))
                textSize = 13f
                maxLines = 2
                ellipsize = android.text.TextUtils.TruncateAt.MIDDLE
                layoutParams = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f)
                setOnClickListener {
                    editingProfileId = profile.id
                    fillConfiguration(profile)
                }
            }
            val useButton = Button(this).apply {
                text = getString(R.string.use_profile)
                isAllCaps = false
                minWidth = 0
                setPadding(dp(8), 0, dp(8), 0)
                setOnClickListener { connect(profile) }
            }
            val deleteButton = Button(this).apply {
                text = getString(R.string.delete_profile)
                isAllCaps = false
                minWidth = 0
                setPadding(dp(8), 0, dp(8), 0)
                setOnClickListener { confirmDeleteProfile(profile) }
            }
            row.addView(summary)
            row.addView(useButton, LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, dp(44)))
            row.addView(deleteButton, LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, dp(44)))
            profilesContainer.addView(row, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply {
                bottomMargin = dp(8)
            })
        }
    }

    private fun confirmDeleteProfile(profile: RemoteConnectionStore.Profile) {
        AlertDialog.Builder(this)
            .setTitle(getString(R.string.delete_profile_title, profile.label))
            .setMessage(getString(R.string.delete_profile_message))
            .setPositiveButton(R.string.clear) { _, _ ->
                val wasCurrent = currentProfile?.id == profile.id
                profiles = profiles.filterNot { it.id == profile.id }
                connectionStore.saveProfiles(profiles)
                if (editingProfileId == profile.id) {
                    editingProfileId = null
                    if (profiles.isNotEmpty()) fillConfiguration(profiles.first()) else beginNewProfile()
                }
                if (wasCurrent) {
                    currentProfile = null
                    currentBaseUri = null
                    pageReady = false
                    mainFrameFailed = false
                    webView.stopLoading()
                    webView.loadUrl("about:blank")
                    appContent.visibility = View.GONE
                }
                renderProfiles()
                if (profiles.isEmpty()) showConfiguration()
            }
            .setNegativeButton(R.string.cancel, null)
            .show()
    }

    private fun dp(value: Int): Int = (value * resources.displayMetrics.density).toInt()

    private fun setConnectionStatus(connected: Boolean, text: String) {
        connectionStatusDot.setTextColor(
            ContextCompat.getColor(
                this,
                if (connected) R.color.connection_online else R.color.connection_offline,
            ),
        )
        connectionStatusText.text = text
    }

    private fun confirmClearConnection() {
        AlertDialog.Builder(this)
            .setTitle(R.string.clear_connection_title)
            .setMessage(R.string.clear_connection_message)
            .setPositiveButton(R.string.clear) { _, _ ->
                connectionStore.clear()
                CookieManager.getInstance().removeAllCookies(null)
                CookieManager.getInstance().flush()
                profiles = emptyList()
                editingProfileId = null
                currentProfile = null
                currentBaseUri = null
                pageReady = false
                webView.loadUrl("about:blank")
                serverUrlInput.text.clear()
                passwordInput.text.clear()
                allowHttpCheckBox.isChecked = false
                renderProfiles()
                showConfiguration()
            }
            .setNegativeButton(R.string.cancel, null)
            .show()
    }

    private fun isAllowedInWebView(uri: Uri): Boolean {
        val base = currentBaseUri ?: return false
        if (!uri.scheme.equals(base.scheme, true)) return false
        if (!uri.host.equals(base.host, true)) return false
        return effectivePort(uri) == effectivePort(base)
    }

    private fun effectivePort(uri: Uri): Int {
        if (uri.port >= 0) return uri.port
        return if (uri.scheme.equals("https", true)) 443 else 80
    }

    private fun openExternal(uri: Uri): Boolean {
        return try {
            startActivity(Intent(Intent.ACTION_VIEW, uri))
            true
        } catch (error: Exception) {
            Log.w(TAG, "No application can open $uri", error)
            true
        }
    }

    private fun dispatchNativeReady() {
        val detail = JSONObject()
            .put("clientId", clientId())
            .put("clientType", "android")
            .put("mode", "remote-observer")
            .put("version", BuildConfig.VERSION_NAME)
        dispatchWindowEvent("codex-native-ready", detail)
    }

    private fun dispatchWindowEvent(name: String, detail: JSONObject? = null) {
        if (!pageReady) return
        val eventName = JSONObject.quote(name)
        val detailValue = detail?.toString() ?: "null"
        webView.evaluateJavascript(
            "window.dispatchEvent(new CustomEvent($eventName,{detail:$detailValue}));",
            null,
        )
    }

    private fun clientId(): String {
        val prefs = getSharedPreferences(CLIENT_PREFS, MODE_PRIVATE)
        return prefs.getString(CLIENT_ID_KEY, null) ?: UUID.randomUUID().toString().also {
            prefs.edit().putString(CLIENT_ID_KEY, it).apply()
        }
    }

    private fun collectShareIntent(source: Intent?) {
        if (source == null) return
        if (source.action != Intent.ACTION_SEND && source.action != Intent.ACTION_SEND_MULTIPLE) return

        val text = source.getStringExtra(Intent.EXTRA_TEXT)?.takeIf(String::isNotBlank)
        val uris = mutableListOf<Uri>()
        source.clipData?.let { clip ->
            for (index in 0 until clip.itemCount) clip.getItemAt(index).uri?.let(uris::add)
        }
        if (uris.isEmpty()) {
            @Suppress("DEPRECATION")
            if (source.action == Intent.ACTION_SEND_MULTIPLE) {
                source.getParcelableArrayListExtra<Uri>(Intent.EXTRA_STREAM)?.let(uris::addAll)
            } else {
                source.getParcelableExtra<Uri>(Intent.EXTRA_STREAM)?.let(uris::add)
            }
        }

        synchronized(shareLock) {
            pendingShareText = text
            pendingShareUris.clear()
            shareDispatched = false
            uris.distinct().forEach { uri ->
                val key = uri.toString()
                pendingShareUris[key] = SharedContent(
                    uri = uri,
                    name = displayName(uri),
                    mimeType = contentResolver.getType(uri) ?: source.type ?: "application/octet-stream",
                )
            }
        }
    }

    private fun displayName(uri: Uri): String {
        if (uri.scheme == "content") {
            try {
                contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)
                    ?.use { cursor ->
                        if (cursor.moveToFirst()) {
                            val index = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME)
                            if (index >= 0) return cursor.getString(index)
                        }
                    }
            } catch (_: Exception) {
                // Fall back to the last path segment.
            }
        }
        return uri.lastPathSegment ?: getString(R.string.shared_file_default_name)
    }

    private fun pendingShareJson(): JSONObject {
        synchronized(shareLock) {
            val files = JSONArray()
            pendingShareUris.values.forEach { item ->
                files.put(
                    JSONObject()
                        .put("uri", item.uri.toString())
                        .put("name", item.name)
                        .put("mimeType", item.mimeType),
                )
            }
            return JSONObject()
                .put("text", pendingShareText ?: JSONObject.NULL)
                .put("files", files)
        }
    }

    private fun dispatchPendingShare() {
        synchronized(shareLock) {
            if (shareDispatched) return
        }
        val payload = pendingShareJson()
        val hasText = synchronized(shareLock) { !pendingShareText.isNullOrBlank() }
        val hasFiles = payload.optJSONArray("files")?.length()?.let { it > 0 } == true
        if (!hasText && !hasFiles) return
        synchronized(shareLock) { shareDispatched = true }
        dispatchWindowEvent("codex-native-share", payload)
    }

    private fun readSharedContent(uriText: String): String {
        val item = synchronized(shareLock) { pendingShareUris[uriText] }
            ?: return JSONObject().put("error", "not-authorized").toString()
        return try {
            val output = ByteArrayOutputStream()
            contentResolver.openInputStream(item.uri)?.use { input ->
                val buffer = ByteArray(DEFAULT_BUFFER_SIZE)
                var total = 0
                while (true) {
                    val count = input.read(buffer)
                    if (count < 0) break
                    total += count
                    if (total > MAX_SHARED_FILE_BYTES) {
                        return JSONObject().put("error", "file-too-large").toString()
                    }
                    output.write(buffer, 0, count)
                }
            } ?: return JSONObject().put("error", "unreadable").toString()

            JSONObject()
                .put("name", item.name)
                .put("mimeType", item.mimeType)
                .put("base64", Base64.encodeToString(output.toByteArray(), Base64.NO_WRAP))
                .toString()
        } catch (error: Exception) {
            JSONObject().put("error", error.message ?: "unreadable").toString()
        }
    }

    private fun showTaskNotification(state: String, title: String, detail: String) {
        val notification = TaskNotification(state, title, detail)
        if (
            Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
            ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) !=
            PackageManager.PERMISSION_GRANTED
        ) {
            pendingNotification = notification
            requestPendingNotificationPermission()
            return
        }
        CodexForegroundService.showTask(
            this,
            state,
            title,
            detail,
            currentProfile?.baseUrl.orEmpty(),
        )
    }

    private fun requestPendingNotificationPermission() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return
        val pending = pendingNotification ?: return
        if (!lifecycle.currentState.isAtLeast(Lifecycle.State.RESUMED)) return
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) ==
            PackageManager.PERMISSION_GRANTED
        ) {
            pendingNotification = null
            CodexForegroundService.showTask(
                this,
                pending.state,
                pending.title,
                pending.detail,
                currentProfile?.baseUrl.orEmpty(),
            )
            return
        }
        try {
            notificationPermissionLauncher.launch(Manifest.permission.POST_NOTIFICATIONS)
        } catch (error: IllegalStateException) {
            Log.w(TAG, "Notification permission request deferred", error)
        }
    }

    inner class AndroidBridge {
        @JavascriptInterface
        fun getClientInfo(): String = JSONObject()
            .put("clientId", clientId())
            .put("clientType", "android")
            .put("mode", "remote-observer")
            .put("version", BuildConfig.VERSION_NAME)
            .toString()

        @JavascriptInterface
        fun openSettings() {
            runOnUiThread { showConfiguration() }
        }

        @JavascriptInterface
        fun copyText(text: String) {
            runOnUiThread {
                val clipboard = getSystemService(ClipboardManager::class.java)
                clipboard.setPrimaryClip(ClipData.newPlainText(getString(R.string.app_name), text))
            }
        }

        @JavascriptInterface
        fun setTaskState(state: String, title: String?, detail: String?) {
            runOnUiThread {
                showTaskNotification(
                    state.take(32),
                    title?.take(120) ?: getString(R.string.notification_task_running),
                    detail?.take(240).orEmpty(),
                )
            }
        }

        @JavascriptInterface
        fun clearTaskState() {
            runOnUiThread { CodexForegroundService.clearTask(this@MainActivity) }
        }

        @JavascriptInterface
        fun getPendingShare(): String = pendingShareJson().toString()

        @JavascriptInterface
        fun readSharedContent(uri: String): String = this@MainActivity.readSharedContent(uri)

        @JavascriptInterface
        fun clearPendingShare() {
            synchronized(shareLock) {
                pendingShareText = null
                pendingShareUris.clear()
            }
        }
    }
}
