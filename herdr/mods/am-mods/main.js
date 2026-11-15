// Herdr app mods from one panel: what is installed, the Community index (GitHub topic herdr-mod),
// install with a review of what each mod does, update, remove. Port of speardragon's
// herdr-plugin-manager (MIT) from herdr plugins to Herdr app mods.

import { View, div } from "gpui-kit";
import { h_flex, v_flex, InputState, Input } from "gpui-base";
import { exec, appHome, readTextFile, writeTextFile, shared, setShared, props, closeOverlay, notify, theme, layout } from "herdr";
import * as core from "./core.js";

const RECORDS = "am.mods.installed";
// The rename shim (D12): the list from before the rename is copied over once on load, and the old
// key stays (am-sidebar/migrate.js SHARED_RENAMES).
const SHARED_OLD = Object.freeze({ "mod-manager.installed": RECORDS });
function carryShared() {
  for (const [old, now] of Object.entries(SHARED_OLD)) if (shared(now) == null && shared(old) != null) setShared(now, shared(old));
}
const PAGE = 10;
const FETCH = 50;
const FOOTER = {
  list: "↑↓ move · u update · U update all · x remove · d compare · o open repo · b built-in · m marketplace · r reload · esc close",
  market: "↑↓ move · ←→ page · enter install · / search · s sort · o open repo · r reload · esc back",
  packages: "↑↓ choose · enter review · esc back",
  review: "y install · o open repo · esc cancel",
};

const io = {
  exec: (cmd, args, opts) => exec(cmd, args, opts),
  readText: (path) => readTextFile(path),
  async writeText(path, text) {
    await writeTextFile(path, text, await readTextFile(path));
  },
};

const anonymous = async (url) => {
  const res = await fetch(url, { headers: { Accept: "application/vnd.github+json" } });
  return { status: res.status, text: await res.text() };
};

const records = () => shared(RECORDS) ?? [];
const saveRecords = (list) => setShared(RECORDS, list);
const cacheDir = () => `${appHome()}/.am-mods-cache`;
const repoPage = (source) => (/^[\w.-]+\/[\w.-]+$/.test(source) ? `https://github.com/${source}` : null);
const short = (sha) => (sha ? sha.slice(0, 7) : "?");
const firstLine = (text) => String(text ?? "").trim().split("\n")[0];

export default class ModManager extends View {
  init(_props, cx) {
    carryShared();
    this.mode = "list";
    this.checks = {};
    this.catalog = null;
    this.catalogAt = 0;
    this.drift = {};
    this.mods = [];
    this.at = 0;
    this.builtInOpen = false;
    this.updates = {};
    this.message = null;
    this.busy = null;
    this.confirm = null;
    this.market = { items: [], total: 0, fetchedPages: 0, page: 0, at: 0, query: "", sort: "stars", error: null, loading: false };
    this.review = null;
    this.searching = false;
    this.handle = cx.focus_handle();
    this.input = InputState.new({ placeholder: "search mods (Enter searches, Esc cancels)" });
    this.input.on("submit", (_e, cx) => {
      this.searching = false;
      this.market.query = this.input.value();
      this.handle.focus();
      cx.spawn(async (cx) => this.loadMarket(cx, true));
      cx.notify();
    });
    this.handle.focus();
    cx.timer.after(100, () => this.handle.focus());
    cx.spawn(async (cx) => this.refresh(cx));
    // A panel closed while cloning can't clean up after itself; its clone goes the next time.
    exec("find", [cacheDir(), "-mindepth", "1", "-maxdepth", "1", "-mmin", "+60", "-exec", "rm", "-rf", "{}", "+"]).catch(() => {});
    if (props()?.start === "market") {
      this.mode = "market";
      cx.spawn(async (cx) => this.loadMarket(cx, true));
    }
    if (props()?.review) cx.spawn(async (cx) => { await this.refresh(cx); await this.startReview(cx, props().review); });
  }

  dismiss() {
    const id = props()?.overlay;
    if (id) closeOverlay(id);
  }

  // Closing the panel mid-review leaves no clone behind.
  async close() {
    if (this.review) await exec("rm", ["-rf", this.review.fetched.dir]);
  }

  async reloadMods() {
    this.mods = await core.listMods(io, { appHome: appHome(), records: records() });
    this.clampAt();
  }

  async refresh(cx) {
    try {
      await this.reloadMods();
      // A linked mods/ (#494): the list cannot see into it, and nothing is moved through it; said
      // under the list, where the person looks.
      const linked = await core.linkedModsRefusal(io, appHome());
      if (linked) this.message = linked;
      // The official index (herdr.dev/mods): which repo each installed mod came from, and its
      // blurb. Ten minutes of cache, so opening the panel is not a fetch every time.
      if (!this.catalog || Date.now() - this.catalogAt > 600000) {
        try {
          this.catalogSource = await core.catalogUrl(io, appHome());
          this.catalog = await core.fetchCatalog(io, anonymous, this.catalogSource);
          this.catalogError = null;
        } catch (e) {
          this.catalogError = `catalog unavailable: ${String(e?.message ?? e)}`;
        }
        this.catalogAt = Date.now();
      }
    } catch (e) {
      this.message = `could not list the mods: ${e?.message ?? e}`;
    }
    cx.notify();
    this.verify(cx);
    for (const r of records()) {
      core.remoteSha(io, r.source)
        .then((sha) => { this.updates[r.source] = sha && sha !== r.sha ? sha : null; cx.notify(); })
        .catch(() => {});
    }
  }

