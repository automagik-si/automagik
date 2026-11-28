// The scheduler release this panel installs and drives: our build of the vendored fork
// (herdr/scheduler/, UPSTREAM.md), not upstream DnzzL's own release. When `herdr-automations` is
// missing (#220) the panel offers repairCommand() as the install line. The same command replaces a
// different build on Update. The sha256s are our release's checksums.txt, pinned here (`sha256` the
// two darwin builds, `linux` the two Linux ones), and herdr/scripts/scheduler-pin.mjs checks them
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

export function schedulerAsset(machine, os) {
  const arch = ["x86_64", "amd64"].includes(machine) ? "amd64"
    : ["arm64", "aarch64"].includes(machine) ? "arm64" : null;
  if (!arch || !["Linux", "Darwin"].includes(os)) return null;
  const linux = os === "Linux";
  return {
    name: `herdr-automations_${os.toLowerCase()}_${arch}`,
    sha256: (linux ? SCHEDULER.linux : SCHEDULER.sha256)[arch],
    hash: linux ? ["sha256sum"] : ["shasum", "-a", "256"],
    stat: linux ? ["-Lc", "%d %i %s %y"] : ["-Lf", "%Xd %i %z %.9Fm"],
  };
}

// Discover the file before asking it for a version. A file that hangs or says nothing still counts.
export const FIND_SCHEDULER = [
  'bin=$(command -v herdr-automations 2>/dev/null) || bin=',
  'if ! { [ -f "$bin" ] && [ -x "$bin" ]; }; then bin=$1; fi',
  '[ -f "$bin" ] && [ -x "$bin" ] || exit 1',
  'case $bin in /*) ;; *) bin=$PWD/$bin ;; esac',
  'resolved=$(realpath "$bin" 2>/dev/null) || resolved=',
  'printf "%s\\0%s" "$bin" "$resolved"',
].join("\n");

export const quote = (word) => "'" + word.replace(/'/g, "'\\''") + "'";

/** Stage beside the destination so the final move is a rename on the same filesystem. On Update,
 * check the stamped file again before committing, in case it changed during the download. */
export function repairCommand(machine, os = "Darwin", { bin, stamp } = {}) {
  const asset = schedulerAsset(machine, os);
  if (!asset) return null;
  const url = `https://github.com/${SCHEDULER.repo}/releases/download/`
    + `herdr-automations-v${SCHEDULER.version}/${asset.name}`;
  const target = bin ? quote(bin) : '"$HOME/.local/bin/herdr-automations"';
  const unchanged = bin
    ? `[ "$(stat ${asset.stat.map(quote).join(" ")} "$bin")" = ${quote(stamp)} ]`
      + ' || { echo "The scheduler changed during the update. Try again." >&2; exit 1; }'
    : '[ ! -e "$bin" ] || { echo "A scheduler is already installed." >&2; exit 1; }';
  const move = os === "Linux" ? "mv -fT" : "mv -fh";
  const blocked = bin ? "The scheduler path is a link or directory. Check the path and try again."
    : "The scheduler path is a link or directory. Move it aside, then try Install again.";
  const script = [
    `bin=${target}; dir="\${bin%/*}"`,
    'plain_target() {',
    '  if [ -L "$bin" ] || [ -d "$bin" ]; then',
    `    echo "${blocked}" >&2; exit 1`,
    '  fi',
    '}',
    'plain_target',
    unchanged,
    ...(!bin ? ['mkdir -p "$dir" || exit'] : []),
    // A killed command may leave its private directory or the staged file. A PID in the name
    // lets a new invocation leave concurrent updates alone.
    'prefix=$dir/.herdr-automations-update.',
    'for old in "$prefix"*.?????? "$prefix"*.??????.bin; do',
    '  [ ! -L "$old" ] && [ -O "$old" ] || continue',
    '  owner=${old##*/.herdr-automations-update.}; owner=${owner%%.*}',
    '  case $owner in ""|0*|*[!0-9]*) continue ;; esac',
    '  kill -0 "$owner" 2>/dev/null || rm -rf "$old"',
    'done',
    'd=$(mktemp -d "$dir/.herdr-automations-update.$$.XXXXXX") || exit',
    'staged=$d.bin',
    'linked=',
    `trap 'rm -rf "$d"; [ -z "$linked" ] || rm -f "$staged"' 0`,
    `trap 'exit 1' HUP INT TERM`,
    '(',
    '  cd "$d" || exit',
    `  curl -fsSLo herdr-automations --max-time 25 ${url} || exit`,
    `  printf '%s  herdr-automations\\n' ${asset.sha256} | ${asset.hash.join(" ")} -c || exit`,
    ') || exit',
    // Use a sibling hard link so the private directory can be removed before the monitored
    // process execs mv. A killed downloader has no path to the final rename.
    'ln "$d/herdr-automations" "$staged" || exit',
    'linked=1',
    'rm -rf "$d" || exit',
    'chmod 755 "$staged" || exit',
    'plain_target',
    unchanged,
    `exec ${move} "$staged" "$bin"`,
  ].join("\n");
  return `sh -c ${quote(script)}`;
}

// Compare upstream X.Y.Z and the fork's X.Y.Z-am.N only. A local label like "dev" has no order.
function versionParts(version) {
  const match = /^v?(\d{1,9})\.(\d{1,9})\.(\d{1,9})(?:-am\.(\d{1,9}))?$/.exec(version);
  return match && match.slice(1).map((part) => Number(part ?? 0));
}

export function updateMessage(version) {
  const installed = versionParts(version);
  const pinned = versionParts(SCHEDULER.version);
  const first = installed?.findIndex((part, i) => part !== pinned[i]) ?? -1;
  if (first >= 0 && installed[first] < pinned[first]) {
    return `This machine has an older scheduler build (${version}).`
      + ` This pack needs ${SCHEDULER.version}.`;
  }
  if (first >= 0) {
    return `This machine has a newer scheduler build (${version}).`
      + ` Update replaces it with this pack's build (${SCHEDULER.version}).`;
  }
  const reported = installed || version === "dev" ? ` (${version})` : "";
  return `This machine has a different scheduler build${reported}.`
    + ` Update installs this pack's build (${SCHEDULER.version}).`;
}
