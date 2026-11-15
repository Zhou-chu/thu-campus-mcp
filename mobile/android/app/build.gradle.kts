import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// 签名配置从仓库外读取：keystore.properties 已被 .gitignore 排除。
// 没有该文件时 release 仍可构建（未签名），便于在干净环境里跑通编译。
val keystorePropertiesFile = rootProject.file("keystore.properties")
val keystoreProperties = Properties().apply {
    if (keystorePropertiesFile.exists()) {
        keystorePropertiesFile.inputStream().use { load(it) }
    }
}
val hasReleaseSigning = keystorePropertiesFile.exists() &&
    keystoreProperties.getProperty("storeFile") != null

// 依赖版本锁定：gradle.lockfile 记录每个 configuration 解析出的精确版本，
// 依赖升级必须显式 --write-locks，否则构建直接失败（不让「顺手拿到新版本」发生）。
dependencyLocking {
    lockAllConfigurations()
}

android {
    namespace = "cn.edu.tsinghua.campusapp"
    compileSdk = 35

    defaultConfig {
        applicationId = "cn.edu.tsinghua.campusapp"
        minSdk = 24
        targetSdk = 35
        versionCode = 1
        versionName = "1.3.0"
    }

    signingConfigs {
        if (hasReleaseSigning) {
            create("release") {
                storeFile = file(keystoreProperties.getProperty("storeFile"))
                storePassword = keystoreProperties.getProperty("storePassword")
                keyAlias = keystoreProperties.getProperty("keyAlias")
                keyPassword = keystoreProperties.getProperty("keyPassword")
            }
        }
    }

    buildTypes {
        release {
            // 发布包开启 R8 混淆与代码压缩：WebView 外壳没有反射，危险面很小，
            // 收益是不把内部类名/方法名原样交出去，并顺带裁掉未用代码。
            isMinifyEnabled = true
            if (hasReleaseSigning) {
                signingConfig = signingConfigs.getByName("release")
            }
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro",
            )
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }
}

dependencies {
    // 只依赖系统组件与 AndroidX 基础库；不引入 Compose / Retrofit / Hilt。
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.appcompat:appcompat:1.7.0")

    // 纯 JVM 单测：地址与请求白名单策略（HostPolicy），不引入 Android 测试框架。
    testImplementation("junit:junit:4.13.2")
}