  async loadMarket(cx, reset) {
    const m = this.market;
    if (reset) Object.assign(m, { items: [], total: 0, fetchedPages: 0, page: 0, at: 0 });
    m.loading = true;
    m.error = null;
    cx.notify();
    try {
      const r = await core.searchMarket(io, { query: m.query, sort: m.sort, page: m.fetchedPages + 1, perPage: FETCH }, anonymous);
      m.items.push(...r.items);
      m.total = r.total;
      m.fetchedPages += 1;
    } catch (e) {
      m.error = String(e?.message ?? e);
    }
    m.loading = false;
    cx.notify();
  }

  // Loads the pages the person reaches, FETCH results at a time.
  ensurePage(cx) {
    const m = this.market;
    if (!m.loading && (m.page + 1) * PAGE > m.items.length && m.items.length < m.total) {
      cx.spawn(async (cx) => this.loadMarket(cx, false));
    }
  }

  async work(cx, label, fn) {
    this.busy = label;
    this.message = null;
    cx.notify();
    try {
      await fn();
    } catch (e) {
      this.message = String(e?.message ?? e);
    }
    this.busy = null;
    cx.notify();
  }

  async startReview(cx, source) {
    await this.work(cx, `downloading ${source}…`, async () => {
      // A repo the catalog lists installs at the catalog's headCommit, not whatever HEAD is now.
      const fetched = await core.fetchSource(io, source, cacheDir(), core.catalogCommit(this.catalog, source));
      const packages = core.findPackages(fetched.files);
      if (!packages.length) {
        await exec("rm", ["-rf", fetched.dir]);
        throw new Error(`${source} has no mods/<name>/main.js folder`);
      }
      // Pocket Link belongs to automagik-pocket: refuse it before anything is planned or written.
      if (packages.some((p) => p.mods.some(core.isPocketLink))) throw new Error(core.POCKET_LINK_REFUSAL);
      this.review = { source, fetched, packages, at: 0, plan: null, pkg: null };
      if (packages.length === 1) await this.planFor(packages[0]);
      else this.mode = "packages";
    });
  }

  async planFor(pkg) {
    const r = this.review;
    const record = records().find((x) => x.source === r.source && x.prefix === pkg.prefix) ?? null;
    const layouts = (await exec("ls", [`${appHome()}/layouts`])).stdout.split("\n").filter(Boolean);
    r.pkg = pkg;
    r.record = record;
    // A linked layouts/ (#511): the review says its layouts stay, as the install then does.
    r.linkedLayouts = await core.linkedLayouts(io, appHome());
    // The shown layout as the install will read it (#512), for the review's kept-mod lines.
    r.shown = await this.shownLayout();
    r.plan = await core.planInstall(io, {
      appHome: appHome(), dir: r.fetched.dir, pkg, record, existingMods: this.mods.map((m) => m.name), existingLayouts: layouts,
    });
    this.mode = "review";
  }

  // The layout Herdr shows, its tree read from layouts/ when Herdr names it but gives none (#512).
  shownLayout() {
    return core.shownLayout(io, appHome(), { name: shared("layout"), tree: layout() });
  }

  async finishReview() {
    if (this.review) await exec("rm", ["-rf", this.review.fetched.dir]);
    this.review = null;
  }

  async install(cx) {
    const r = this.review;
    await this.work(cx, `installing ${r.pkg.name}…`, async () => {
      // The shown layout an update stops shipping stays until the person switches (#431), and so
      // does a mod it stops shipping that the shown layout's blocks name (#490).
      // The layout is held on its name, the mod on the shown layout's tree, whatever its name (#512).
      const { name: shown, tree, unread } = await this.shownLayout();
      const dropped = core.droppedLayouts(r.record, r.plan);
      const retired = core.retiredMods(r.record, r.plan);
      // With no tree to read, the retired mods go as before; say which layouts name them.
      const naming = tree ? {} : await core.layoutsNamingMods(io, appHome(), retired);
      // A linked layouts/ is the person's folder (#511): applyInstall moves and writes no layout through it.
      const linkedTo = await core.linkedLayouts(io, appHome());
      const rec = await core.applyInstall(io, {
        appHome: appHome(), plan: r.plan, source: r.source, prefix: r.pkg.prefix, sha: r.fetched.sha, record: r.record, shown, tree,
      });
      saveRecords([...records().filter((x) => !(x.source === rec.source && x.prefix === rec.prefix)), rec]);
      const failures = await core.checkMods(io, appHome(), r.plan.mods);
      const verb = r.record ? "updated" : "installed";
      this.message = failures.length
        ? `${r.pkg.name} ${verb}, but herdr-app check failed for ${failures.map((f) => f.mod).join(", ")}: ${failures[0].error.split("\n")[0]}`
        : `${r.pkg.name} ${verb} (${r.plan.mods.join(", ")})${r.plan.layouts.length && linkedTo == null ? `; layouts: ${r.plan.layouts.join(", ")} (switch with ctrl-shift-l)` : ""}`;
      const said = [
        ...core.linkedLayoutsLines({ appHome: appHome(), target: linkedTo, record: r.record, plan: r.plan }),
        ...core.retiredModLines({ retired, held: rec.mods.filter((m) => !r.plan.mods.includes(m)), shown, tree, unread, naming }),
        ...(linkedTo == null ? core.droppedLayoutLines({ dropped, held: rec.layouts.filter((l) => !r.plan.layouts.includes(l)), shown }) : []),
      ];
      for (const l of said) this.message += ` · ${l}`;
      notify({ title: `mod ${verb}`, body: this.message, level: failures.length || said.length ? "warning" : "success" });
      this.updates[rec.source] = null;
      await this.finishReview();
      this.mode = "list";
      await this.reloadMods();
    });
  }

