plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.example.chat"
    compileSdk = 34
    defaultConfig { applicationId = "com.example.chat"; minSdk = 24; targetSdk = 34 }
}
