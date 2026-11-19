import java.util.Properties

plugins { id("com.android.application"); id("org.jetbrains.kotlin.android"); id("org.jetbrains.kotlin.plugin.compose"); id("com.google.devtools.ksp") }

/**
 * Genie (`genie-clay`), the pet every bot wears until its own is fetched from the desktop, comes from the Bot team's one
 * pet source (apps/bots-dsh/src/host/pets) at build time, into assets/pets/genie-clay: nothing is copied into git. A
 * change to that art reaches phones with the next Pocket build, not by itself (scripts/lane.ts doesn't watch it).
 */
abstract class BundlePet : DefaultTask() {
    @get:InputDirectory abstract val source: DirectoryProperty
    @get:Input abstract val pet: Property<String>
    @get:OutputDirectory abstract val output: DirectoryProperty
    @TaskAction fun copy() {
        val out = output.get().asFile
        out.deleteRecursively()
        val into = File(out, "pets/${pet.get()}").apply { mkdirs() }
        for (name in listOf("pet.json", "spritesheet.webp", "sleep.webp")) File(source.get().asFile, name).copyTo(File(into, name))
    }
}
val bundleGenie = tasks.register<BundlePet>("bundleGeniePet") {
    pet.set("genie-clay")
    source.set(rootProject.layout.projectDirectory.dir("../../bots-dsh/src/host/pets/genie-clay"))
}
androidComponents { onVariants { it.sources.assets?.addGeneratedSourceDirectory(bundleGenie, BundlePet::output) } }

// The GitHub release key. CI passes it in the environment; a maintainer's machine keeps it in
// ~/.config/herdr-pocket/signing.properties. Without it, GitHub builds are debug-signed.
val signing = Properties().apply {
    val local = File(System.getProperty("user.home"), ".config/herdr-pocket/signing.properties")
    if (local.isFile) local.inputStream().use(::load)
    System.getenv("POCKET_SIGNING_STORE")?.let { setProperty("storeFile", it) }
    val password = System.getenv("POCKET_SIGNING_PASSWORD") ?: getProperty("passwordFile")?.let { File(it).takeIf(File::isFile)?.readText()?.trim() }
    password?.let { setProperty("password", it) }
}
// One shared debug key for debug APKs (docs/decisions/shared-debug-signing-key.md): CI passes
// POCKET_DEBUG_STORE, a local build can pass -Ppocket.debugStore, and without either AGP's own
// debug key stays. The environment variable wins over the Gradle property, and a relative path
// resolves against this app module's folder. Debug only: the release signing config and the
// release build type are untouched.
val sharedDebugStore: String? = System.getenv("POCKET_DEBUG_STORE")?.takeIf { it.isNotBlank() }
    ?: providers.gradleProperty("pocket.debugStore").orNull?.takeIf { it.isNotBlank() }
// The Play bundle takes an explicitly supplied upload key. GitHub releases use their own config above.
val playStore = providers.environmentVariable("POCKET_PLAY_SIGNING_STORE").orNull?.takeIf { it.isNotBlank() }
val playAlias = providers.environmentVariable("POCKET_PLAY_SIGNING_ALIAS").orNull?.takeIf { it.isNotBlank() }
val playStorePassword = providers.environmentVariable("POCKET_PLAY_SIGNING_PASSWORD").orNull?.takeIf { it.isNotBlank() }
val playKeyPassword = providers.environmentVariable("POCKET_PLAY_SIGNING_KEY_PASSWORD").orNull?.takeIf { it.isNotBlank() }
val hasPlaySigning = playStore != null && playAlias != null && playStorePassword != null
val requirePlaySigning = tasks.register("requirePlaySigning") {
    doLast {
        check(hasPlaySigning) {
            "Set POCKET_PLAY_SIGNING_STORE, POCKET_PLAY_SIGNING_ALIAS and POCKET_PLAY_SIGNING_PASSWORD to sign the Play bundle."
        }
    }
}
tasks.configureEach {
    if (name == "packagePlayReleaseBundle" || name == "bundlePlayRelease") {
        dependsOn(requirePlaySigning)
    }
}
// The release version is the monorepo's one version (AGENTS.md): the root package.json, three levels above this
// Gradle project, set by bun scripts/version.ts on each release. Never edited here.
val appVersion: String = (groovy.json.JsonSlurper().parse(rootProject.file("../../../package.json")) as Map<*, *>)["version"] as String
// One versionCode per version: major*1_000_000 + minor*1_000 + patch, so 3.57.0 is 3057000, above every build the old
// automagik-pocket published (minutes since 2025). Minor and patch stop at 999 (scripts/version.ts refuses more), or
// 3.1000.0 would be 4.0.0's code (docs/rfcs/0011-monorepo-parts-and-releases.md, "Pocket").
val versionFromName: Long = Regex("""^(\d+)\.(\d+)\.(\d+)$""").matchEntire(appVersion)?.destructured
    ?.let { (major, minor, patch) ->
        require(minor.toLong() <= 999 && patch.toLong() <= 999) { "version $appVersion: minor and patch stop at 999 (Pocket's versionCode)" }
        major.toLong() * 1_000_000 + minor.toLong() * 1_000 + patch.toLong()
    } ?: error("not a version: $appVersion")
