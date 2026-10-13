package com.rkxp.notex

import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.provider.OpenableColumns
import android.webkit.JavascriptInterface
import android.webkit.WebView
import androidx.activity.enableEdgeToEdge
import org.json.JSONArray
import org.json.JSONObject

/**
 * Abre o NOTEx. Também recebe arquivos de outros apps ("Abrir com", Compartilhar) e os guarda para
 * a interface buscar pela ponte `NotexAndroid.takePending()` (JSON com [{name, text}]). A interface
 * mostra o texto só para leitura, com opção de salvar num caderno.
 */
class MainActivity : TauriActivity() {
  private val pending = ArrayList<JSONObject>()
  private var webView: WebView? = null

  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
    if (savedInstanceState == null) collect(intent)
  }

  override fun onNewIntent(intent: Intent) {
    super.onNewIntent(intent)
    setIntent(intent)
    collect(intent)
    // O app já estava aberto: o evento de foco faz a interface buscar o que chegou.
    webView?.post { webView?.evaluateJavascript("window.dispatchEvent(new Event('focus'))", null) }
  }

  override fun onWebViewCreate(webView: WebView) {
    this.webView = webView
    webView.addJavascriptInterface(Bridge(), "NotexAndroid")
  }

  inner class Bridge {
    @JavascriptInterface
    fun takePending(): String = synchronized(pending) {
      val json = JSONArray(pending).toString()
      pending.clear()
      json
    }
  }

  private fun collect(intent: Intent?) {
    if (intent == null) return
    when (intent.action) {
      Intent.ACTION_VIEW -> intent.data?.let { read(it) }
      Intent.ACTION_SEND -> {
        val stream = if (android.os.Build.VERSION.SDK_INT >= 33) {
          intent.getParcelableExtra(Intent.EXTRA_STREAM, Uri::class.java)
        } else {
          @Suppress("DEPRECATION") intent.getParcelableExtra<Uri>(Intent.EXTRA_STREAM)
        }
        val shared = intent.getStringExtra(Intent.EXTRA_TEXT)
        when {
          stream != null -> read(stream)
          shared != null -> add("Texto compartilhado.txt", shared)
        }
      }
    }
    // Já consumido: não reaparece ao girar a tela ou voltar do segundo plano.
    intent.action = Intent.ACTION_MAIN
    intent.data = null
  }

  private fun add(name: String, text: String) {
    synchronized(pending) { pending.add(JSONObject().put("name", name).put("text", text)) }
  }

  private fun read(uri: Uri) {
    try {
      var name = uri.lastPathSegment?.substringAfterLast('/') ?: "arquivo.txt"
      contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { c ->
        if (c.moveToFirst()) c.getString(0)?.let { name = it }
      }
      val max = 10 * 1024 * 1024
      val bytes = contentResolver.openInputStream(uri)?.use { input ->
        val out = java.io.ByteArrayOutputStream()
        val buf = ByteArray(16 * 1024)
        while (out.size() <= max) {
          val n = input.read(buf)
          if (n < 0) break
          out.write(buf, 0, n)
        }
        out.toByteArray()
      } ?: return
      if (bytes.size > max) return
      if (!name.contains('.')) name += ".txt"
      add(name, String(bytes, Charsets.UTF_8))
    } catch (_: Exception) {
      // Arquivo ilegível ou sem permissão: ignora.
    }
  }
}
