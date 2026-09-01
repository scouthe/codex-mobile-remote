plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.codex.mobile"
    compileSdk = 35

    buildFeatures {
        // Used for the native WebView user-agent and debug bridge diagnostics.
        buildConfig = true
    }

    defaultConfig {
        applicationId = "com.codex.mobile"
        minSdk = 24
        // Remote mode does not execute downloaded binaries, so it can target
        // the current Android security model instead of relying on W^X bypasses.
        targetSdk = 35
        versionCode = 3
        versionName = "0.2.0"
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro"
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

    packaging {
        resources {
            excludes += "/META-INF/{AL2.0,LGPL2.1}"
        }
    }

}

dependencies {
    implementation("androidx.core:core-ktx:1.15.0")
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("androidx.webkit:webkit:1.12.1")
    implementation("com.google.android.material:material:1.12.0")
}
