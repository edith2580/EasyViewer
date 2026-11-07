package com.easyviewer.app

import android.content.res.Configuration
import android.graphics.Color
import android.os.Build
import android.os.Bundle
import android.view.View
import android.webkit.JavascriptInterface
import android.webkit.WebView
import androidx.activity.enableEdgeToEdge
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import androidx.core.view.updatePadding

class MainActivity : TauriActivity() {
  private var currentThemeMode: String = "light"

  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
    WindowCompat.setDecorFitsSystemWindows(window, false)
    val isNightMode =
      (resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK) ==
        Configuration.UI_MODE_NIGHT_YES
    currentThemeMode = if (isNightMode) "dark" else "light"
    applySystemBarTheme(currentThemeMode)
    setupSystemBarsInsets()
  }

  override fun onStart() {
    super.onStart()
    applySystemBarTheme(currentThemeMode)
    setupSystemBarsInsets()
  }

  override fun onResume() {
    super.onResume()
    applySystemBarTheme(currentThemeMode)
    requestInsetsUpdate()
  }

  override fun onWebViewCreate(webView: WebView) {
    super.onWebViewCreate(webView)
    webView.addJavascriptInterface(AndroidSystemBarBridge(), "__EASYVIEWER_ANDROID__")
    webView.post {
      applySystemBarTheme(currentThemeMode)
      setupSystemBarsInsets()
      requestInsetsUpdate()
    }
  }

  override fun onWindowFocusChanged(hasFocus: Boolean) {
    super.onWindowFocusChanged(hasFocus)
    if (hasFocus) {
      applySystemBarTheme(currentThemeMode)
      requestInsetsUpdate()
    }
  }

  inner class AndroidSystemBarBridge {
    @JavascriptInterface
    fun setSystemBarTheme(theme: String) {
      runOnUiThread {
        currentThemeMode = theme.lowercase()
        applySystemBarTheme(currentThemeMode)
      }
    }
  }

  private fun applySystemBarTheme(theme: String) {
    val bgColor = when (theme) {
      "dark" -> Color.parseColor("#111827")
      "sepia" -> Color.parseColor("#F8F1E3")
      else -> Color.parseColor("#FFFFFF")
    }
    val useDarkIcons = theme != "dark"

    @Suppress("DEPRECATION")
    window.statusBarColor = Color.TRANSPARENT
    @Suppress("DEPRECATION")
    window.navigationBarColor = Color.TRANSPARENT

    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
      window.isStatusBarContrastEnforced = false
      window.isNavigationBarContrastEnforced = false
    }

    window.decorView.setBackgroundColor(bgColor)
    findViewById<View>(android.R.id.content)?.setBackgroundColor(bgColor)

    val insetsController = WindowInsetsControllerCompat(window, window.decorView)
    insetsController.isAppearanceLightStatusBars = useDarkIcons
    insetsController.isAppearanceLightNavigationBars = useDarkIcons
  }

  private fun requestInsetsUpdate() {
    findViewById<View>(android.R.id.content)?.let { contentView ->
      ViewCompat.requestApplyInsets(contentView)
    }
  }

  private fun setupSystemBarsInsets() {
    val contentView = findViewById<View>(android.R.id.content) ?: return

    ViewCompat.setOnApplyWindowInsetsListener(contentView) { view, windowInsets ->
      val statusBarVisible = windowInsets.isVisible(WindowInsetsCompat.Type.statusBars())
      val navBarVisible = windowInsets.isVisible(WindowInsetsCompat.Type.navigationBars())
      val captionBarVisible = windowInsets.isVisible(WindowInsetsCompat.Type.captionBar())
      val imeVisible = windowInsets.isVisible(WindowInsetsCompat.Type.ime())

      val statusInsets = windowInsets.getInsets(WindowInsetsCompat.Type.statusBars())
      val navInsets = windowInsets.getInsets(WindowInsetsCompat.Type.navigationBars())
      val captionInsets = windowInsets.getInsets(WindowInsetsCompat.Type.captionBar())
      val cutoutInsets = windowInsets.getInsets(WindowInsetsCompat.Type.displayCutout())
      val imeInsets = windowInsets.getInsets(WindowInsetsCompat.Type.ime())

      val topInset = maxOf(
        if (statusBarVisible) statusInsets.top else 0,
        if (captionBarVisible) captionInsets.top else 0,
        cutoutInsets.top
      )

      val bottomInset = maxOf(
        if (navBarVisible) navInsets.bottom else 0,
        if (imeVisible) imeInsets.bottom else 0,
        cutoutInsets.bottom
      )

      val leftInset = maxOf(
        if (navBarVisible) navInsets.left else 0,
        cutoutInsets.left
      )

      val rightInset = maxOf(
        if (navBarVisible) navInsets.right else 0,
        cutoutInsets.right
      )

      view.updatePadding(
        left = leftInset,
        top = topInset,
        right = rightInset,
        bottom = bottomInset
      )

      WindowInsetsCompat.CONSUMED
    }

    ViewCompat.requestApplyInsets(contentView)
  }
}