  // The pack's mods come and go together, through the pack's own updater (checksum-verified
  // release, the replaced folders kept for `automagik-herdr update --rollback`), never a clone here.
  async updatePack(cx) {
    await this.work(cx, `updating ${core.PACK_TITLE}…`, async () => {
      const cli = `${appHome()}/${core.PACK_CLI}`;
      if ((await exec("test", ["-f", cli])).code !== 0) throw new Error(`${core.PACK_CLI} is missing (am-sidebar off or removed): run install.sh again`);
      const r = await exec("sh", ["-c", 'HERDR_APP_HOME=$1 exec sh "$2" update', "sh", appHome(), cli]);
      if (r.code !== 0) throw new Error(firstLine(r.stderr || r.stdout) || "am update failed");
      this.message = firstLine(r.stdout);
      notify({ title: `${core.PACK_TITLE} update`, body: this.message, level: "success" });
      for (const m of this.mods) if (m.kind === "pack") delete this.checks[m.name];
      await this.reloadMods();
      this.verify(cx);
    });
  }

  // What the shown layout says about removing `mod` (every mod of its package that is on, as off
  // asks of one, #305, #414): the first refusal, else the notes. No layout to read: nothing to guard.
  // A package whose own layout is the one shown is refused first: its remove moves that layout aside (#420).
  // The tree decides for the mods, read from layouts/ when Herdr names the layout but gives no
  // tree (#512), so another shown layout naming a package's mod refuses too. `shown`: what was read.
  async removeGuard(mod) {
    const shown = await this.shownLayout();
    const { name, tree } = shown;
    const own = mod.record ? core.packageLayoutGuard({ name, layouts: mod.record.layouts }) : null;
    if (own) return { ...own, shown };
    const guards = (mod.record ? mod.record.mods : [mod.name])
      .filter((m) => this.mods.some((x) => x.name === m && x.enabled))
      .map((m) => ({ m, ...core.layoutGuard({ name, tree, mod: m, then: "remove it" }) }));
    const refused = guards.find((g) => g.refuse);
    if (refused) return { refuse: refused.refuse, shown };
    const notes = guards.filter((g) => g.note).map((g) => `${mod.record ? g.m : "it"} was ${g.note}`);
    return notes.length ? { note: notes.join(" · "), shown } : { shown };
  }

  async remove(cx, mod) {
    const guard = await this.removeGuard(mod);
    if (guard?.refuse) {
      this.message = guard.refuse;
      cx.notify();
      return;
    }
    await this.work(cx, `removing ${mod.name}…`, async () => {
      if (mod.record) {
        // What the guards could not check of the shown layout (#491, #512): the remove says so,
        // with what uninstall() moved and the layouts naming its mods (read before the move).
        const { name: shown, tree, unread } = guard.shown;
        const naming = tree ? {} : await core.layoutsNamingMods(io, appHome(), mod.record.mods);
        const { moved } = await core.uninstall(io, { appHome: appHome(), record: mod.record });
        saveRecords(records().filter((x) => x !== mod.record && !(x.source === mod.record.source && x.prefix === mod.record.prefix)));
        this.message = `removed: ${mod.record.mods.join(", ")}`;
        for (const l of core.packageRemoveLines({ record: mod.record, shown, tree, unread, moved, naming })) this.message += ` · ${l}`;
      } else {
        // No tree of the shown layout to check (#545): a mod that was on goes as before (fail
        // open), and the remove says why, with the layouts naming it. One already off is in no
        // layout's way.
        const { tree, unread } = guard.shown;
        const naming = tree || !mod.enabled ? {} : await core.layoutsNamingMods(io, appHome(), [mod.name]);
        await core.removeLocal(io, { appHome: appHome(), name: mod.name, symlink: mod.symlink, path: mod.path });
        this.message = mod.symlink ? `link ${mod.name} removed (the folder it points to stays)` : `removed: ${mod.name}`;
        if (mod.enabled) for (const l of core.localRemoveLines({ name: mod.name, tree, unread, naming })) this.message += ` · ${l}`;
      }
      if (guard?.note) this.message += ` · ${guard.note}`;
      await this.reloadMods();
    });
  }

  // Bulk update reviews every package, one after another: nothing is applied unseen, because a plan
  // can add a risk, clash with a name, or move a folder aside. The queue lives here.
  async reviewUpdates(cx, pending) {
    this.pendingUpdates = pending.slice(1);
    await this.startReview(cx, pending[0].source);
    if (this.pendingUpdates.length) this.message = `${this.pendingUpdates.length} more queued after this one`;
  }

