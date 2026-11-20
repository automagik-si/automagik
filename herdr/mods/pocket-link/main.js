// Pocket Link: pair a phone with this computer like a TV pairs with a streaming
// account. Turn it on, press Pair a phone, scan the code with Herdr Pocket, and
// the phone reaches this machine's agents from anywhere: no SSH, no password,
// no port to open. A small bridge (bridge/bridge.mjs, Node) answers phones over
// iroh, end to end encrypted, and hands each paired phone a herdr-core session.
// Opened as a dialog (`mod.open pocket-link`).

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { platform } from "os";
import { exec, appHome, home, readTextFile, theme, props, closeOverlay, notify, watchFolder } from "herdr";
import { findNode, noNodeMessage, version, newEnough } from "./find-node.js";

const DIR = "mods/pocket-link";
const I = (name) => `${DIR}/icons/${name}.svg`;
const ROOT = () => `${appHome()}/${DIR}`;
const BRIDGE = () => `${ROOT()}/bridge/bridge.mjs`;

// Answers --version with 20.3 or newer.
const runs = (path) => exec(path, ["--version"]).then((r) => r.code === 0 && newEnough(version(r.stdout)), () => false);

// The Node every bridge command runs with (find-node.js), once found. A failed search is kept by
// the dialog that made it, so opening Pocket Link again looks again.
let found = null;
const io = () => ({
  home: home(),
  platform: platform(),
  mod: ROOT(),
  exec: (cmd, args) => exec(cmd, args),
  read: (path) => readTextFile(path),
  list: (dir) => exec("ls", ["-1", dir]).then((r) => (r.code === 0 ? r.stdout.split("\n").filter(Boolean) : [])),
});

