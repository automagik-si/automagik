package ai.namastex.automagik

/**
 * When and how a newer build installs, without Android: [Updater] gathers the facts, this decides.
 *
 * Silent: Android 12+ updates an app that updates itself without asking, when the session says so. Otherwise, or with
 * Install updates automatically off, a notification offers it and a tap runs Android's confirm prompt.
 */
object UpdatePolicy {
    /** How often a running app or its watch service looks for a newer build. */
    const val INTERVAL_MS = 6 * 60 * 60_000L
    /** Opening the app checks too, unless it already did this recently. */
    const val OPEN_DEBOUNCE_MS = 15 * 60_000L
    /** On screen, an update waits until nothing has been touched for this long (the phone left on a stand). */
    const val IDLE_MS = 10 * 60_000L
    /** Android 12: the first release where a session can skip the confirm prompt. */
    const val SILENT_SDK = 31

    enum class Route {
        /** Download now, install without asking once the app isn't in use. */
        SILENT,
        /** Post "Automagik X is ready · Install"; a tap runs the confirm flow. */
        NOTIFY,
    }

    fun isNewer(available: Long, installed: Long) = available > installed

    /**
     * [canInstall]: Android's "Install unknown apps" for Automagik, granted once. [metered]: a phone plan, where the
     * person chooses when to download a build of tens of megabytes.
     */
    fun route(sdk: Int, auto: Boolean, canInstall: Boolean, metered: Boolean) =
        if (sdk >= SILENT_SDK && auto && canInstall && !metered) Route.SILENT else Route.NOTIFY

    /**
     * Whether a downloaded update may install now. Installing closes the app, so never under someone using it: wait while
     * a terminal is open on screen, and on any other screen until it has been left untouched for [IDLE_MS]. Away from
     * the app (another app, or the screen off), it installs at once.
     */
    fun installNow(foreground: Boolean, terminalOpen: Boolean, sinceInputMs: Long) =
        !foreground || (!terminalOpen && sinceInputMs >= IDLE_MS)

    /** Whether to check again: the periodic check, and opening the app ([OPEN_DEBOUNCE_MS] after the last check). */
    fun due(lastCheckMs: Long, nowMs: Long, intervalMs: Long = INTERVAL_MS) = lastCheckMs <= 0 || nowMs - lastCheckMs >= intervalMs || nowMs < lastCheckMs

    /** A "ready" notification goes out once per build, so cancelling Android's prompt doesn't bring it back every check. */
    fun shouldNotify(available: Long, notified: Long) = available != notified

    /** After a restart: "Updated to X" when the build the updater installed is the one now running (or older than it). */
    fun justUpdated(pending: Long, installed: Long) = pending in 1..installed

    /** The release notes' first line, for a one-line notification. */
    fun notesLine(notes: String, max: Int = 120): String {
        val line = notes.lineSequence().map { it.trim().removePrefix("- ").removePrefix("* ").trim() }.firstOrNull { it.isNotEmpty() }.orEmpty()
        return if (line.length <= max) line else line.take(max - 1).trimEnd() + "…"
    }
}