  // The rows the table draws (core.groupMods): group headings and mods. The cursor (`at`) moves
  // over the selectable ones only: every mod, and the built-in heading that folds them.
  grouped() {
    return core.groupMods(this.mods, { builtInOpen: this.builtInOpen });
  }

  clampAt() {
    const rows = this.grouped().rows;
    if (rows[this.at]?.selectable) return;
    let before = Math.min(this.at, rows.length - 1);
    while (before >= 0 && !rows[before].selectable) before -= 1;
    this.at = before >= 0 ? before : Math.max(0, rows.findIndex((r) => r.selectable));
  }

  step(dir) {
    const rows = this.grouped().rows;
    for (let i = this.at + dir; i >= 0 && i < rows.length; i += dir) if (rows[i].selectable) return void (this.at = i);
  }

  selectedRow() {
    return this.grouped().rows[this.at] ?? null;
  }

  selectedMod() {
    return this.selectedRow()?.mod ?? null;
  }

  toggleBuiltIn() {
    const row = this.selectedRow();
    this.builtInOpen = !this.builtInOpen;
    // Folding while on a built-in mod puts the cursor on the heading that now holds it.
    const rows = this.grouped().rows;
    const at = row?.mod ? rows.findIndex((r) => r.mod === row.mod) : rows.findIndex((r) => r.group?.key === row?.group?.key);
    this.at = at >= 0 ? at : rows.findIndex((r) => r.group?.key === "herdr");
    this.clampAt();
  }

  onKey(e, cx) {
    if (this.searching) {
      if (e.key === "escape") {
        this.searching = false;
        this.handle.focus();
        cx.stop_propagation();
        cx.notify();
      }
      return;
    }
    if (this.busy) return;
    const k = e.key;
    const ch = e.key_char ?? k;
    if (this.confirm) {
      const c = this.confirm;
      if (k === "y") { this.confirm = null; cx.spawn(async (cx) => c.run(cx)); }
      else if (k === "n" || k === "escape") { this.confirm = null; this.message = "cancelled"; }
      else return;
      cx.stop_propagation();
      cx.notify();
      return;
    }
    const handled = this[`${this.mode}Key`](k, ch, cx);
    if (handled === false) return;
    cx.stop_propagation();
    cx.notify();
  }

  listKey(k, ch, cx) {
    const mod = this.selectedMod();
    if (k === "down" || k === "j") this.step(1);
    else if (k === "up" || k === "k") this.step(-1);
    else if (k === "escape" || k === "q") this.dismiss();
    else if (k === "m") { this.mode = "market"; this.message = null; if (!this.market.fetchedPages) cx.spawn(async (cx) => this.loadMarket(cx, true)); }
    else if (ch === "r") cx.spawn(async (cx) => this.refresh(cx));
    else if (ch === "b" || (k === "enter" && this.selectedRow()?.group?.key === "herdr")) this.toggleBuiltIn();
    else if (ch === "U") {
      const pending = records().filter((r) => this.updates[r.source]);
      if (!pending.length) this.message = "everything is up to date (the pack's mods update with u)";
      else this.confirm = { text: `review ${pending.length} update(s), one at a time: ${pending.map((r) => r.mods.join("+")).join(", ")}? (y/n)`, run: (cx) => this.reviewUpdates(cx, pending) };
    } else if (!mod) return false;
    else if (mod.name === core.POCKET_LINK && ch !== "o") {
      // Read-only row: Pocket Link's pairing key lives in its own folder, and only its repo's
      // installer may move or replace it.
      this.message = core.POCKET_LINK_REFUSAL;
    } else if (ch === "u") {
      if (mod.kind === "pack") {
        // The pack's update takes every one of its mods, the switched-off ones too: updated where
        // they are (mods-disabled/), never copied back into mods/. Said before the yes (#219).
        const pack = this.mods.filter((m) => m.kind === "pack");
        const off = pack.filter((m) => !m.enabled).map((m) => m.name);
        const offSaid = !off.length ? "" : `; ${off.join(", ")} ${off.length === 1 ? "is off and stays" : "are off and stay"} off, updated in ${core.OFF_DIR}/`;
        this.confirm = { text: `update ${core.PACK_TITLE} (all ${pack.length} of its mods${offSaid}) with am update? (y/n)`, run: (cx) => this.updatePack(cx) };
      } else if (mod.kind !== "installed") this.message = mod.kind === "herdr" ? "built-in mods update with Herdr" : "only mods installed from the marketplace have a source to update from";
      else if (!mod.enabled) this.message = `${mod.name} is off: switch it on before updating`;
      else cx.spawn(async (cx) => this.startReview(cx, mod.record.source));
    } else if (ch === "d") {
      if (mod.kind === "pack") this.message = `${core.PACK_TITLE} checks its own files: run install.sh again, or u to update`;
      else this.checkDrift(mod, cx);
    } else if (ch === "x") {
      if (mod.kind === "herdr") this.message = "built-in mods are not removed; to change one, use mod.clone";
      else {
        // Refused before the question: a mod the shown layout's blocks name stays (removeGuard).
        const what = mod.record ? `${mod.record.mods.join(", ")} and the keys it added` : mod.symlink ? `the link ${mod.name} (the folder it points to stays)` : `the folder mods/${mod.name}`;
        cx.spawn(async (cx) => {
          const guard = await this.removeGuard(mod);
          if (guard?.refuse) this.message = guard.refuse;
          else this.confirm = { text: `remove ${what}? (y/n)`, run: (cx) => this.remove(cx, mod) };
          cx.notify();
        });
      }
    } else if (ch === "o") {
      const url = mod.name === core.POCKET_LINK
        ? "https://github.com/automagik-dev/automagik-pocket"
        : mod.kind === "pack" ? `https://github.com/${core.PACK_REPO}`
          : (mod.record && repoPage(mod.record.source)) || (this.origin(mod) && repoPage(this.origin(mod).fullName));
      if (url) exec("open", [url]);
      else this.message = "no known repository for this mod";
    } else return false;
  }

