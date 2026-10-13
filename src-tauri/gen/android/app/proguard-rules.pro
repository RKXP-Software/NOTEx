# Add project specific ProGuard rules here.
# You can control the set of applied configuration files using the
# proguardFiles setting in build.gradle.
#
# For more details, see
#   http://developer.android.com/guide/developing/tools/proguard.html

# If your project uses WebView with JS, uncomment the following
# and specify the fully qualified class name to the JavaScript interface
# class:
#-keepclassmembers class fqcn.of.javascript.interface.for.webview {
#   public *;
#}

# Uncomment this to preserve the line number information for
# debugging stack traces.
#-keepattributes SourceFile,LineNumberTable

# If you keep the line number information, uncomment this to
# hide the original source file name.
#-renamesourcefileattribute SourceFile
# ---- NOTEx: leitor de QR code (plugin barcode-scanner, CameraX + ML Kit) ----
# O ML Kit descobre seus componentes pelo nome (reflexão, a partir do manifesto). Sem estas
# regras o R8 renomeia/remove as classes e o app fecha ao abrir a câmera.
-keep class app.tauri.barcodescanner.** { *; }
-keep class com.google.mlkit.** { *; }
-keep class com.google.firebase.components.** { *; }
-keep class * implements com.google.firebase.components.ComponentRegistrar { *; }
-keep class com.google.android.gms.internal.mlkit_vision_barcode.** { *; }
-keep class com.google.android.gms.internal.mlkit_vision_common.** { *; }
-keep class androidx.camera.** { *; }
-dontwarn com.google.mlkit.**
-dontwarn com.google.android.gms.**

# ---- NOTEx: PIN/digital do aparelho (plugin biometric, AndroidX Biometric) ----
-keep class app.tauri.biometric.** { *; }
-keep class androidx.biometric.** { *; }

# Linhas nos rastros de erro (ajuda a diagnosticar falhas no celular).
-keepattributes SourceFile,LineNumberTable