// Testing self-update locally: -Ppocket.versionCode=1 builds an "older" copy that a normal build then updates.
val versionCodeOverride = providers.gradleProperty("pocket.versionCode").map { it.toLong() }

android {
    namespace = "ai.namastex.automagik"
    compileSdk = 36
    defaultConfig { applicationId = "ai.namastex.automagik"; minSdk = 26; versionCode = versionCodeOverride.orElse(versionFromName).get().toInt(); versionName = appVersion; testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
        // iroh ships a 9–14 MB library per ABI: phones, and x86_64 for Intel emulators. 32-bit x86 and MIPS phones are long gone.
        ndk { abiFilters += setOf("arm64-v8a", "armeabi-v7a", "x86_64") }
    }
    signingConfigs {
        // Only debug builds select the shared PR debug key.
        sharedDebugStore?.let { store -> create("sharedDebug") {
            storeFile = file(store); storePassword = "android"; keyAlias = "androiddebugkey"; keyPassword = "android" } }
        if (signing.getProperty("storeFile") != null && signing.getProperty("password") != null) create("pocket") {
            storeFile = file(signing.getProperty("storeFile")); storePassword = signing.getProperty("password")
            keyAlias = signing.getProperty("alias", "pocket"); keyPassword = signing.getProperty("password") }
        if (hasPlaySigning) create("playUpload") {
            storeFile = file(requireNotNull(playStore))
            storePassword = playStorePassword
            keyAlias = playAlias
            keyPassword = playKeyPassword ?: playStorePassword
        }
    }
    flavorDimensions += "distribution"
    productFlavors {
        create("github") {
            dimension = "distribution"
            targetSdk = 35
            signingConfig = signingConfigs.findByName("pocket") ?: signingConfigs.getByName("debug")
            // Installed GitHub APKs check the rolling pocket-lane. Forks and local tests can override the URL.
            val updates = providers.gradleProperty("pocket.updateUrl").orElse("https://github.com/automagik-si/automagik/releases/download/pocket-lane/latest.json")
            buildConfigField("String", "UPDATE_URL", "\"${updates.get()}\"")
        }
        create("play") {
            dimension = "distribution"
            targetSdk = 36
            signingConfig = signingConfigs.findByName("playUpload")
        }
    }
    buildFeatures { compose = true; buildConfig = true }
    buildTypes {
        // Debug builds use the release key too when it's here, so a build from Android Studio and the published ones
        // update each other. Else the shared debug key when one is provided, else AGP's own debug key.
        debug { (signingConfigs.findByName("pocket") ?: signingConfigs.findByName("sharedDebug"))?.let { signingConfig = it } }
        // Release signing comes from the selected flavor.
        release { isMinifyEnabled = false }
    }
    compileOptions { sourceCompatibility = JavaVersion.VERSION_17; targetCompatibility = JavaVersion.VERSION_17 }
    kotlinOptions { jvmTarget = "17" }
    packaging { resources.excludes += setOf("META-INF/versions/9/OSGI-INF/MANIFEST.MF", "META-INF/DEPENDENCIES", "META-INF/LICENSE*", "META-INF/NOTICE*",
        // The iroh jar also carries desktop libraries; Android takes its own from iroh-android's jni/.
        "darwin-*/**", "linux-*/**", "win32-*/**")
        // Compressed in the APK: about half the download, unpacked once at install.
        jniLibs.useLegacyPackaging = true }
    testOptions {
        unitTests.isReturnDefaultValues = true
        // The Compose UI test launches the app's test activity, so Robolectric needs the merged resources and manifest.
        unitTests.isIncludeAndroidResources = true
        // Robolectric takes a lock at <user.home>/.robolectric-download-lock and reads its android-all
        // jar from <user.home>/.m2/repository. A sandboxed pane has a read-only home, so the lock fails
        // ("Couldn't create lock file"). Only then give the test JVMs a writable home under build/ (the
        // lock lands there) and point Robolectric's resolver at the shared repository: a preset
        // -Dmaven.repo.local wins, otherwise the shared ~/.m2/repository is read in place. In that
        // sandbox/read-only-home case a settings.xml localRepository is not consulted. A writable home
        // (developer machine, CI) sets nothing, so the test JVMs keep the real user.home and Robolectric
        // keeps its normal resolution (~/.m2, a settings.xml localRepository honoured) as before #773.
        if (!File(System.getProperty("user.home")).canWrite()) {
            val sharedMavenRepository = System.getProperty("maven.repo.local")?.takeIf { it.isNotBlank() }
                ?: File(System.getProperty("user.home"), ".m2/repository").absolutePath
            unitTests.all { test ->
                val robolectricHome = project.layout.buildDirectory.dir("robolectric-home").get().asFile
                test.doFirst { robolectricHome.mkdirs() }
                test.systemProperty("user.home", robolectricHome.absolutePath)
                test.systemProperty("maven.repo.local", sharedMavenRepository)
            }
        }
    }
}
// An exported-but-empty Android prefs name is an empty path to AGP, which makes the default debug
// keystore a relative file: validateSigningDebug finds no parent to create, and packaging resolves
// it against the project while the task resolves it against the daemon's working directory. On a
// read-only home, pin the debug keystore (and the task's default location, so AGP still creates it)
// to the stable folder settings.gradle.kts uses when no name is adopted. A named folder, a writable
// home or the release key keeps AGP's own location.
val stableDebugKeystore = File(gradle.gradleUserHomeDir, "android-user-home/debug.keystore")
val emptyAndroidPrefsExport = listOf("ANDROID_USER_HOME", "ANDROID_SDK_HOME", "ANDROID_PREFS_ROOT")
    .any { System.getenv(it)?.isEmpty() == true || System.getProperty(it)?.isEmpty() == true }
