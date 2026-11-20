// The scheduler release this panel installs and drives: our build of the vendored fork
// (herdr/scheduler/, UPSTREAM.md), not upstream DnzzL's own release. When `herdr-automations` is
// missing (#220) the panel offers repairCommand() as the install line: Copy copies it, Install runs
// it, and only a click does. The sha256s are our release's checksums.txt, pinned here (`sha256` the
// two darwin builds, `linux` the two Linux ones), and herdr/scripts/scheduler-pin.mjs checks all four
// against that release. install.sh reads this file out of the pack tarball it has just verified and
// installs the same build, so it holds no pin of its own. Pure: no `herdr`, so Node reads the same
// pins the panel installs. Apache-2.0.
export const SCHEDULER = Object.freeze({
  repo: "automagik-dev/automagik",
  version: "0.12.1-am.2",
  sha256: Object.freeze({
    arm64: "ced0a5cfcd1cf7ab1e97762082f83eb7eb75a61f060322a240eb9bc53aa3d67d",
    amd64: "c2b4d96153517df47491c7704273f0ef77b55f66912d1e30eb56dae1b2752ecb",
  }),
  linux: Object.freeze({
    arm64: "7ba6d3ff46b8dfc311be2482b463f1685d53ee1c69d3bd0ec27c6ba130a76567",
    amd64: "09d3152b839727b3357f6c82a828aa88c6fdccf10c3f934e10f4f77706a45ed1",
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
