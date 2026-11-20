package ai.namastex.automagik

import android.app.Application
import androidx.lifecycle.viewModelScope
import androidx.test.core.app.ApplicationProvider
import java.util.concurrent.CopyOnWriteArrayList
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.setMain
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * #760: the view model's init block launches three loops on [Dispatchers.IO] before the properties after it are
 * initialised. A fast IO worker reached `Background.whileShown(onScreen)` before `onScreen`'s `MutableStateFlow` was
 * assigned, so the non-null parameter check threw an uncaught NPE on a background thread (CrashLog recorded it and the
 * Teams sync loop died). This is the issue's repro: the production constructor, the real [Dispatchers.IO] init
 * dispatcher, and the process's uncaught-exception handler, with no seam that would hide the race.
 */
@OptIn(ExperimentalCoroutinesApi::class)
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class PocketViewModelInitOrderTest {
    @Test fun initLoopsNeverReadAnUninitialisedOnScreen() {
        Dispatchers.setMain(StandardTestDispatcher())
        val caught = CopyOnWriteArrayList<Pair<Thread, Throwable>>()
        val made = mutableListOf<PocketViewModel>()
        val previousCurrent = PocketViewModel.current
        val previousUsage = Updater.usage
        var previousHandler: Thread.UncaughtExceptionHandler? = null
        try {
            val app: Application = ApplicationProvider.getApplicationContext()
            app.getSharedPreferences("pocket", 0).edit().clear().commit()
            // PocketApplication.onCreate installs CrashLog's handler: capture that one, then collect everything thrown.
            previousHandler = Thread.getDefaultUncaughtExceptionHandler()
            Thread.setDefaultUncaughtExceptionHandler { thread, e -> caught += thread to e }
            // The issue's repro: 50 production constructions, so the IO init loops race each constructor's field writes.
            repeat(50) { made += PocketViewModel(app) }
            runBlocking { delay(1_000) }
        } finally {
            made.forEach { it.viewModelScope.cancel() }
            Thread.setDefaultUncaughtExceptionHandler(previousHandler)
            PocketViewModel.current = previousCurrent
            Updater.usage = previousUsage
            Dispatchers.resetMain()
        }
        val report = caught.joinToString("\n\n") { (thread, e) -> "on thread ${thread.name}:\n${e.stackTraceToString()}" }
        val npes = caught.filter { it.second is NullPointerException }
        assertTrue("${npes.size} NullPointerException(s) escaped the view model's init loops; every captured exception " +
            "(${caught.size}):\n$report", npes.isEmpty())
        assertTrue("${caught.size} exception(s) escaped the view model's init loops:\n$report", caught.isEmpty())
    }
}
