import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { appHome, automagikHome, preloadOf } from '../src/dsh.js'
import { DATA_NAME, dataPathsOf, PRODUCT } from '../src/identity.js'

const read = file => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8')
const builder = read('electron-builder.yml')
// A top-level key of electron-builder.yml, or one under a top-level section.
function setting(key, section) {
  const lines = builder.split('\n')
  const start = section ? lines.indexOf(`${section}:`) : -1
  if (section && start === -1) return undefined
  for (const line of lines.slice(start + 1)) {
    if (section && /^\S/.test(line)) break
    const match = line.match(new RegExp(`^${section ? ' {2}' : ''}${key}:\\s*(.+)$`))
    if (match) return match[1].trim()
  }
  return undefined
}
const expand = (pattern, values) => pattern.replace(/\$\{(\w+)\}/g, (_, name) => values[name])

test('the app is called Automagik where a person sees it', () => {
  assert.equal(PRODUCT, 'Automagik')
  assert.equal(JSON.parse(read('package.json')).productName, PRODUCT)
  assert.equal(setting('productName'), PRODUCT)
  assert.equal(setting('title', 'dmg'), 'Automagik ${version}')
  assert.match(read('src/shell.html'), /<title>Automagik<\/title>/)
  assert.match(read('src/shell.html'), /<b>Automagik<\/b>/)
})

test('the installed identity is Automagik\'s', () => {
  // macOS takes an update only for the same bundle id (and signer).
  assert.equal(setting('appId'), 'ai.namastex.automagik')
  // Linux: the window's app id, the desktop entry, /usr/bin/automagik and the AppArmor
  // profile follow these; the same deb package upgrades the installed one.
  assert.equal(JSON.parse(read('package.json')).desktopName, 'automagik.desktop')
  assert.equal(setting('executableName', 'linux'), 'automagik')
  assert.equal(setting('packageName', 'deb'), 'automagik')
  assert.equal(setting('syncDesktopName', 'linux'), 'true')
  // omni:// is Omni's scheme: its pages make the links.
  assert.match(builder, /schemes:\n\s+- omni\n/)
})

test("Electron's data is filed under Automagik, on every platform", () => {
  assert.equal(DATA_NAME, 'Automagik')
  // appData as Electron gives it on each platform; the folder joins it in the platform's own form.
  for (const appData of ['/Users/me/Library/Application Support', '/home/me/.config', 'C:\\Users\\me\\AppData\\Roaming']) {
    const folder = join(appData, 'Automagik')
    assert.deepEqual(dataPathsOf(appData), { userData: folder, sessionData: folder })
  }
})

test('main.js pins that folder before anything reads it', () => {
  const main = read('src/main.js')
  const pin = main.indexOf("dataPathsOf(app.getPath('appData'))")
  assert.ok(pin > 0, 'main.js pins userData')
  // The single-instance lock lives in userData; the paths derived from it are read after.
  for (const later of ['requestSingleInstanceLock()', 'whenReady()', 'appHome()']) {
    assert.ok(pin < main.indexOf(later), `the pin comes before ${later}`)
  }
  assert.doesNotMatch(main.slice(0, pin), /app\.getPath\('(userData|sessionData)'\)/)
})

test("the app's own home and the preload the CLIs write are in Automagik's home", (t) => {
  assert.equal(automagikHome({}), join(homedir(), '.automagik'))
  assert.equal(appHome({}), join(homedir(), '.automagik', 'desktop'))
  const root = mkdtempSync(join(tmpdir(), 'automagik-identity-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  assert.equal(appHome({ AUTOMAGIK_HOME: root }), join(root, 'desktop'))
  // `omni desktop` and `genie desktop` write $AUTOMAGIK_HOME/preload before opening the app.
  writeFileSync(join(root, 'preload'), 'genie\n')
  assert.equal(preloadOf({ home: automagikHome({ AUTOMAGIK_HOME: root }), argv: ['/opt/Automagik/automagik'] }), 'genie')
})

test("macOS asks for the microphone and the local network with the app's own lines", () => {
  // The keys under mac.extendInfo, which electron-builder writes into Contents/Info.plist.
  const lines = builder.split('\n')
  const start = lines.indexOf('  extendInfo:', lines.indexOf('mac:'))
  assert.ok(start > lines.indexOf('mac:'), 'mac has extendInfo')
  const info = {}
  for (const line of lines.slice(start + 1)) {
    const match = line.match(/^ {4}(\w+):\s*(.+)$/)
    if (!match) break
    info[match[1]] = match[2].trim()
  }
  assert.equal(info.NSMicrophoneUsageDescription,
    'Automagik listens to you only while voice chat is on, to hear what you say to your Bots.')
  // Without it macOS never asks, and a LAN-hosted Omni fails with EHOSTUNREACH (#96).
  assert.equal(info.NSLocalNetworkUsageDescription,
    'Automagik connects to Omni and other services on your local network.')
})

test('the artifacts are named Automagik, and the CLIs and the update feeds still find them', () => {
  const linux = setting('artifactName', 'linux')
  const mac = setting('artifactName', 'mac')
  const appImage = expand(linux, { version: '3.261024.1', arch: 'x86_64', ext: 'AppImage' })
  const deb = expand(linux, { version: '3.261024.1', arch: 'amd64', ext: 'deb' })
  const dmg = expand(mac, { version: '3.261024.1', arch: 'arm64', ext: 'dmg' })
  const zip = expand(mac, { version: '3.261024.1', arch: 'arm64', ext: 'zip' })
  assert.deepEqual([appImage, deb, dmg, zip], [
    'Automagik-3.261024.1-linux-x86_64.AppImage',
    'Automagik-3.261024.1-linux-amd64.deb',
    'Automagik-3.261024.1-mac-arm64.dmg',
    'Automagik-3.261024.1-mac-arm64.zip',
  ])
  // What `omni desktop` (automagik-si/omni packages/cli) and `genie desktop` match.
  assert.match(appImage, /-linux-x86_64\.AppImage$/)
  assert.doesNotMatch(deb, /-linux-x86_64\.AppImage$/)
  assert.match(dmg, /-mac-arm64\.dmg$/)
  // electron-updater on Apple silicon takes the feed's zip whose name says arm64.
  assert.match(zip, /arm64.*\.zip$/)
  // The version in the AppImage's name tells electron-updater to give the update its own
  // name beside the old file rather than overwrite it under the old name.
  assert.match(appImage, /\d+\.\d+\.\d+/)
})
