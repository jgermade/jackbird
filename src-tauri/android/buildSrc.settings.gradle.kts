// The Android project's buildSrc (made by `tauri android init`) takes its `kotlin-dsl` plugin, and
// Kotlin with it, from Gradle's plugin portal alone; the portal hands Kotlin on from Maven Central
// and sometimes fails to (CI, 2026-11-19: kotlin-stdlib 2.3.21 "not found" twice). Copied in as
// buildSrc/settings.gradle.kts by the workflows that build the app: Maven Central and Google too.
pluginManagement {
    repositories {
        gradlePluginPortal()
        mavenCentral()
        google()
    }
}