  marketKey(k, ch, cx) {
    const m = this.market;
    const pageItems = m.items.slice(m.page * PAGE, (m.page + 1) * PAGE);
    const pages = Math.max(1, Math.ceil(m.total / PAGE));
    const item = pageItems[m.at];
    if (k === "escape" || k === "q") { this.mode = "list"; this.message = null; }
    else if (k === "down" || k === "j") {
      if (m.at < pageItems.length - 1) m.at += 1;
      else if (m.page < pages - 1) { m.page += 1; m.at = 0; this.ensurePage(cx); }
    } else if (k === "up" || k === "k") {
      if (m.at > 0) m.at -= 1;
      else if (m.page > 0) { m.page -= 1; m.at = PAGE - 1; }
    } else if (k === "right" || k === "l") { m.page = (m.page + 1) % pages; m.at = 0; this.ensurePage(cx); }
    else if (k === "left" || k === "h") { m.page = (m.page + pages - 1) % pages; m.at = 0; this.ensurePage(cx); }
    else if (k === "/") { this.searching = true; this.input.set_value(m.query); this.input.focus(); }
    else if (k === "s") { m.sort = m.sort === "stars" ? "updated" : "stars"; cx.spawn(async (cx) => this.loadMarket(cx, true)); }
    else if (k === "r") cx.spawn(async (cx) => this.loadMarket(cx, true));
    else if (!item) return false;
    else if (k === "o") exec("open", [item.url]);
    else if (k === "enter") cx.spawn(async (cx) => this.startReview(cx, item.fullName));
    else return false;
  }

  packagesKey(k, _ch, cx) {
    const r = this.review;
    if (k === "escape" || k === "q") { cx.spawn(async () => this.finishReview()); this.mode = "market"; }
    else if (k === "down" || k === "j") r.at = Math.min(r.packages.length - 1, r.at + 1);
    else if (k === "up" || k === "k") r.at = Math.max(0, r.at - 1);
    else if (k === "enter") cx.spawn(async (cx) => this.work(cx, "checking…", () => this.planFor(r.packages[r.at])));
    else return false;
  }

  reviewKey(k, _ch, cx) {
    const r = this.review;
    if (k === "escape" || k === "n" || k === "q") {
      const back = r.record ? "list" : "market";
      cx.spawn(async () => this.finishReview());
      this.mode = back;
      this.message = "cancelled";
    } else if (k === "o") { const url = repoPage(r.source); if (url) exec("open", [url]); }
    else if (k === "y") {
      if (r.plan.clashes.length) this.message = `not installed: ${r.plan.clashes.join(", ")} already there. Remove or rename yours first.`;
      else cx.spawn(async (cx) => this.install(cx));
    } else return false;
  }

  header(t, title, detail) {
    return h_flex().gap(12).items_center()
      .child(div().text_size(15).font_semibold().text_color(t.foreground).child(title))
      .child(div().text_color(t.dim).child(detail ?? ""))
      .child(div().flex_1())
      .child(div().text_size(11).text_color(t.dim).child("esc"));
  }

  row(id, selected, t, children) {
    return h_flex().id(id).h(28).px(10).gap(10).items_center().rounded(6).flex_none()
      .when(selected, (el) => el.bg(t.selected))
      .children(children);
  }

  // The catalog entry for an installed mod, if herdr.dev/mods lists one that installs it.
  origin(mod) {
    return this.catalog?.byMod.get(mod.name) ?? null;
  }

  // Compares the installed folder with the catalog's head commit: modified, or just older.
  checkDrift(mod, cx) {
    const entry = this.origin(mod);
    if (!entry) {
      this.message = `${mod.name} is not in the catalog`;
      cx.notify();
      return;
    }
    cx.spawn(async (cx) => {
      this.message = `comparing ${mod.name} with ${entry.fullName}…`;
      cx.notify();
      let fetched = null;
      try {
        fetched = await core.fetchSource(io, entry.fullName, cacheDir(), entry.headCommit);
        const result = await core.drift(io, { appHome: appHome(), dir: fetched.dir, entry, name: mod.name, localPath: mod.path });
        this.drift[mod.name] = result;
        this.message = result.clean
          ? `${mod.name} matches ${entry.fullName}@${short(entry.headCommit)}`
          : `${mod.name} differs from ${entry.fullName}@${short(entry.headCommit)}: ${result.changed} changed, ${result.added} new, ${result.removed} removed of ${result.mine} file(s)`;
      } catch (e) {
        this.message = String(e?.message ?? e);
      } finally {
        if (fetched) await exec("rm", ["-rf", fetched.dir]).catch(() => {});
      }
      cx.notify();
    });
  }

