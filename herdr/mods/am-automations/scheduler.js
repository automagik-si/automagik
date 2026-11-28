// The scheduler release this panel installs and drives: our build of the vendored fork
// (herdr/scheduler/, UPSTREAM.md), not upstream DnzzL's own release. When `herdr-automations` is
// missing (#220) the panel offers repairCommand() as the install line: Copy copies it, Install runs
// it, and only a click does. The sha256s are our release's checksums.txt, pinned here (`sha256` the
// two darwin builds, `linux` the two Linux ones), and herdr/scripts/scheduler-pin.mjs checks all four
// against that release. install.sh reads this file out of the pack tarball it has just verified and
// installs the same build, so it holds no pin of its own. Pure: no `herdr`, so Node reads the same
// pins the panel installs. Apache-2.0.
export const SCHEDULER = Object.freeze({
  repo: "automagik-si/automagik",
  version: "0.12.1-am.4",
  sha256: Object.freeze({
    arm64: "56570b51550845a0f8eb1895da7bf852d9a6b85d8948d98c94f2f49297658f95",
    amd64: "b347506618b1010f172f59a2946701628d81bd2fbbdfb6511ebab1dc8e658030",
  }),
  linux: Object.freeze({
    arm64: "6226114232b5453e95d8ab6ed8169cccfd1e1dea0750f9a9690b7bd0b0a012bf",
    amd64: "aa7439f54aed2ab7c691f9f51b991072553756ca04fa1f844f9b4d36f48e4d9a",
  }),
});

/** The command that installs the scheduler to ~/.local/bin, hash-checked, for this machine's
 * `uname -m` and `uname -s` (anything but Linux reads as a Mac; a subshell, so the terminal it is
 * pasted in stays where it was). Its scratch folder is removed whether it worked or not, and the
 * subshell exits with the install's own status. `d=` comes first: a subshell inherits the calling
 * shell's variables, and the cleanup must only ever remove the folder this command made, never a
 * `d` the person's terminal already had when an early step fails. */
export function repairCommand(machine, os = "Darwin") {
  const linux = os === "Linux";
  const arch = machine === "x86_64" || machine === "amd64" ? "amd64" : "arm64";
  const url = `https://github.com/${SCHEDULER.repo}/releases/download/herdr-automations-v${SCHEDULER.version}/herdr-automations_${linux ? "linux" : "darwin"}_${arch}`;
  return `(d=; mkdir -p ~/.local/bin && d="$(mktemp -d)" && cd "$d" && curl -fsSLo herdr-automations ${url}`
    + ` && echo "${(linux ? SCHEDULER.linux : SCHEDULER.sha256)[arch]}  herdr-automations" | ${linux ? "sha256sum -c" : "shasum -a 256 -c"}`
    + ' && chmod 755 herdr-automations && mv herdr-automations ~/.local/bin/; s=$?; cd /; [ -z "$d" ] || rm -rf "$d"; exit "$s")';
}
