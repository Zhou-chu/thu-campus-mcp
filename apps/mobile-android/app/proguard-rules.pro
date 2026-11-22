# release 构建已开启 R8（isMinifyEnabled = true），默认规则来自 proguard-android-optimize.txt。
# 本工程不做反射、不序列化 DTO，因此不需要保留业务类名。
# 下面只保留两类容易在未来被误裁的东西：

# 1) WebView 的 JS 桥：如果以后加 addJavascriptInterface，方法必须带 @JavascriptInterface 且不能被裁剪。
-keepclassmembers class * {
    @android.webkit.JavascriptInterface <methods>;
}

# 2) 崩溃栈可读性：保留行号（类名/方法名仍然被重命名，不泄露实现细节）。
-keepattributes SourceFile,LineNumberTable
-renamesourcefileattribute SourceFile