  // `herdr-app check` is the only honest answer to "does this load?"; run it one at a time, for
  // the mods the app actually loads, and let the rows fill in as each answer comes back.
  verify(cx) {
    if (this.verifying) return;
    const todo = this.mods.filter((m) => m.enabled && m.kind !== "herdr" && !this.checks[m.name]);
    if (!todo.length) return;
    this.verifying = true;
    cx.spawn(async (cx) => {
      for (const m of todo) {
        try {
          const r = await exec("herdr-app", ["check", `${appHome()}/${m.path}`]);
          this.checks[m.name] = r.code === 0
            ? { ok: true }
            : { ok: false, error: (r.stderr || r.stdout).trim().split("\n")[0] ?? "check failed" };
        } catch (e) {
          this.checks[m.name] = { ok: false, error: String(e?.message ?? e) };
        }
        cx.notify();
      }
      this.verifying = false;
      cx.notify();
    });
  }

  // A table in groups (the pack, yours, Herdr's built-in folded to one row): what a mod is, where
  // it came from, and the switch that moves it out of the app's sight (`mods-disabled/`) without
  // deleting anything. Built-in mods get no switch: they can't be moved, only cloned.
  listView(t) {
    const { rows, counts } = this.grouped();
    const col = (w, el) => div().w(w).flex_none().truncate().child(el);
    const head = (label, w) => div().w(w).flex_none().truncate().text_size(10.5).text_color(t.dim).child(label);
    const items = rows.map((r, i) => {
      if (r.group) {
        const g = r.group;
        const label = g.key === "herdr"
          ? `${g.folded ? "▸" : "▾"} ${g.title} · ${g.mods.length} mods${g.folded ? " (enter or b shows them)" : ""}`
          : `${g.title} · ${g.mods.length}`;
        return h_flex().id(`group-${g.key}`).h(24).px(10).items_end().flex_none().rounded(6)
          .when(i === this.at, (el) => el.bg(t.selected))
          .when(r.selectable, (el) => el.cursor_pointer().on_click((_e, cx) => { this.at = i; this.toggleBuiltIn(); cx.notify(); }))
          .child(div().text_size(11.5).font_semibold().text_color(t.muted).child(label));
      }
      const m = r.mod;
      const d = core.describeMod(m, this.origin(m));
      const update = m.record && this.updates[m.record.source];
      return this.row(`mod-${m.name}`, i === this.at, t, [
        // Only a mod that may move gets a switch: Herdr's own come with the app, and Pocket Link's
        // folder holds a pairing key another repo installs and repairs.
        m.kind === "herdr" || m.name === core.POCKET_LINK
          ? div().w(30).flex_none().text_size(11).text_color(t.dim).child("–")
          : h_flex().id(`sw-${m.name}`).w(30).h(17).flex_none().rounded(9).p(2).cursor_pointer()
            .bg(m.enabled ? t.accent : t.input).when(m.enabled, (el) => el.justify_end())
            .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
            .on_click((_e, cx) => this.toggle(m, cx))
            .child(div().size(13).rounded(7).bg(t.background)),
        col(150, div().truncate().when(!m.enabled || this.checks[m.name]?.ok === false, (el) => el.text_color(this.checks[m.name]?.ok === false ? t.blocked : t.muted)).child(m.name)),
        col(110, div().text_color(m.error ? t.blocked : !m.enabled ? t.dim : m.kind === "herdr" ? t.dim : t.accent).child(d.label)),
        col(56, div().text_color(this.checks[m.name]?.ok === false ? t.blocked : this.checks[m.name]?.ok ? t.done : t.dim)
          .child(m.kind === "herdr" || !m.enabled ? "—" : this.checks[m.name] ? (this.checks[m.name].ok ? "ok" : "error") : "…")),
        col(120, div().text_color(t.muted).child(d.version)),
        div().flex_1().min_w(0).truncate().text_color(update ? t.blocked : t.dim).child(`${d.source}${update ? ` · ↑ ${short(update)}` : ""}`),
        col(80, div().text_color(t.dim).child(d.installed)),
        col(80, div().text_color(t.dim).child(core.day(m.changed))),
      ]).on_click((_e, cx) => { this.at = i; cx.notify(); });
    });
    const sel = this.selectedMod();
    const d = sel ? core.describeMod(sel, this.origin(sel)) : null;
    const entry = d?.origin;
    const detail = sel?.name === core.POCKET_LINK
      ? [`path: ${sel.path}`, "read-only: the mod, its LaunchAgent and the pairing key belong to automagik-dev/automagik-pocket",
        "install, update or remove it with that installer (o opens it in the browser)"]
      : !sel ? (this.selectedRow()?.group?.key === "herdr" ? ["mods that come with Herdr: read-only (mod.clone to change one); enter or b shows or hides them"] : [])
      : this.checks[sel.name]?.ok === false ? [`path: ${sel.path}`, `herdr-app check failed: ${this.checks[sel.name].error}`,
        "the app keeps the last good version; the error also shows in herdr-app status"]
        : sel.kind === "pack" ? [`path: ${sel.path}`, `${core.PACK_TITLE} ${d.version} · installed ${d.installed} · u updates the pack`,
          ...(sel.enabled ? [] : [`switched off: the folder is in ${core.OFF_DIR}/`])]
        : sel.record ? [`path: ${sel.path}`, `source: ${d.source}`, `commit: ${sel.record.sha?.slice(0, 7) ?? "?"}`,
          `mods: ${sel.record.mods.join(", ")}`,
          sel.record.layouts?.length ? `layouts: ${sel.record.layouts.join(", ")}` : null,
          sel.record.keys?.length ? `keys: ${sel.record.keys.map((k) => `${k.key} → ${k.action}`).join(", ")}` : null,
          `installed ${d.installed}`].filter(Boolean)
          : sel.kind === "herdr" ? [`path: ${sel.path}`, "comes with Herdr: read-only (mod.clone to change it)"]
            : [`path: ${sel.path}`,
              entry ? `${entry.name} · ${entry.fullName}${entry.path ? `/${entry.path}` : ""} ★${entry.stars} · updated ${entry.pushedAt?.slice(0, 10) ?? "?"} (o opens it in the browser)` : null,
              entry?.blurb ?? null,
              this.drift[sel.name] ? (this.drift[sel.name].clean ? "matches upstream" : `differs from upstream: ${this.drift[sel.name].changed} changed, ${this.drift[sel.name].added} new, ${this.drift[sel.name].removed} removed`) : (entry ? "d compares it with upstream" : null),
              sel.clone ? `clone of ${sel.clone.name}${sel.clone.version ? ` v${sel.clone.version}` : ""}` : entry ? null : "no recorded source",
              sel.manifest?.owner ? `installed by ${sel.manifest.owner} on ${d.installed}` : null,
              `changed ${core.day(sel.changed)}`,
              sel.symlink ? "a link to a folder of yours: x removes only the link" : null].filter(Boolean);
    const errors = this.mods.filter((m) => this.checks[m.name]?.ok === false).length;
    const pending = this.mods.filter((m) => m.enabled && m.kind !== "herdr" && !this.checks[m.name]).length;
    const title = [
      ...counts,
      this.catalogError ?? null,
      errors ? `${errors} with errors` : null,
      pending ? `checking ${pending}` : null,
    ].filter(Boolean).join(" · ");
    return [
      this.header(t, "Mods", title),
      h_flex().h(22).px(10).gap(10).flex_none().items_center().border_b(1).border_color(t.border)
        .child(head("ON", 30)).child(head("NAME", 150)).child(head("KIND", 110)).child(head("CHECK", 56))
        .child(head("VERSION", 120)).child(div().flex_1().min_w(0).truncate().text_size(10.5).text_color(t.dim).child("SOURCE"))
        .child(head("INSTALLED", 80)).child(head("CHANGED", 80)),
      v_flex().flex_1().min_h(0).overflow_y_scrollbar().children(items),
      v_flex().gap(2).text_size(12).text_color(t.muted).children(detail.map((line) => div().child(line))),
    ];
  }

