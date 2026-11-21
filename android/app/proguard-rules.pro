# Project-specific R8/ProGuard keep rules for PG Buddy (Capacitor 8)
-keep class com.pgbuddy.app.** { *; }
-keepclassmembers class * {
    @android.webkit.JavascriptInterface <methods>;
}
-keepattributes SourceFile,LineNumberTable
-renamesourcefileattribute SourceFile
