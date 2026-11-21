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
  version: "0.12.1-am.3",
  sha256: Object.freeze({
    arm64: "bbfadb3fe520a326647c8a7be3e13dfc7df905d3d04763b2f02e023c198ef214",
    amd64: "2e41b077e798310976a464bd4369adbea2a141f1f4ce4d3e83a4c3642935cfd0",
  }),
  linux: Object.freeze({
    arm64: "6d29683be59cbde54b9dbe934f10f83467e9ff695fce46bd17f6444212a69622",
    amd64: "2262dfab7599d658f080c0d739c215a84f3f880103ea5d1f5b5fcfec1f365821",
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
