package ai.namastex.automagik

/**
 * Projects and tasks, read off what the phone already knows. A project is a git repository: spaces whose folder is in
 * the same repository (by origin remote, else by shared git dir) roll up into one, like a squad's several spaces. A task
 * is a branch; work on a trunk (main, master, dev, develop, trunk, HEAD) or with no branch is the project's untasked bucket. Agents and their
 * status come from [Cockpit], so the counts here match the Today tab.
 */
object Projects {
    private val TRUNKS = setOf("main", "master", "dev", "develop", "trunk", "HEAD")
    /** The task board's order, most urgent first. */
    val BOARD = listOf(Cockpit.BLOCKED, Cockpit.WORKING, Cockpit.DONE, Cockpit.IDLE)
    fun urgency(rank: Int) = BOARD.indexOf(rank).let { if (it < 0) BOARD.size else it }

    /** An agent with where it belongs: its project's key, its space, the machine it runs on and its task's branch. */
    data class Agent(val entry: Cockpit.Entry, val project: String, val space: PocketSpace?, val machine: String, val branch: String?) {
        val ref get() = entry.ref
        val terminal get() = entry.terminal
        val rank get() = entry.rank
    }

    /** [remote] is "owner/repo", blank for a repository without one or a project that is a space with no repository. */
    data class Project(val key: String, val name: String, val remote: String, val spaces: List<Pair<String, PocketSpace>>,
                       val agents: List<Agent>) {
        fun count(rank: Int) = agents.count { it.rank == rank }
        val needsYou get() = count(Cockpit.BLOCKED)
        val working get() = count(Cockpit.WORKING)
        val done get() = count(Cockpit.DONE)
    }

    /** One branch of one project ([branch] null: the project's untasked work), its agents most urgent first. */
    data class Task(val project: String, val projectName: String, val branch: String?, val agents: List<Agent>) {
        val untasked get() = branch == null
        /** A task still has work going while any agent on it works, so working outranks done here (not on Today). */
        val rank get() = agents.minOf { urgency(it.rank) }.let { BOARD.getOrElse(it) { Cockpit.IDLE } }
        val latest get() = agents.maxOf { it.terminal.statusMs }
        val title get() = branch ?: "Untasked"
    }

    /**
     * A remote URL as "owner/repo" (the whole path after the host, so GitLab subgroups keep theirs), without scheme,
     * credentials, host, port or ".git". Null for no URL or a local path, which names nothing another machine shares.
     */
    fun remoteKey(url: String): String? {
        val u = url.trim().ifEmpty { return null }
        val scheme = Regex("^[A-Za-z][A-Za-z0-9+.-]*://").find(u)
        val path = when {
            scheme != null && u.startsWith("file:", ignoreCase = true) -> return null
            scheme != null -> u.substring(scheme.range.last + 1).replaceFirst(Regex("^[^/]*@"), "").substringAfter('/', "")
            // scp-like: [user@]host:path
            Regex("^([^/@]+@)?[^/:]+:").containsMatchIn(u) -> u.substringAfter(':')
            else -> return null
        }
        return path.trim('/').removeSuffix(".git").trim('/').ifEmpty { null }
    }

    /** The branch a task is named after, or null when the work is untasked: no branch, detached, or a trunk. */
    fun task(branch: String?): String? = branch?.trim()?.takeIf { it.isNotEmpty() && it !in TRUNKS && !it.startsWith("(") }

    private data class Identity(val key: String, val name: String, val remote: String)
    private fun identity(hostId: String, machine: String, git: GitInfo) =
        if (git.remote.isNotBlank()) Identity("repo:${git.remote.lowercase()}", git.remote.substringAfterLast('/'), git.remote)
        else Identity("git:$hostId|$machine|${git.common}", git.repo, "")
    private fun spaceIdentity(hostId: String, space: PocketSpace) = Identity("space:$hostId:${space.id}", space.name, "")

    /**
     * Every space lands in exactly one project: its repository's, or a project of its own when its folder is not one
     * (or git has not answered yet). An agent goes by the repository its own working directory is in, else its space's.
     * Sorted: most needing the person first, then most working, then by name.
     */
    fun build(hosts: List<SidebarHost>, entries: List<Cockpit.Entry>): List<Project> {
        val ids = LinkedHashMap<String, Identity>()
        val spaces = HashMap<String, MutableList<Pair<String, PocketSpace>>>()
        val agents = HashMap<String, MutableList<Agent>>()
        val byHost = hosts.associateBy { it.hostId }
        val byAddress = hosts.associate { h -> h.hostId to h.terminals.associateBy { it.address } }
        fun spaceGit(h: SidebarHost, s: PocketSpace) = h.git[Sidebar.gitKey(s.machine, Sidebar.place(s, byAddress.getValue(h.hostId)))]
        for (h in hosts) for (s in h.spaces) {
            val id = spaceGit(h, s)?.let { identity(h.hostId, s.machine, it) } ?: spaceIdentity(h.hostId, s)
            ids.putIfAbsent(id.key, id)
            spaces.getOrPut(id.key) { mutableListOf() } += h.hostId to s
        }
        for (e in entries) {
            val h = byHost[e.ref.hostId]
            val machine = e.ref.address.substringBefore('/', "")
            val space = h?.spaces?.find { e.ref.address in it.addresses }
            val git = e.terminal.cwd.takeIf { it.isNotBlank() }?.let { h?.git?.get(Sidebar.gitKey(machine, it)) }
                ?: if (h != null && space != null) spaceGit(h, space) else null
            val id = git?.let { identity(e.ref.hostId, machine, it) } ?: space?.let { spaceIdentity(e.ref.hostId, it) }
                ?: Identity("host:${e.ref.hostId}|$machine", machine.ifBlank { h?.name ?: "Machine" }, "")
            ids.putIfAbsent(id.key, id)
            agents.getOrPut(id.key) { mutableListOf() } += Agent(e, id.key, space, machine.ifBlank { h?.name.orEmpty() }, task(git?.branch))
        }
        return ids.values.map { Project(it.key, it.name, it.remote, spaces[it.key].orEmpty(), agents[it.key].orEmpty()) }
            .sortedWith(compareByDescending<Project> { it.needsYou }.thenByDescending { it.working }
                .thenBy(String.CASE_INSENSITIVE_ORDER) { it.name }.thenBy { it.key })
    }