if (emptyAndroidPrefsExport && !File(System.getProperty("user.home")).canWrite() &&
    android.signingConfigs.findByName("pocket") == null) {
    android.signingConfigs.getByName("debug").storeFile = stableDebugKeystore
    tasks.withType(com.android.build.gradle.internal.tasks.ValidateSigningTask::class.java).configureEach {
        val validateTask = this
        // @Internal, read by the task action, so setting it here is not an input change.
        doFirst { validateTask.defaultDebugKeystoreLocation.set(stableDebugKeystore) }
    }
}
dependencies {
    implementation(platform("androidx.compose:compose-bom:2025.04.01"))
    implementation("androidx.core:core-ktx:1.16.0")
    implementation("androidx.activity:activity-compose:1.10.1")
    implementation("androidx.lifecycle:lifecycle-viewmodel-compose:2.9.0")
    implementation("androidx.lifecycle:lifecycle-runtime-compose:2.9.0")
    implementation("androidx.compose.material3:material3")
    implementation("androidx.compose.material:material-icons-extended")
    implementation("androidx.compose.ui:ui-tooling-preview")
    debugImplementation("androidx.compose.ui:ui-tooling")
    implementation("androidx.webkit:webkit:1.13.0")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.10.2")
    // iroh: dial a paired desktop by its key; direct when it can, an end-to-end encrypted relay when it can't.
    implementation("computer.iroh:iroh-android:1.2.0")
    // JNA, which iroh's bindings load, pinned above the 5.15.0 that iroh-android 1.2.0 asks for: 5.15.0's
    // libjnidispatch.so isn't 16 KB page-size ready (x86_64 LOAD segments 4 KB aligned; arm64 read-only RELRO
    // ends inside a writable page), and Play requires it for apps targeting API 35+. 5.17.0's AAR is 16 KB aligned.
    // The AAR is the Android build (classes plus jni/<abi>/libjnidispatch.so); iroh-android already leaves out the
    // desktop jar, so this is the only JNA in the APK. Remove the pin once iroh-android depends on JNA 5.17 or newer.
    implementation("net.java.dev.jna:jna:5.17.0@aar")
    // A bundled QR scanner (camera + ZXing): works without Google Play services.
    implementation("com.journeyapps:zxing-android-embedded:4.3.0")
    // Draws the desktop's own program icons (SVG), read from the person's desktop at runtime.
    implementation("com.caverock:androidsvg-aar:1.4")
    // The Teams tab's local cache (SQLite through Room), so it opens at once and offline.
    implementation("androidx.room:room-runtime:2.7.2")
    implementation("androidx.room:room-ktx:2.7.2")
    ksp("androidx.room:room-compiler:2.7.2")
    testImplementation("junit:junit:4.13.2")
    testImplementation("org.json:json:20240303")
    // Room's DAO tests run on the JVM under Robolectric (the gate runs unit tests only, no device).
    testImplementation("org.robolectric:robolectric:4.14.1")
    testImplementation("androidx.test:core:1.6.1")
    testImplementation("org.jetbrains.kotlinx:kotlinx-coroutines-test:1.10.2")
    // Compose UI tests on the JVM (Robolectric): the composers' mic, without a device.
    testImplementation("androidx.compose.ui:ui-test-junit4")
    debugImplementation("androidx.compose.ui:ui-test-manifest")
}
