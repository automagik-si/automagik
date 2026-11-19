package ai.namastex.automagik

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ReleaseTest {
    private val sha = "a".repeat(64)
    private fun json(code: Any = 912345, url: String = "https://github.com/o/r/releases/download/build-912345/herdr-pocket.apk", hash: String = sha, name: String = "0.3.0") =
        """{"versionCode":$code,"versionName":"$name","url":"$url","sha256":"$hash","notes":"Drawer"}"""

    @Test fun parsesThePublishedManifest() {
        val r = Release.parse(json())!!
        assertEquals(912345L, r.versionCode); assertEquals("0.3.0 (912345)", r.label); assertEquals("Drawer", r.notes)
    }

    @Test fun refusesAnythingItCantTrust() {
        assertNull(Release.parse(json(url = "http://example.com/a.apk")))
        assertNull(Release.parse(json(hash = "abc")))
        assertNull(Release.parse(json(code = 0)))
        assertNull(Release.parse(json(code = "\"x\"")))
        assertNull(Release.parse("<html>not found</html>"))
        assertEquals(sha, Release.parse(json(hash = "A".repeat(64)))!!.sha256)
    }

    @Test fun takesHttpOnlyFromALocalTestServer() {
        assertNull(Release.parse(json(url = "http://10.0.2.2:8000/a.apk"), cleartext = false))
        assertEquals("http://10.0.2.2:8000/a.apk", Release.parse(json(url = "http://10.0.2.2:8000/a.apk"), cleartext = true)!!.url)
        assertNull(Release.parse(json(url = "ftp://example.com/a.apk"), cleartext = true))
    }

    @Test fun offersOnlyNewerBuilds() {
        val r = Release.parse(json())!!
        assertTrue(Updater.isNewer(r, 912344)); assertFalse(Updater.isNewer(r, 912345)); assertFalse(Updater.isNewer(r, 999999))
    }

    // The monorepo's builds (docs/rfcs/0011, "Pocket"): versionCode is major*1e6 + minor*1e3 + patch, far above the
    // minutes-since-2025 codes the old automagik-pocket builds carry, and the APK stays on its own vX.Y.Z release.
    @Test fun takesTheMonorepoBuildOverAnOldOneAndNeverGoesBack() {
        val monorepo = Release.parse(json(code = 3057000, name = "3.57.0",
            url = "https://github.com/automagik-si/automagik/releases/download/v3.57.0/automagik-pocket-3.57.0.apk"))!!
        assertTrue(Updater.isNewer(monorepo, 966485))
        assertFalse(Updater.isNewer(monorepo, 3057000))
        // A pointer that names an older build (a forged or stale latest.json) is never offered.
        val older = Release.parse(json(code = 966485, name = "0.21.0"))!!
        assertFalse(Updater.isNewer(older, 3057000))
        assertFalse(Updater.isNewer(Release.parse(json(code = 3056999, name = "3.56.999"))!!, 3057000))
    }

    @Test fun installsOnlyTheDownloadWhoseHashLatestJsonNames() {
        val r = Release.parse(json())!!
        assertTrue(r.matches(sha)); assertTrue(r.matches(sha.uppercase()))
        assertFalse(r.matches("b".repeat(64))); assertFalse(r.matches(""))
    }
}