    /** Each project's agents by branch, most urgent first; within a rank, named tasks before untasked, newest first. */
    fun tasks(projects: List<Project>): List<Task> = projects.flatMap { p ->
        p.agents.groupBy { it.branch }.map { (branch, agents) ->
            Task(p.key, p.name, branch, agents.sortedWith(compareBy<Agent> { urgency(it.rank) }.thenByDescending { it.terminal.statusMs }))
        }
    }.sortedWith(compareBy<Task> { urgency(it.rank) }.thenBy { it.untasked }.thenByDescending { it.latest }
        .thenBy(String.CASE_INSENSITIVE_ORDER) { it.projectName }.thenBy { it.branch.orEmpty() })

    /** The task board: Needs you, Working, Done, then Idle, each only when it has a task. */
    fun board(tasks: List<Task>): List<Pair<Int, List<Task>>> =
        BOARD.mapNotNull { rank ->
            tasks.filter { it.rank == rank }.takeIf { it.isNotEmpty() }?.let { rank to it }
        }

    /** The desktop sidebar's rows for one project's spaces, with the machine headers above them. */
    fun tree(rows: List<SidebarRow>, project: Project): List<SidebarRow> {
        val wanted = project.spaces.map { (h, s) -> h to s.id }.toSet()
        val out = mutableListOf<SidebarRow>()
        var header: SidebarRow? = null
        var keep = false
        for (row in rows) when (row) {
            is MachineHeaderRow -> { header = row; keep = false }
            is SpaceRow -> {
                keep = (row.hostId to row.space.id) in wanted
                if (keep) header?.let { out += it; header = null }
                if (keep) out += row
            }
            else -> if (keep) out += row
        }
        return out
    }

    /** Everything the tabs count, from one reading of every machine: Today's sections, projects and tasks. */
    data class Pulse(val sections: List<Cockpit.Section>, val projects: List<Project>, val tasks: List<Task>,
                     val machines: Int, val spaces: Int,
                     /** A pane row that is its chat's ([Cockpit.raised]), by pane ref: the chat ref its Done is looked at as. */
                     val fromChat: Map<TerminalRef, TerminalRef> = emptyMap()) {
        private fun count(rank: Int) = sections.find { it.rank == rank }?.entries?.size ?: 0
        val needsYou get() = count(Cockpit.BLOCKED)
        /** The needs-you rows the deck can answer in place: terminals, not chats raised above them. */
        val answerableNeedsYou get() = sections.find { it.rank == Cockpit.BLOCKED }?.entries
            ?.count { !Chat.isDsh(it.ref.address) && it.ref !in fromChat } ?: 0
        /** Home's badge and tile count every blocked row, including a request waiting in a Bot chat. */
        val homeNeedsYou get() = needsYou
        val working get() = count(Cockpit.WORKING)
        /** The key a row's finished turn is looked at by: its chat's for a pane row raised to its chat, else its own. */
        fun seenKey(ref: TerminalRef, t: CoreTerminal) = Cockpit.seenKey(fromChat[ref] ?: ref, t.turn)
    }

    /**
     * [seen]: the [Cockpit.seenKey]s of finished turns the person looked at. [chats]: the Automagik Bots' chats
     * ([Cockpit.chats]), rows of Home beside the terminals (one per Bot, with its pane); projects and tasks stay the
     * terminals', since a chat has no folder.
     */
    fun pulse(hosts: List<SidebarHost>, seen: Set<String>, chats: Cockpit.Chats = Cockpit.Chats()): Pulse {
        val all = hosts.flatMap { h -> h.terminals.filter { it.live }.map { TerminalRef(h.hostId, it.address) to it } }
        val paned = hosts.flatMap { h -> h.spaces.flatMap { s -> s.addresses.map { TerminalRef(h.hostId, it) } } }.toSet()
        val raised = Cockpit.raised(all, chats)
        fun key(r: TerminalRef, t: CoreTerminal) = Cockpit.seenKey(raised.fromChat[r] ?: r, t.turn)
        val sections = Cockpit.sections(raised.terminals + chats.agents, { it in paned || Chat.isDsh(it.address) }) { r, t -> key(r, t) in seen }
        val projects = build(hosts, sections.flatMap { s -> s.entries.filter { !Chat.isDsh(it.ref.address) } })
        return Pulse(sections, projects, tasks(projects), machinesConnected(hosts), hosts.sumOf { it.spaces.size }, raised.fromChat)
    }

    /** Machines up right now: each connected core, and the machines it reaches that are connected too. */
    fun machinesConnected(hosts: List<SidebarHost>) = hosts.filter { it.connected }.sumOf { 1 + it.machines.count { m -> m.connected } }
}
