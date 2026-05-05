# ============================================================================
# kotlinx.serialization
# ============================================================================
# Keep generated $$serializer companions and Companion fields. Without these,
# R8 strips them and Json.decodeFromString() throws SerializationException.
-keepattributes *Annotation*, InnerClasses
-dontnote kotlinx.serialization.AnnotationsKt

-keep,includedescriptorclasses class com.tachibanayu24.ccremote.**$$serializer { *; }
-keepclassmembers class com.tachibanayu24.ccremote.** {
    *** Companion;
}
-keepclasseswithmembers class com.tachibanayu24.ccremote.** {
    kotlinx.serialization.KSerializer serializer(...);
}
# Models marked @Serializable need their fields preserved by name.
-keep,allowobfuscation,allowshrinking @kotlinx.serialization.Serializable class com.tachibanayu24.ccremote.**

# ============================================================================
# Ktor + OkHttp
# ============================================================================
-dontwarn org.slf4j.**
-dontwarn org.conscrypt.**
-dontwarn org.openjsse.**
-dontwarn javax.annotation.**
-dontwarn kotlinx.atomicfu.**

# Ktor uses reflection on engine selection.
-keepclasseswithmembers class io.ktor.client.engine.okhttp.** { *; }

# ============================================================================
# Firebase Messaging
# ============================================================================
# Pre-bundled Firebase rules cover most of this; the remaining piece is to
# preserve our own Service so the manifest reference resolves after R8.
-keep class com.tachibanayu24.ccremote.notification.CcRemoteMessagingService { *; }
-keep class com.tachibanayu24.ccremote.notification.ApprovalActionReceiver { *; }
-keep class com.tachibanayu24.ccremote.CcRemoteApp { *; }
-keep class com.tachibanayu24.ccremote.MainActivity { *; }

# ============================================================================
# Compose
# ============================================================================
# Compose ships with consumer rules; this is a defensive guard for the
# ones R8 occasionally drops on minor version mismatches.
-keep class androidx.compose.runtime.** { *; }
-keepclassmembers class * {
    @androidx.compose.runtime.Composable <methods>;
}

# Downloadable Google Fonts via Compose. Consumer rules usually cover this,
# but keep the public API as a defensive guard so reflection-based provider
# resolution doesn't break under minify on minor compose-ui version drift.
-keep class androidx.compose.ui.text.googlefonts.** { *; }