  // Off is a move: the folder leaves `mods/` for `mods-disabled/`, so the app stops loading it.
  toggle(mod, cx) {
    if (mod.name === core.POCKET_LINK) {
      // Read-only: off is a folder move, and its pairing key lives in that folder.
      this.message = core.POCKET_LINK_REFUSAL;
      cx.notify();
      return;
    }
    if (mod.kind === "herdr") {
      this.message = "built-in mods come with Herdr and can't be switched off (mod.clone to change one)";
      cx.notify();
      return;
    }
    // Off only: a mod the shown layout's blocks name stays on, or Herdr drops the layout (#305).
    // Turning one on is never blocked.
    const guard = mod.enabled ? core.layoutGuard({ name: shared("layout"), tree: layout(), mod: mod.name }) : null;
    if (guard?.refuse) {
      this.message = guard.refuse;
      cx.notify();
      return;
    }
    cx.spawn(async (cx) => {
      try {
        await core.setEnabled(io, { appHome: appHome(), name: mod.name, enabled: !mod.enabled });
        this.message = mod.enabled
          ? `${mod.name} off · its folder moved to ${core.OFF_DIR}/${guard?.note ? ` · it was ${guard.note}` : ""}`
          : `${mod.name} on`;
        await this.reloadMods();
      } catch (e) {
        this.message = String(e?.message ?? e);
      }
      cx.notify();
    });
  }


  marketView(t) {
    const m = this.market;
    const installed = new Set(records().map((r) => r.source));
    const pageItems = m.items.slice(m.page * PAGE, (m.page + 1) * PAGE);
    const pages = Math.max(1, Math.ceil(m.total / PAGE));
    const items = pageItems.map((it, i) => this.row(`market-${it.fullName}`, i === m.at, t, [
      div().w(28).flex_none().text_color(t.dim).child(String(m.page * PAGE + i + 1)),
      div().w(14).flex_none().text_color(t.done).child(installed.has(it.fullName) ? "✓" : ""),
      div().w(260).flex_none().truncate().text_color(t.foreground).child(it.fullName),
      div().w(56).flex_none().text_color(t.muted).child(`★ ${it.stars}`),
      div().flex_1().min_w(0).truncate().text_color(t.dim).child(it.description),
    ]).on_click((_e, cx) => { m.at = i; cx.notify(); }));
    const status = m.loading && !pageItems.length ? "loading…" : m.error ? m.error : !m.total ? "no mods found" : null;
    return [
      this.header(t, "Marketplace", `topic:herdr-mod${m.query ? ` ${m.query}` : ""} · ${m.sort === "stars" ? "most stars" : "recently updated"} · ${m.total} repos`),
      this.searching
        ? h_flex().h(34).px(10).items_center().rounded(8).border_1().border_color(t.accent).bg(t.background)
          .child(Input.new(this.input).flex_1().h_full().text_size(12.8).text_color(t.foreground))
        : div(),
      v_flex().flex_1().min_h(0).children(status ? [div().px(10).text_color(m.error ? t.blocked : t.dim).child(status)] : items),
      div().text_size(12).text_color(t.dim).child(`page ${m.page + 1} of ${pages}${m.loading ? " · loading…" : ""}`),
    ];
  }

