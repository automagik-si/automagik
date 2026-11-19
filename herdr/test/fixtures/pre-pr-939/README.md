# Pre-PR pack CLI (#939)

`automagik-herdr.mjs` and `revive.js` are the pack's files at `b227988ac`, the base of the
pull request that added the macOS login service, copied byte-for-byte with
`git show b227988ac:herdr/mods/am-sidebar/<file>`. Every other pack file these two import is
byte-equal between that base and the pull request, so installing a pack and putting these two
files back reconstructs the real pre-PR pack for the uninstall test.

Do not edit them and do not replace them with a stand-in. Their point is the pre-PR behaviour
the probe must not mistake for a launchd-aware CLI: on macOS this command answers
`revive service status` with exit 0 (it reports the systemd unit as not installed, and its JSON
names no launchd label or `Library/LaunchAgents` path), and it refuses only
`revive service uninstall`, with exit 1.