// "3 min ago", "Oct 31": when a phone was last seen.
function ago(ms) {
  if (!ms) return "never";
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

// When the newest phone in a status paired.
const newest = (devices) => Math.max(0, ...(devices ?? []).map((d) => d.paired ?? 0));

// Next to Copy link: the clipboard may sync to other devices, so copying shortens the code.
const COPY = "Can't scan? Copy the link and paste it in Pocket. Your clipboard may sync to your other devices, so a copied code ends 2 minutes later.";
const COPIED = "Copied. Your clipboard may sync to your other devices, so this code ends 2 minutes after the copy; then a new one appears here.";

const left = (ms) => {
  const s = Math.max(0, Math.round((ms - Date.now()) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

export default class PocketLink extends View {
  init(_props, cx) {
    this.status = null; // bridge.mjs status
    this.problem = null; // why it can't run here: "node" | "setup" | null
    this.looking = null; // the search for Node (find-node.js)
    this.checked = null; // where it looked, when it found none
    this.busy = null; // what a button is doing
    this.error = null;
    this.pairing = null; // { link, rows, expires, copied }
    this.confirmReset = false;
    this.closed = false;
    this.cancelling = null;
    this.handle = cx.focus_handle();
    cx.spawn(async (cx) => {
      await this.reload();
      cx.notify();
      // The bridge writes its state (pairing, phones, its address) in a folder outside the
      // mod, and `status` says which.
      // public-status.json changes every 20 s for other mods (bridge/presence.mjs); it says nothing this dialog shows.
      const own = (path) => /(^|\/)public-status\.json(\.\d+\.tmp)?$/.test(path);
      for (;;) {
        const dir = this.status?.state;
        const changed = await (dir ? watchFolder(dir) : Promise.reject()).catch(() => cx.sleep(3000));
        if (Array.isArray(changed) && changed.length && changed.every(own)) continue;
        await this.reload();
        cx.notify();
      }
    });
    cx.timer.every(1000, (cx) => {
      if (!this.pairing) return;
      if (Date.now() > this.pairing.expires) {
        const copied = this.pairing.copied;
        this.pairing = null;
        // A copied code ends 2 minutes after the copy; whoever is still pairing gets a new one,
        // once (the new code isn't copied, so at its own end the card goes back to the button).
        if (copied && !this.closed && this.status?.running) this.act("pair", ["pair"], cx, (r) => this.showCode(r));
      }
      cx.notify();
    });
  }

  // When the bridge gives no answer and the kept Node no longer runs (gone, or broken by an
  // upgrade), forget it, find another and try once more.
  async bridge(args, again = true) {
    const node = found ?? (await (this.looking ??= findNode(io())));
    if (!node.path) {
      this.checked = node.checked;
      return { ok: false, error: "node" };
    }
    found = node;
    const r = await exec(node.path, [BRIDGE(), ...args]).catch((e) => ({ code: 127, stdout: "", stderr: String(e) }));
    try {
      return JSON.parse(r.stdout.trim().split("\n").pop());
    } catch {}
    if (!(await runs(node.path))) {
      found = null;
      this.looking = null;
      this.checked = null;
      return again ? this.bridge(args, false) : { ok: false, error: "node" };
    }
    return { ok: false, error: /Cannot find (package|module)/.test(r.stderr) ? "setup" : (r.stderr || "The bridge didn't answer.").trim().slice(0, 300) };
  }


  async reload() {
    const before = this.status ? newest(this.status.devices) : null;
    const s = await this.bridge(["status"]);
    if (s.error === "node" || s.error === "setup") {
      this.problem = s.error;
      this.status = null;
      return;
    }
    this.problem = null;
    if (s.ok === false) {
      this.error = s.error;
      return;
    }
    this.status = s;
    if (!s.pairing) this.pairing = null;
    // A phone just paired (or paired again): say so, and put the code away.
    if (before !== null && this.announce(before, s.devices)) this.pairing = null;
  }

  // "Phone paired", for a phone that paired after `before`, with its key's fingerprint.
  announce(before, devices) {
    const at = newest(devices);
    if (at <= before) return false;
    const phone = devices.find((d) => d.paired === at);
    notify({ title: "Phone paired", body: `${phone.name} (key ${phone.fingerprint ?? phone.id.slice(0, 12)}) can reach this computer now.`, level: "success", timeout: 8000 });
    return true;
  }

  // Closing the dialog ends the code it shows (bridge `cancel`), once. A phone that paired just
  // before still gets its notice, from what `cancel` says.
  cancelCode() {
    if (!this.cancelling && (this.pairing || this.status?.pairing || this.busy === "pair")) {
      const before = newest(this.status?.devices);
      this.pairing = null;
      this.cancelling = this.bridge(["cancel"]).then((r) => { if (r.ok !== false) this.announce(before, r.devices); });
    }
    return this.cancelling ?? Promise.resolve();
  }

  // Escape (or anything here that closes the dialog).
  dismiss() {
    this.closed = true;
    this.cancelCode();
    closeOverlay(props().overlay);
  }

  // The host calls this when it closes the dialog by any means: Esc, a click outside, ⌘⌥P again.
  async close(_cx) {
    this.closed = true;
    await this.cancelCode();
  }

  act(what, args, cx, then) {
    if (this.busy) return;
    this.busy = what;
    this.error = null;
    cx.notify();
    cx.spawn(async (cx) => {
      const r = await this.bridge(args);
      if (r.ok === false) this.error = r.error === "node" ? "Pocket Link needs Node.js 20.3 or newer." : r.error;
      else if (then) await then(r);
      await this.reload();
      this.busy = null;
      cx.notify();
    });
  }

  // On: the login service starts the bridge now and at every login. If the
  // system won't take one, a bridge that lives until logout.
  turnOn(cx) {
    this.act("on", ["install"], cx);
    cx.spawn(async (cx) => {
      // launchd/systemd start it a moment later; the watcher sees it arrive.
      await cx.sleep(4000);
      if (this.status && !this.status.running) {
        await this.bridge(["start"]);
        await this.reload();
        cx.notify();
      }
    });
  }

  setup(cx) {
    if (this.busy) return;
    this.busy = "setup";
    cx.notify();
    // npm may take longer than one exec allows: run it detached, watch for the end. npm sits next
    // to the Node found for the bridge (nvm, volta, Homebrew), which Herdr's PATH may not have.
    const bin = found?.path.replace(/\/[^/]*$/, "") ?? "";
    exec("sh", ["-c", 'cd "$1/bridge" && (PATH="${2:+$2:}$PATH" npm ci --omit=dev --no-audit --no-fund > "$1/.setup.log" 2>&1; echo $? > "$1/.setup.done") &', "sh", ROOT(), bin]).catch(() => null);
    cx.spawn(async (cx) => {
      for (let i = 0; i < 120; i++) {
        await cx.sleep(2000);
        const done = await exec("cat", [`${ROOT()}/.setup.done`]).catch(() => null);
        if (done?.code !== 0) continue;
        exec("rm", ["-f", `${ROOT()}/.setup.done`]).catch(() => null);
        if (done.stdout.trim() !== "0") this.error = `npm couldn't install the bridge. See ${ROOT()}/.setup.log`;
        break;
      }
      this.busy = null;
      await this.reload();
      cx.notify();
    });
  }

  button(t, id, label, onClick, { primary = false, disabled = false, spinning = false } = {}) {
    return h_flex()
      .id(id)
      .h(30)
      .px(12)
      .gap(6)
      .items_center()
      .justify_center()
      .flex_none()
      .rounded(7)
      .text_size(12.5)
      .font_medium()
      .when(primary, (el) => el.bg(t.solid).text_color(t.solid_foreground))
      .when(!primary, (el) => el.border_1().border_color(t.input).bg(t.raised).text_color(t.foreground))
      .when(disabled, (el) => el.opacity(0.45))
      .when(!disabled, (el) => el.cursor_pointer().hover((s) => (primary ? s.opacity(0.88) : s.bg(t.hover))).on_click((_e, cx) => onClick(cx)))
      .when(spinning, (el) => el.child(svg(I("spinner")).size(12).spin(900)))
      .child(label);
  }

  note(t, text) {
    return div().text_size(12.3).line_height("18px").text_color(t.muted).child(text);
  }

  section(t, title) {
    return div().pt(16).pb(6).text_size(11.5).font_medium().text_color(t.dim).child(title);
  }

  // Before it can run: Node, then the bridge's packages.
  blocked(t) {
    if (this.problem === "node")
      return v_flex()
        .gap(8)
        .pt(14)
        .child(this.note(t, noNodeMessage(this.checked, home())));
    return v_flex()
      .gap(10)
      .pt(14)
      .child(this.note(t, "First, the bridge's two packages: iroh (the encrypted connection) and qrcode. npm downloads them once, about 25 MB."))
      .child(h_flex().child(this.button(t, "pl-setup", this.busy === "setup" ? "Installing…" : "Install the bridge", (cx) => this.setup(cx), { primary: true, disabled: Boolean(this.busy), spinning: this.busy === "setup" })));
  }

  power(t, s) {
    const on = s.running;
    return h_flex()
      .mt(14)
      .p(12)
      .gap(10)
      .items_center()
      .rounded(10)
      .border_1()
      .border_color(t.border)
      .bg(t.raised)
      .child(div().w(8).h(8).rounded(4).flex_none().bg(on ? t.done : t.dim))
      .child(
        v_flex()
          .flex_1()
          .min_w(0)
          .child(div().text_size(13).font_semibold().child(on ? `On · ${s.name ?? "this computer"}` : "Off"))
          .child(div().text_size(12).text_color(t.dim).truncate().child(on ? (s.login ? "Starts with your login." : "Running until you log out.") : "Phones can't reach this computer.")),
      )
      .child(
        on
          ? this.button(t, "pl-off", this.busy === "off" ? "Turning off…" : "Turn off", (cx) => this.act("off", ["stop"], cx), { disabled: Boolean(this.busy) })
          : this.button(t, "pl-on", this.busy === "on" ? "Turning on…" : "Turn on", (cx) => this.turnOn(cx), { primary: true, disabled: Boolean(this.busy), spinning: this.busy === "on" }),
      );
  }

  // A code made while the dialog was closing must not outlive it.
  async showCode(r) {
    if (this.closed) return this.bridge(["cancel"]);
    this.pairing = { ...r, copied: false };
  }

  // The clipboard may sync to other devices (macOS Universal Clipboard), so the link only goes on
  // it once the bridge has cut its code to 2 minutes (`copied`, pairing.mjs COPIED_LIFE). If the
  // bridge can't, nothing is copied.
  copyLink(cx) {
    const p = this.pairing;
    if (this.busy || !p) return;
    this.busy = "copy";
    this.error = null;
    cx.notify();
    cx.spawn(async (cx) => {
      const r = await this.bridge(["copied"]);
      if (r.ok === false) this.error = r.error === "node" ? "Pocket Link needs Node.js 20.3 or newer." : r.error;
      else if (this.pairing === p && !this.closed) {
        p.expires = Math.min(p.expires, r.expires);
        p.copied = true;
        cx.write_to_clipboard(p.link);
      }
      await this.reload();
      this.busy = null;
      cx.notify();
    });
  }

  pairCard(t) {
    const p = this.pairing;
    if (!p)
      return v_flex()
        .gap(8)
        .child(this.note(t, "Open Herdr Pocket on the phone, tap Pair with Herdr desktop, and scan the code this makes. The code works once, for 10 minutes, and ends when you close this window."))
        .child(h_flex().child(this.button(t, "pl-pair", this.busy === "pair" ? "Making a code…" : "Pair a phone", (cx) => this.act("pair", ["pair"], cx, (r) => this.showCode(r)), { primary: true, disabled: Boolean(this.busy), spinning: this.busy === "pair" })));
    return v_flex()
      .gap(10)
      .items_center()
      .p(14)
      .rounded(10)
      .border_1()
      .border_color(t.border)
      .bg(t.raised)
      .child(this.qr(p.rows))
      .child(div().text_size(12.5).text_color(t.foreground).child("Scan with Herdr Pocket"))
      .child(div().text_size(12).text_color(t.dim).child(`Expires in ${left(p.expires)} · works once`))
      .child(
        h_flex()
          .gap(8)
          .child(this.button(t, "pl-copy", p.copied ? "Copied" : "Copy link", (cx) => this.copyLink(cx), { disabled: Boolean(this.busy), spinning: this.busy === "copy" }))
          .child(this.button(t, "pl-new", "New code", (cx) => this.act("pair", ["pair"], cx, (r) => this.showCode(r)), { disabled: Boolean(this.busy) })),
      )
      .child(div().w_full().text_center().text_size(11.5).line_height("16px").text_color(t.dim).child(p.copied ? COPIED : COPY));
  }

  // Drawn from its modules, each row as runs of dark and light; the white
  // quiet zone keeps it readable on a dark theme.
  qr(rows) {
    const cell = Math.max(2, Math.floor(224 / rows.length));
    return v_flex()
      .flex_none()
      .p(cell * 3)
      .rounded(8)
      .bg("#ffffff")
      .children(rows.map((row) => h_flex().flex_none().children((row.match(/1+|0+/g) ?? []).map((run) => div().flex_none().w(run.length * cell).h(cell).when(run[0] === "1", (el) => el.bg("#000000"))))));
  }

  phone(t, d) {
    return h_flex()
      .id(`pl-phone-${d.id}`)
      .h(40)
      .px(10)
      .gap(10)
      .items_center()
      .rounded(8)
      .hover((s) => s.bg(t.hover))
      .child(svg(I("phone")).size(15).text_color(t.muted))
      .child(
        v_flex()
          .flex_1()
          .min_w(0)
          .child(
            h_flex()
              .gap(8)
              .min_w(0)
              .child(div().text_size(13).truncate().child(d.name))
              .child(div().flex_none().text_size(11.5).text_color(t.dim).child(d.fingerprint ?? d.id.slice(0, 12))),
          )
          .child(div().text_size(11.5).text_color(t.dim).child(`Last seen ${ago(d.seen)}`)),
      )
      .child(this.button(t, `pl-forget-${d.id}`, "Remove", (cx) => this.act("forget", ["forget", d.id], cx), { disabled: Boolean(this.busy) }));
  }

  resetRow(t, count) {
    const disabled = Boolean(this.busy);
    if (!this.confirmReset) {
      return h_flex().pt(8).child(this.button(t, "pl-reset", "Reset key…", (cx) => {
        this.confirmReset = true;
        cx.notify();
      }, { disabled }));
    }
    const phones = count === 0 ? "no phones are paired" : `every phone (${count}) is unpaired and pairs again with a new code`;
    return v_flex().pt(8).gap(6)
      .child(this.note(t, `A new key for this computer: ${phones}. Codes shown before stop working.`))
      .child(h_flex().gap(6)
        .child(this.button(t, "pl-reset-confirm", "Reset key", (cx) => {
          this.confirmReset = false;
          this.act("reset", ["reset"], cx, () => {
            this.pairing = null;
            notify({ title: "Key reset", body: "Every phone was unpaired. Pair them again with a new code.", level: "success", timeout: 8000 });
          });
        }, { disabled }))
        .child(this.button(t, "pl-reset-cancel", "Cancel", (cx) => {
          this.confirmReset = false;
          cx.notify();
        }, { disabled })));
  }

  render() {
    const t = theme();
    const s = this.status;
    const body = this.problem
      ? [this.blocked(t)]
      : !s
        ? [div().pt(14).text_size(12.5).text_color(t.dim).child("Asking the bridge…")]
        : [
            this.power(t, s),
            ...(s.running ? [this.section(t, "Pair a phone"), this.pairCard(t)] : []),
            this.section(t, s.devices.length ? "Paired phones" : "No phones paired yet"),
            v_flex().children(s.devices.map((d) => this.phone(t, d))),
            this.resetRow(t, s.devices.length),
          ];
    return v_flex()
      .id("pocket-link")
      .track_focus(this.handle)
      .on_key_down((e, cx) => { if (e.key === "escape") { this.dismiss(); cx.stop_propagation(); } })
      .w_full()
      .min_h(0)
      .p(18)
      .bg(t.popover)
      .text_color(t.foreground)
      .child(
        h_flex()
          .items_center()
          .gap(8)
          .child(svg(I("link")).size(16).text_color(t.accent))
          .child(div().flex_1().text_size(15).font_semibold().child("Pocket Link"))
          .child(div().text_size(11).text_color(t.dim).child("Esc")),
      )
      .child(div().pt(6).child(this.note(t, "Your agents on your phone, from anywhere. A phone pairs once with a code from this screen: no SSH, no password, no port to open.")))
      .children(body)
      .when(Boolean(this.error), (el) => el.child(div().pt(10).text_size(12).text_color(t.blocked).child(String(this.error))))
      .child(
        div()
          .pt(16)
          .text_size(11.5)
          .line_height("17px")
          .text_color(t.dim)
          .child("Phones connect directly when they can, and otherwise through a public iroh relay that passes along encrypted bytes it can't read. A removed phone's sessions close within 2 seconds; agents it started keep running."),
      );
  }
}