  packagesView(t) {
    const r = this.review;
    return [
      this.header(t, r.source, `${r.packages.length} packages in this repo · commit ${short(r.fetched.sha)}`),
      v_flex().flex_1().min_h(0).overflow_y_scrollbar().children(r.packages.map((p, i) => this.row(`pkg-${p.prefix}`, i === r.at, t, [
        div().w(200).flex_none().truncate().text_color(t.foreground).child(p.prefix || "(root)"),
        div().flex_1().min_w(0).truncate().text_color(t.dim).child(`mods: ${p.mods.join(", ")}${p.layouts.length ? ` · layouts: ${p.layouts.length}` : ""}${p.recipe ? "" : " · no RECIPE.md"}`),
      ]))),
    ];
  }

  reviewView(t) {
    const { plan, pkg, source, fetched, record, linkedLayouts: linked = null } = this.review;
    const line = (text, color) => div().text_color(color ?? t.muted).child(text);
    const section = (title, lines) => v_flex().gap(2).child(div().font_semibold().text_color(t.foreground).child(title)).children(lines);
    const heldMods = core.heldRetiredMods({ record, plan, tree: this.review.shown?.tree ?? layout() });
    const blocks = [
      section("What comes in", [
        line(`mods: ${plan.mods.map((m) => `mods/${m}`).join(", ")}`),
        plan.layouts.length && linked == null ? line(`layouts: ${plan.layouts.join(", ")} (your layout stays)`) : null,
        // A linked layouts/ (#511): no layout is moved out of it or written into it.
        ...core.linkedLayoutsLines({ appHome: appHome(), target: linked, record, plan }).map((l) => line(l, t.blocked)),
        // The record's mods this commit drops (#490): kept while the shown layout names it, else moved aside.
        ...core.retiredMods(record, plan).map((m) => (heldMods.includes(m)
          ? line(`mods/${m}: no longer shipped; kept while the shown layout names it (switch layouts, then update again)`, t.blocked)
          : line(`mods/${m}: no longer shipped; moved to the backup folder`))),
        // The record's layouts this commit drops (#431): kept while Herdr shows it, else moved aside.
        ...(linked == null ? core.droppedLayouts(record, plan) : []).map((l) => (core.isShownLayout(shared("layout"), l)
          ? line(`layouts/${l}: no longer shipped; kept while Herdr shows it (switch layouts, then update again)`, t.blocked)
          : line(`layouts/${l}: no longer shipped; moved to the backup folder`))),
        line(`${pkg.files.length} file(s) · commit ${short(fetched.sha)}${record ? ` (installed: ${short(record.sha)})` : ""}${pkg.recipe ? "" : " · no RECIPE.md"}`),
      ].filter(Boolean)),
      section("What the code does", plan.risks.length
        ? plan.risks.map((r) => line(`• ${r.label}: ${r.paths.map((p) => p.split("/").slice(-2).join("/")).join(", ")}`, t.blocked))
        : [line("runs no programs, reaches no network, reads and writes no files", t.done)]),
      section("Keys", [
        ...plan.keyAdds.map((k) => line(`+ ${k.key} → ${k.action} (${k.section})`)),
        ...plan.keyConflicts.map((k) => line(`= ${k.key} stays ${k.current}; the mod wanted ${k.action}`, t.blocked)),
        ...(plan.keyAdds.length || plan.keyConflicts.length ? [] : [line("none")]),
      ]),
    ];
    if (plan.clashes.length) blocks.push(section("Blocked", [line(`${plan.clashes.join(", ")} already there and not installed from here; nothing is overwritten`, t.blocked)]));
    return [
      this.header(t, `${record ? "Update" : "Install"} ${pkg.name}`, source),
      div().text_size(12).text_color(t.dim).child("Herdr does not review mods. Look at the repository (o) before installing a mod that runs programs or reaches the network."),
      v_flex().flex_1().min_h(0).gap(12).overflow_y_scrollbar().children(blocks),
    ];
  }

  render(_cx) {
    const t = theme();
    const body = this[`${this.mode}View`](t);
    const footer = this.busy
      ? div().text_color(t.working).child(this.busy)
      : this.confirm
        ? div().font_semibold().text_color(t.blocked).child(this.confirm.text)
        : div().text_color(t.dim).child(FOOTER[this.mode]);
    return v_flex().id("root").track_focus(this.handle).size_full().p(16).gap(12).bg(t.popover).text_size(13)
      .on_key_down((e, cx) => this.onKey(e, cx))
      .children(body)
      .when(Boolean(this.message), (el) => el.child(div().text_size(12).text_color(t.foreground).child(this.message)))
      .child(div().text_size(12).child(footer));
  }
}
