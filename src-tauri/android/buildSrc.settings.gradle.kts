// The Android project's buildSrc (made by `tauri android init`) takes its `kotlin-dsl` plugin, and
// Kotlin with it, from Gradle's plugin portal alone, which sends Kotlin on to Maven Central; there
// a CI runner's shared address is answered "429 Too Many Requests" at times, which Gradle reports
// as "Could not find" (kotlin-stdlib 2.3.21, 2026-11-19). Copied in as buildSrc/settings.gradle.kts
// by the workflows that build the app: Maven Central first (Google's mirror of it, through
// maven-central-mirror.init.gradle.kts), the portal for the plugins' markers, Google.
pluginManagement {
    repositories {
        mavenCentral()
        gradlePluginPortal()
        google()
    }
}
