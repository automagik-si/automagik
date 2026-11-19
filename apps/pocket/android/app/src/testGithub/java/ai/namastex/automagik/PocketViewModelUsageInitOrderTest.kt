package ai.namastex.automagik

import android.app.Application
import androidx.lifecycle.viewModelScope
import androidx.test.core.app.ApplicationProvider
import java.io.File
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicReference
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.cancel
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.setMain
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotSame
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * The test application, which lets the test pause the production constructor at the start of the updater's window:
 * [PocketViewModel]'s early `init` calls `ProgramIcons.load(application)`, which asks for the app's files directory.
 * Only the test overrides this; the app has no seam for it.
 */
class ProgramIconsProbeApplication : Application() {
    /** Invoked on whichever thread asks for the files directory, before the real directory is handed out. */
    @Volatile var onFilesDir: (() -> Unit)? = null
    override fun getFilesDir(): File {
        onFilesDir?.invoke()
        return super.getFilesDir()
    }
}

/**
 * #762, found by the #761 review: the early `init` block registered `Updater.usage` before the fields its lambda reads
 * (`onScreen`, `watchText`) were initialised. A download finishing in that window called `usage()` and the non-null
 * field read threw on the updater's thread. This is the issue's repro with the production constructor: a second thread
 * calls the registered lambda while the constructor is paused right where the old code had registered it; the test
 * asserts that neither the call nor the construction throws.
 *
 * On this branch #761 (moving `onScreen` above `init`) is not merged, so on the unfixed tree the NPE surfaces on
 * `foreground`/`onScreen` before it ever reaches `watchText`. The test therefore asserts that no call throws, not a
 * field name.
 */
@OptIn(ExperimentalCoroutinesApi::class)
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], application = ProgramIconsProbeApplication::class)
class PocketViewModelUsageInitOrderTest {
    @Test fun anEarlyUsageCallDuringConstructionDoesNotThrow() {
        Dispatchers.setMain(StandardTestDispatcher())
        val app = ApplicationProvider.getApplicationContext<ProgramIconsProbeApplication>()
        app.getSharedPreferences("pocket", 0).edit().clear().commit()
        val previousUsage = Updater.usage
        val previousCurrent = PocketViewModel.current
        val earlyFailures = CopyOnWriteArrayList<Throwable>()
        val constructionFailures = CopyOnWriteArrayList<Throwable>()
        val made = CopyOnWriteArrayList<PocketViewModel>()
        try {
            repeat(ATTEMPTS) { attempt ->
                val entered = CountDownLatch(1)
                val release = CountDownLatch(1)
                val fired = AtomicBoolean(false)
                // Every attempt starts from the updater's own default instead of the previous view model's lambda.
                Updater.usage = previousUsage
                app.onFilesDir = {
                    if (fired.compareAndSet(false, true)) {
                        entered.countDown()
                        release.await(10, TimeUnit.SECONDS)
                    }
                }
                val madeHere = AtomicReference<PocketViewModel>()
                val constructor = Thread({
                    try { madeHere.set(PocketViewModel(app)) } catch (t: Throwable) { constructionFailures += t }
                }, "pocket-viewmodel-construction-$attempt").apply { start() }
                // The production constructor is now paused inside ProgramIcons.load, right after the old registration.
                assertTrue("construction $attempt never reached ProgramIcons.load", entered.await(10, TimeUnit.SECONDS))
                val caller = Thread({
                    try { Updater.usage() } catch (t: Throwable) { earlyFailures += t }
                }, "updater-early-usage-$attempt").apply { start() }
                caller.join(10_000)
                release.countDown()
                constructor.join(10_000)
                assertTrue("construction $attempt did not finish", !constructor.isAlive)
                val viewModel = madeHere.get()
                assertTrue("construction $attempt produced no view model", viewModel != null)
                made += viewModel!!
                assertNotSame("construction $attempt did not register its usage lambda", previousUsage, Updater.usage)
                // After construction every field the lambda reads exists, so this call must be safe as well.
                Updater.usage()
            }
        } finally {
            app.onFilesDir = null
            made.forEach { it.viewModelScope.cancel() }
            PocketViewModel.current = previousCurrent
            Updater.usage = previousUsage
            Dispatchers.resetMain()
        }
        val constructionReport = constructionFailures.joinToString("\n\n") { it.stackTraceToString() }
        assertTrue("${constructionFailures.size} construction(s) threw:\n$constructionReport", constructionFailures.isEmpty())
        assertEquals("every attempt constructs its view model", ATTEMPTS, made.size)
        val earlyReport = earlyFailures.joinToString("\n\n") { it.stackTraceToString() }
        assertTrue("${earlyFailures.size} early Updater.usage() call(s) threw while the view model was being constructed " +
            "(the #762 NPE; on this branch it surfaces on foreground/onScreen before watchText because #761 is not " +
            "merged):\n$earlyReport", earlyFailures.isEmpty())
    }

    private companion object { const val ATTEMPTS = 10 }
}
