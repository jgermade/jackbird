// Maven Central through Google's mirror of it, for every build on a CI runner (the Android app,
// its plugins and its buildSrc): Maven Central answers runners' shared addresses "429 Too Many
// Requests" at times, which Gradle reports as "Could not find" (kotlin-stdlib 2.3.21, three
// times on 2026-11-19, one of them the release's APK). The workflows copy this file into
// ~/.gradle/init.d/ before building. Each `mavenCentral()` is pointed at the mirror; the other
// repositories are left as they are.
val mirror = uri("https://maven-central.storage-download.googleapis.com/maven2/")

fun RepositoryHandler.throughMirror() = all {
    if (this is MavenArtifactRepository && url.toString().trimEnd('/') == "https://repo.maven.apache.org/maven2") {
        setUrl(mirror)
    }
}

beforeSettings {
    pluginManagement.repositories.throughMirror()
    dependencyResolutionManagement.repositories.throughMirror()
}

allprojects {
    buildscript.repositories.throughMirror()
    repositories.throughMirror()
}
