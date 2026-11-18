import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { fileText, scan } from '../../herdr/scripts/privacy-check.mjs'
import { htmlPage, privacyNote, supportPrivacy, waitlistForm, waitlistIntro } from './waitlist/lib/ui.js'
import { WHATSAPP_SIGNUPS_OPEN } from './waitlist/lib/shared.js'
import { themeCss, titleFace, brandFonts, statusNames } from './scripts/sync-theme.mjs'
import { pages, routes, rootFiles, weUnfold, arca, arcaLogo, arcaArk, oiTag, platforms, offered, used, usedCredit, trademarks, brand as siteLogo, icons, manifest as webManifest, family, familyArt, familyButton, familyHost, familyLinks } from './scripts/build-pages.mjs'
import { BOX, GEOMETRY, LOGO, TONES, logoInner, tagInner } from './scripts/build-lockup.mjs'

// The width of each name's lockup in the kit's own units; all are 264 high.
const LOCKUP_BOX = { Automagik: '1632.34' }
// Genie's, Omni's and Mykes's own files, byte copies of the brand folder's (docs/brand/logo):
// each product's lockup (its flat mark beside its name; Omni has a drawing for small sizes
// too) and its mark alone (Omni's is the one drawn for about 32 px). [frame, the file's label].
const PRODUCT_LOCKUPS = { genie: ['genie-lamp-lockup', '0 -186 1114.74 264', 'Genie', ['']], omni: ['omni-mark-lockup', '0 -186 885.24 264', 'Omni', ['', '-header']], mykes: ['mykes-clean-lockup', '0 -186 1058.16 264', 'mykes', ['']] }
const PRODUCT_MARKS = { omni: ['omni-mark', '-32', '0 0 120 120', 'Omni', 120, 120], genie: ['genie-lamp', '', '0 -145.93 392.11 199.79', 'Genie lamp', 392, 200], mykes: ['mykes-clean', '', '0 -186.24 219.93 222.42', 'Mykes mark, cords on clean arcs', 220, 222] }
const productFiles = [
  ...Object.values(PRODUCT_LOCKUPS).flatMap(([stem, , , sizes]) => sizes.flatMap(size => ['ink', 'cream'].map(tone => [`${stem}-${tone}${size}.svg`, 'lockups']))),
  ...['genie', 'omni', 'mykes'].flatMap(slug => ['ink', 'cream'].map(tone => [`${PRODUCT_MARKS[slug][0]}-${tone}${PRODUCT_MARKS[slug][1]}.svg`, 'svg'])),
]

const root = resolve(fileURLToPath(new URL('.', import.meta.url)))
const read = path => readFileSync(resolve(root, path), 'utf8')
const theme = read('theme.css'), css = read('styles.css')
const captures = read('assets/CAPTURES.md')
const manifest = JSON.parse(read('assets/screens/manifest.json'))
const art = JSON.parse(read('assets/art/manifest.json'))
const release = JSON.parse(read('assets/releases.json')).pocket
const privacy = JSON.parse(read('../../herdr/scripts/privacy-list.json'))
const generated = pages()
const htmlAt = route => read(`${route.slice(1)}index.html`)
const repo = 'https://github.com/automagik-si/automagik'
const docs = 'https://docs.automagik.dev'
const downloads = [...['Mac.dmg', 'Linux.deb', 'Linux.AppImage'].map(name => `${repo}/releases/latest/download/Automagik-${name}`), release.url]
const allowed = new Set([repo, docs, ...downloads, ...routes.map(route => `https://automagik.si${route}`), 'mailto:privacy@automagik.si', weUnfold.url, ...used.map(project => project.href)])
// Text as a reader gets it: inline tags vanish, block tags become a space.
const plain = html => html.replace(/<\/?(?:a|span|strong)\b[^>]*>/g, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')
const productOrder = ['/desktop/', '/mobile/', '/omni/', '/genie/', '/cloud/', '/arca/', '/mykes/']
// Arca's page is Arca's own, served by Arca's Worker at this address (RFC 0027): a product in
// every list here, linked in the same tab, and never a page this site builds.
const arcaPath = '/arca/'
const local = path => {
  const full = resolve(root, path.replace(/^\//, ''))
  assert.ok(full.startsWith(root + sep) || full === root.slice(0, -1), path)
  assert.ok(existsSync(full), path)
}

// The one script a page carries: the family drawer's own, a file of this site, deferred.
const familyScript = '<script src="/assets/family/family.js" defer></script>'
test('approved umbrella map, one h1 per page, generated sources current, one script: the family drawer\'s', () => {
  assert.deepEqual(routes, ['/', ...productOrder.filter(route => route !== arcaPath)])
  for (const route of routes) {
    const html = htmlAt(route)
    assert.equal(html, generated.get(route), `Regenerate ${route}`)
    assert.equal((html.match(/<h1\b/g) ?? []).length, 1, route)
    assert.match(html, /<html lang="en">/)
    // Production is indexable: no page asks a search engine or an AI crawler to stay away.
    assert.doesNotMatch(html, /<meta[^>]*name="robots"|noindex|nofollow/i, route)
    assert.match(html, /href="\/theme.css"/)
    // The docs site is the one automagik.dev address the pages name, and only as a link.
    // No inline script, no handler attribute, no frame: the one script is the drawer's file.
    assert.equal(html.split(familyScript).length, 2, route)
    assert.ok(html.endsWith(`${familyScript}</body></html>\n`), route)
    assert.doesNotMatch(html.replace(familyScript, '').replaceAll(`href="${docs}"`, ''), /<(?:script|iframe)\b|\bon\w+\s*=|javascript:|automagik\.dev|automagik-dev|\.pages\.dev/i)
    const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(match => match[1])
    assert.equal(new Set(ids).size, ids.length)
    assert.match(html, /class="skip" href="#main"/)
  }
  const home = htmlAt('/')
  assert.match(home, /id="film"/); assert.match(home, /id="blocks"/)
  assert.equal((home.match(/class="product-card"/g) ?? []).length, 7)
  assert.equal([...generated.values()].join('').match(/data-film=/g).length, 1)
  assert.match(home, /data-film="placeholder"/)
})

test('the download hook: live platforms open a sheet with the exact file, soon ones are not controls', () => {
  assert.deepEqual(Object.keys(offered), ['/', '/desktop/', '/mobile/'])
  assert.deepEqual(Object.keys(platforms).filter(id => platforms[id].soon), ['windows', 'iphone'])
  for (const [route, ids] of Object.entries(offered)) {
    const html = htmlAt(route)
    const row = html.match(/<ul class="get-row">(.*?)<\/ul>/)[1]
    const chips = row.split('</li>').slice(0, -1)
    assert.equal((html.match(/class="get-row"/g) ?? []).length, 1, route)
    assert.deepEqual(chips.map(chip => chip.match(/class="get-name">([^<]+)</)[1]), ids.map(id => platforms[id].name), route)
    const sheets = new Map([...html.matchAll(/<div class="sheet" id="get-([a-z]+)" popover role="dialog" aria-labelledby="get-\1-title">([\s\S]*?)(?=<div class="sheet" id=|<div class="fam-scrim"|<\/body>)/g)].map(match => [match[1], match[2]]))
    assert.deepEqual([...sheets.keys()], ids.filter(id => !platforms[id].soon), route)
    ids.forEach((id, index) => {
      const chip = chips[index], platform = platforms[id]
      if (platform.soon) {
        // Coming later: a label, never a link or a button, and no file is named for it.
        assert.match(chip, /^<li class="get-chip soon">/, `${route} ${id}`)
        assert.doesNotMatch(chip, /<a\b|<button\b|href=|popovertarget/, `${route} ${id}`)
        assert.match(chip, /<small class="get-kind">Soon<\/small>$/, `${route} ${id}`)
        return
      }
      // One button that opens this platform's sheet, and a plain link for a browser without popovers.
      assert.equal((chip.match(/<button\b/g) ?? []).length, 1, `${route} ${id}`)
      assert.match(chip, new RegExp(`<button class="get-chip" type="button" popovertarget="get-${id}" aria-label="${platform.name}: `), `${route} ${id}`)
      const fallback = chip.match(/<a class="get-chip get-fallback" href="([^"]+)">/)[1]
      assert.equal(fallback, route === '/' ? `${platform.page}#install` : platform.download[1], `${route} ${id}`)
      const sheet = sheets.get(id)
      assert.match(sheet, new RegExp(`<h2 id="get-${id}-title" tabindex="-1" autofocus>For ${platform.name}</h2>`))
      assert.match(sheet, /<button class="sheet-close" type="button" popovertarget="get-[a-z]+" popovertargetaction="hide" aria-label="Close">/)
      assert.ok(sheet.includes(`<p class="sheet-gets">${platform.gets}</p>`), `${route} ${id}`)
      // The file the sheet names is the file its one download button fetches.
      const links = [...sheet.matchAll(/<a\b[^>]*href="([^"]+)"/g)].map(match => match[1])
      const files = links.filter(href => downloads.includes(href))
      assert.deepEqual(files.sort(), [platform.download[1], ...(platform.other ? [platform.other[2]] : [])].sort(), `${route} ${id}`)
      assert.deepEqual([...sheet.matchAll(/<a class="button primary" href="([^"]+)"/g)].map(match => match[1]), [platform.download[1]], `${route} ${id}`)
      assert.equal(platform.download[1].split('/').pop(), platform.file, id)
      assert.ok(sheet.includes(`<dt>File</dt><dd><code>${platform.file}</code></dd>`), `${route} ${id}`)
      assert.ok(sheet.includes(`>${platform.download[0]} `), `${route} ${id}`)
      // How to install, here, and one link to the guide on the docs site.
      assert.ok((sheet.match(/<ol class="steps">(.*?)<\/ol>/)[1].match(/<li>/g) ?? []).length >= 2, `${route} ${id}`)
      assert.deepEqual(links.filter(href => href.startsWith(docs)).length, 1, `${route} ${id}`)
      assert.match(sheet, new RegExp(`<a class="detail-link" href="${docs}[^"]*">${platform.name} guide `))
      assert.equal(links.includes(platform.page), route === '/', `${route} ${id}`)
    })
    // Nothing on a page offers a download for a platform that has none.
    assert.doesNotMatch(html, /Download for (?:Windows|iPhone)|\.exe\b|\.msi\b|\.ipa\b|apps\.apple\.com/i, route)
  }
  for (const route of routes.filter(route => !(route in offered))) assert.doesNotMatch(htmlAt(route), /class="get-row"|class="sheet"/, route)
  const mobile = htmlAt('/mobile/'), desktop = htmlAt('/desktop/')
  assert.equal(platforms.android.download[1], release.url)
  assert.match(release.url, /^https:\/\/github.com\/automagik-si\/automagik\/releases\/download\/v[0-9.]+\/automagik-pocket-[0-9.]+\.apk$/)
  assert.match(release.sha256, /^[a-f0-9]{64}$/)
  for (const html of [mobile, htmlAt('/')]) assert.ok(html.replaceAll('<wbr>', '').includes(`<code class="sum">${release.sha256}</code>`))
  // Herdr and DSH: two short entries after the downloads, each with one link to its guide and no commands.
  const ways = desktop.match(/<ul class="way-list">(.*?)<\/ul>/)[1]
  assert.ok(desktop.indexOf('class="get-row"') < desktop.indexOf('class="way-list"'))
  assert.deepEqual([...ways.matchAll(/<h3>([^<]+)<\/h3>/g)].map(match => match[1]), ['Install on Herdr', 'Install on DSH'])
  assert.deepEqual([...ways.matchAll(/<a class="detail-link" href="([^"]+)">(\w+) guide /g)].map(match => [match[1].startsWith(docs), match[2]]), [[true, 'Herdr'], [true, 'DSH']])
  assert.equal((ways.match(/<a\b/g) ?? []).length, 2)
  assert.doesNotMatch(ways, /<code\b|<pre\b/)
  assert.match(ways, /It needs Herdr and the Automagik pack; the app alone does not set it up\./)
  assert.match(desktop, /switch still says Work/)
  assert.match(htmlAt('/cloud/'), /Cloud is not live/)
  for (const route of ['/mykes/']) assert.match(htmlAt(route), /Coming soon\./)
  // The sheet is a popover: no script. It moves only for visitors who allow motion, and a
  // browser without popovers gets the plain links instead of dead buttons.
  assert.match(css, /@supports not selector\(:popover-open\)\{[^}]*\n?\s*button\.get-chip,\.sheet\{display:none !important\}/)
  assert.match(css, /\.get-fallback\{display:none\}/)
})

test('every href/action points locally or to an exact reviewed destination', () => {
  for (const [route, html] of generated) {
    for (const [, href] of html.matchAll(/href="([^"]+)"/g)) {
      if (/^[a-z]+:/i.test(href) || href.startsWith('//')) assert.ok(allowed.has(href), href)
      else {
        const url = new URL(href, `https://automagik.si${route}`)
        if (routes.includes(url.pathname)) {
          if (url.hash) assert.ok(htmlAt(url.pathname).includes(`id="${url.hash.slice(1)}"`), href)
        // Arca's page is not a file here: the one address, as written, and no place inside it.
        } else if (url.pathname.startsWith('/arca')) assert.equal(href, arcaPath, `${route}: ${href}`)
        else local(url.pathname)
      }
    }
    for (const [, action] of html.matchAll(/\saction="([^"]+)"/g)) assert.equal(action, '/api/waitlist')
    // Guides and help are on the docs site. GitHub is linked for the downloads and once,
    // quietly, at the end of the footer; no page links to a design document or to the
    // capture notes, which stay in the repository.
    const github = [...html.matchAll(/href="(https:\/\/github\.com[^"]*)"/g)].map(match => match[1]).filter(href => !downloads.includes(href))
    assert.deepEqual(github, [repo], route)
    assert.ok(html.slice(html.indexOf('class="footer-license"')).includes(`<a href="${repo}">Source code `), route)
    assert.doesNotMatch(html, /href="[^"]*(?:\/rfcs\/|CAPTURES\.md|raw\.githubusercontent)/, route)
  }
})

test('images are reviewed brand assets, unchanged captures or recorded crops of them', () => {
  const brand = new Set(['/assets/brand/automagik-lockup-three-colours-ink-header.svg', '/assets/brand/automagik-lockup-three-colours-cream-header.svg', ...productFiles.map(([file]) => `/assets/brand/${file}`), '/assets/brand/triskle-three-colours.svg', '/assets/brand/triskle-three-colours-32.svg', '/assets/brand/omni-pleased.png', '/assets/brand/automagik/automagik-lockup-oi-ink.svg', '/assets/brand/automagik/automagik-lockup-oi-cream.svg'])
  for (const { mark: [light, dark] } of used) for (const file of [light, dark]) if (file) brand.add(`/assets/brand/used/${file}`)
  // The family drawer's art: byte copies from its package (the drawer's own test pins them).
  for (const file of Object.values(familyArt)) brand.add(`/assets/family/${file}`)
  for (const html of generated.values()) {
    for (const [, value] of html.replace(familyScript, '').matchAll(/(?:src|srcset|poster)="([^"]+)"/g)) {
      for (const source of value.split(',').map(candidate => candidate.trim().split(/\s+/)[0])) {
        local(source)
        const derived = source.startsWith('/assets/art/') && Object.hasOwn(art.files, source.slice('/assets/art/'.length))
        assert.ok(brand.has(source) || derived || Object.hasOwn(manifest.images, source.replace(/^\/assets\/screens\//, '')), source)
      }
    }
    // The drawer's pictures are the family piece's own markup, held to it by the drawer's test.
    for (const [image] of html.slice(0, html.indexOf('<div class="fam-scrim"')).matchAll(/<img\b[^>]*>/g)) {
      // Plain-words alt text, or an explicitly decorative image hidden from assistive technology.
      assert.match(image, /alt="[^"]{20,}"|alt="(?:Automagik|Genie|Omni|Mykes)"|alt="" aria-hidden="true"/)
      assert.match(image, /\bwidth="\d+" height="\d+"/, image)
      assert.match(image, /loading="lazy"|fetchpriority="high"|decoding="async"|alt="Automagik"/, image)
    }
  }
  const files = readdirSync(resolve(root, 'assets/screens')).filter(file => file.endsWith('.png')).sort()
  assert.deepEqual(Object.keys(manifest.images).sort(), files)
  for (const file of files) {
    assert.equal(createHash('sha256').update(readFileSync(resolve(root, 'assets/screens', file))).digest('hex'), manifest.images[file], file)
    assert.ok(captures.includes(file), file)
  }
  assert.equal(manifest.captureScriptsClean, true)
  // One capture set: the theme pictures come from the same runtime and Bot team release as the rest.
  assert.equal(manifest.runtime.version, '0.2.2-rc.2')
  assert.deepEqual(manifest.themeCapture.runtime, manifest.runtime)
  assert.deepEqual(manifest.themeCapture.plugin, manifest.plugins['@automagik/bots-dsh'])
  assert.equal(manifest.themeCapture.reports.length, 4)
  assert.deepEqual(manifest.pocketCapture.images.toSorted(), files.filter(file => file.startsWith('pocket-')))
  assert.ok(existsSync(resolve(root, 'capture/pocket/PocketDemoShotsTest.kt')))
})

test('the projects row: eleven projects in the approved order, each with its own unchanged file and a link to its site', () => {
  const home = htmlAt('/')
  assert.deepEqual(used.map(project => project.name), ['DeepSeek Harness', 'Herdr', 'Agent Client Protocol', 'Model Context Protocol', 'A2A', 'Hermes Agent', 'Oh My Pi', 'Pi', 'NATS', 'iroh', 'Better Auth'])
  // Only the home carries the row, once, between the hero and the blocks.
  for (const route of routes) assert.equal(htmlAt(route).split('class="we-use"').length - 1, route === '/' ? 1 : 0, route)
  const row = home.slice(home.indexOf('<section class="we-use"'), home.indexOf('<section id="blocks"'))
  assert.ok(home.indexOf('<section class="we-use"') > home.indexOf('class="scene"') && row.length > 0)
  assert.match(row, /<h2 id="we-use-title" class="we-use-title">Things that made our stack possible<\/h2>/)
  assert.ok(row.endsWith(`<p class="we-use-note wrap">${usedCredit}</p></section>\n`))
  assert.equal(usedCredit, 'Each name and logo belongs to its project; none endorses Automagik.')
  // No ranking, sponsorship or endorsement wording, and no trademark sentence in the row.
  assert.doesNotMatch(plain(row), /sponsor|partner|powered by|trusted by|official|registered|trademark/i)
  const [list, copy] = [...row.matchAll(/<ul class="we-use-list[^"]*"[^>]*>(.*?)<\/ul>/g)]
  assert.equal(list[0].startsWith('<ul class="we-use-list">'), true)
  // The second copy only fills the gap while the row drifts: same items, out of reach.
  assert.ok(copy[0].startsWith('<ul class="we-use-list we-use-copy" aria-hidden="true" inert>') && copy[1] === list[1])
  const items = [...list[1].matchAll(/<li>(.*?)<\/li>/g)].map(match => match[1])
  assert.equal(items.length, used.length)
  const digests = new Map([...read('assets/brand/LICENSES.md').matchAll(/`used\/([^`]+)`[^|]*\|[^|]*\|[^|]*\| `([0-9a-f]{64})` \|/g)].map(match => [match[1], match[2]]))
  const files = readdirSync(resolve(root, 'assets/brand/used'), { recursive: true }).filter(file => /\.\w+$/.test(file)).map(file => file.split(sep).join('/')).sort()
  assert.deepEqual(used.flatMap(({ mark: [light, dark] }) => dark ? [light, dark] : [light]).sort(), files, 'every file in the folder is shown, and nothing else is there')
  used.forEach(({ name, href, mark: [light, dark, width, height], shown, alt, wordmark }, index) => {
    const item = items[index]
    // One link, to the project's own site, never to a page of ours or to a repository host.
    assert.ok(item.startsWith(`<a class="used" href="${href}">`) && item.endsWith('</a>') && item.split('<a ').length === 2, name)
    assert.match(href, /^https:\/\/[a-z0-9.-]+(?:\/harness)?$/)
    assert.doesNotMatch(href, /github|automagik/)
    // The file is drawn at its own proportions, never stretched, and never taller than the site's own name in the header.
    const image = item.match(/<img[^>]*>/)[0]
    assert.ok(image.includes(` src="/assets/brand/used/${light}" width="${Math.round(shown * width / height)}" height="${shown}" `), name)
    assert.ok(shown <= 32 || image.includes('class="used-inset"'), name)
    // The proportions written for a mark are the file's own: an SVG's box, a PNG's header.
    for (const file of dark ? [light, dark] : [light]) {
      const bytes = readFileSync(resolve(root, 'assets/brand/used', file)), tag = file.endsWith('.svg') ? bytes.toString('utf8').match(/<svg\b[^>]*>/)[0] : ''
      const box = tag.match(/viewBox="[\d.-]+ [\d.-]+ ([\d.]+) ([\d.]+)"/)?.slice(1) ?? [tag.match(/ width="([\d.]+)"/)?.[1], tag.match(/ height="([\d.]+)"/)?.[1]]
      const [w, h] = file.endsWith('.png') ? [bytes.readUInt32BE(16), bytes.readUInt32BE(20)] : box.map(Number)
      assert.ok(Math.abs(w / h - width / height) < 0.002, `${file} is ${w} by ${h}`)
    }
    assert.equal(item.includes(`<source media="(prefers-color-scheme: dark)" srcset="/assets/brand/used/${dark}">`), Boolean(dark), name)
    // The name is read once: from the site's own type, or from the alt text of a mark that carries words or a trademark sign.
    if (alt) assert.ok(image.includes(` alt="${alt}" `) && alt.startsWith(name === 'NATS' ? 'NATS™' : name), name)
    else assert.ok(image.includes(' alt="" aria-hidden="true" '), name)
    assert.equal(item.includes(`<span${alt ? ' aria-hidden="true"' : ''}>${name}</span>`), !wordmark, name)
    // Unchanged copies: each file's digest is the one recorded beside its source.
    for (const file of dark ? [light, dark] : [light]) {
      assert.equal(createHash('sha256').update(readFileSync(resolve(root, 'assets/brand/used', file))).digest('hex'), digests.get(file), file)
      if (file.endsWith('.svg')) assert.doesNotMatch(read(`assets/brand/used/${file}`), /<script|<foreignObject|<image|href=/i, file)
    }
  })
  assert.equal(digests.size, files.length)
  // The marks keep their own colours: no filter, blend or opacity rule touches them.
  for (const [, rule] of css.matchAll(/\.used[^{]*\{([^}]*)\}/g)) assert.doesNotMatch(rule, /filter|mix-blend|opacity|invert/, rule)
  // The trademark sentence is in the footer's legal line, on every page; a logo comes down the day its owner asks.
  assert.equal(trademarks, 'DeepSeek Harness is a trademark of DeepSeek; NATS™ is a trademark of The Linux Foundation.')
  for (const route of routes) assert.ok(htmlAt(route).includes(`<p class="footer-license">Automagik, Genie and Omni are free and open source (Apache-2.0). Cloud will be a private, paid service; its contracts are public. ${trademarks} <a href="${repo}">Source code `), route)
  assert.match(read('assets/brand/LICENSES.md'), /If a project's owner asks, its logo comes down the same day\./)
  // Still by default: it drifts only for a visitor who allows motion, and stops for the pointer and the keyboard.
  const start = css.indexOf('@media (prefers-reduced-motion:no-preference){')
  assert.ok(css.indexOf('we-use-drift') > start && !css.slice(0, start).includes('.we-use-copy{display:flex}'))
  assert.ok(css.includes('.we-use-copy{display:none}') && css.includes('.we-use-track:hover .we-use-list{animation-play-state:paused}') && css.includes('.we-use-track:not(:focus-within) .we-use-list{'))
  // The pause switch, for a touch screen: one plain checkbox between the row and its credit,
  // no script, hidden unless the row drifts.
  assert.equal(row.split('<label class="we-use-pause"><input type="checkbox">').length - 1, 1)
  assert.match(row, /<\/ul><\/div>\n<label class="we-use-pause"><input type="checkbox">.*?<span class="when-moving">Pause<\/span><span class="when-paused">Paused<\/span><\/label>\n<p class="we-use-note wrap">/)
  assert.ok(!row.includes('<script') && !/\son[a-z]+=/.test(row))
  assert.ok(css.slice(0, start).includes('.we-use-pause{display:none}') && !css.slice(0, start).includes('.we-use-pause{position'))
  assert.ok(css.indexOf('.we-use:has(.we-use-pause input:checked) .we-use-list{animation-play-state:paused}') > start)
})

test('the logo and the icons: the logo kit\'s own files, unchanged, in the header, the footer and the browser tab', async () => {
  const notes = read('assets/brand/LICENSES.md')
  const logo = '<a class="brand" href="/" aria-label="Automagik home"><picture><source media="(prefers-color-scheme: dark)" srcset="/assets/brand/automagik-lockup-three-colours-cream-header.svg"><img src="/assets/brand/automagik-lockup-three-colours-ink-header.svg" width="1632" height="264" alt="Automagik"></picture></a>'
  assert.equal(siteLogo, logo)
  const tabs = '<link rel="icon" href="/favicon.ico" sizes="48x48"><link rel="icon" href="/favicon.svg" type="image/svg+xml"><link rel="apple-touch-icon" href="/apple-touch-icon.png"><link rel="manifest" href="/site.webmanifest">'
  assert.equal(icons, tabs)
  for (const [route, html] of generated) {
    // The logo once in the header and once in the footer; the icons once in the head.
    assert.equal(html.split(logo).length, 3, route)
    assert.equal(html.split('class="brand"').length, 3, route)
    assert.ok(html.slice(0, html.indexOf('<main')).includes(`<div class="wrap top-inner topbar-in">${logo}`), route)
    assert.ok(html.slice(html.indexOf('<footer')).includes(`<div class="footer-brand">${logo}`), route)
    assert.equal(html.slice(0, html.indexOf('</head>')).split(tabs).length, 2, route)
    assert.deepEqual([...html.matchAll(/<link rel="(?:icon|apple-touch-icon|manifest|shortcut icon)"[^>]*>/g)].map(match => match[0]).join(''), tabs, route)
    // The retired logo (gradient capitals, the old clay triskle without its seam line) is in no page.
    assert.doesNotMatch(html, /(?:lockup|wordmark|triskle)\.webp|automagik-wordmark-|\/assets\/art\/mark/, route)
    // The mark alone is the kit's triskle in three colours, the drawing made for the size
    // shown, and it is Automagik's alone (the brand's rule 1): it stands for Automagik's own
    // Cloud, the 32 px drawing beside Cloud in the Products menu of every page and the large
    // one in Cloud's hero, and nowhere else.
    const marks = [...html.matchAll(/<img[^>]*\/triskle-[^>]*>/g)].map(match => match[0])
    assert.equal(marks.length, route === '/cloud/' ? 2 : 1, route)
    for (const image of marks) assert.match(image, /^<img class="(?:menu-art" src="\/assets\/brand\/triskle-three-colours-32\.svg" width="32" height="32" alt="" aria-hidden="true" loading="lazy"|hero-mark" src="\/assets\/brand\/triskle-three-colours\.svg" width="300" height="300" alt="[^"]*"(?: aria-hidden="true")? fetchpriority="high") decoding="async">$/, image)
    const cloud = [...html.matchAll(/<a class="menu-item" href="\/cloud\/"[^>]*>(.*?)<\/a>/g)].map(match => match[1])
    assert.ok(cloud.length >= 1 && cloud.every(entry => entry.startsWith('<span class="menu-icon"><img class="menu-art" src="/assets/brand/triskle-three-colours-32.svg" width="32" height="32" alt="" aria-hidden="true" loading="lazy" decoding="async"></span><span class="menu-text"><strong>Cloud</strong>')), `${route}: beside Cloud in the Products menu stands the triskle`)
    // A menu's picture is a mark's place: no character stands in one (the brand's rule 3).
    for (const [entry] of html.matchAll(/<span class="menu-icon">.*?<\/span><span class="menu-text">/g)) assert.doesNotMatch(entry, /\/assets\/art\/(?!app-icon)|\/assets\/brand\/(?:omni-pleased|lamp)/, `${route}: ${entry.slice(0, 120)}`)
  }
  // The Cloud form's answer pages carry the same logo.
  const answer = await htmlPage('Checked', '<p>Checked.</p>').text()
  assert.ok(answer.includes(`<header class="top"><div class="wrap top-inner">${logo}<a href="/cloud/">Cloud</a></div></header>`))
  // Every file is the kit's, byte for byte: its digest is the one recorded beside its source.
  const kit = ['assets/brand/automagik-lockup-three-colours-ink-header.svg', 'assets/brand/automagik-lockup-three-colours-cream-header.svg', 'assets/brand/automagik-lockup-three-colours-ink.svg', 'assets/brand/automagik-lockup-three-colours-cream.svg', 'assets/brand/triskle-three-colours.svg', 'assets/brand/triskle-three-colours-32.svg', 'favicon.ico', 'favicon.svg', 'apple-touch-icon.png', 'icon-192.png', 'icon-512.png']
  const pinned = new Map([...notes.matchAll(/^\| `([^`]+)` \| `([^`]+)` \| `([0-9a-f]{64})` \|$/gm)].map(match => [match[1], match[3]]))
  // The products' own files are pinned in the second table (their own test reads them).
  assert.deepEqual([...pinned.keys()], [...kit, ...productFiles.map(([file]) => `assets/brand/${file}`)])
  for (const file of kit) assert.equal(createHash('sha256').update(readFileSync(resolve(root, file))).digest('hex'), pinned.get(file), `${file} is not the kit's file`)
  // The lockups: one box for each name's files, the letters' tone in the file's colour, and
  // nothing that could load or run: no script, link, picture or text inside. The wordmark's
  // own drawing is pinned only by the digests above, so a newer kit is a file swap. Only
  // Automagik's lockups carry the triskle: the Genie and Omni lockups that did are retired.
  const lockups = productFiles.filter(([file]) => /-lockup-/.test(file)).map(([file]) => file)
  for (const [name, width] of Object.entries(LOCKUP_BOX)) for (const [tone, colour] of Object.entries(TONES)) for (const size of ['-header', '']) {
    const file = `${name.toLowerCase()}-lockup-three-colours-${tone}${size}.svg`
    const svg = read(`assets/brand/${file}`)
    assert.ok(svg.startsWith(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 -186 ${width} 264" role="img" aria-label="${name}" color="${colour}">`), file)
    assert.doesNotMatch(svg, /<script|<foreignObject|<image|<text|href=|url\((?!#)/i, file)
    lockups.push(file)
  }
  assert.deepEqual(readdirSync(resolve(root, 'assets/brand')).filter(file => /-lockup-/.test(file)).sort(), lockups.sort())
  // The mark alone: one square frame for both drawings, in three colours.
  for (const file of ['triskle-three-colours.svg', 'triskle-three-colours-32.svg']) {
    const svg = read(`assets/brand/${file}`)
    assert.ok(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg" viewBox="72 81 1166 1166" role="img" aria-label="Automagik triskle">'), file)
    assert.doesNotMatch(svg, /<script|<foreignObject|<image|<text|href=|url\((?!#)/i, file)
  }
  // The icons: an .ico of three sizes, a square SVG in the same three colours, and three PNGs.
  const ico = readFileSync(resolve(root, 'favicon.ico'))
  assert.deepEqual([ico.readUInt16LE(0), ico.readUInt16LE(2), ico.readUInt16LE(4), ico[6], ico[22], ico[38]], [0, 1, 3, 16, 32, 48])
  assert.ok(read('favicon.svg').startsWith('<svg xmlns="http://www.w3.org/2000/svg" viewBox="72 81 1166 1166" '))
  assert.doesNotMatch(read('favicon.svg'), /<script|<foreignObject|<image|<text|href=|url\((?!#)/i)
  const png = file => { const bytes = readFileSync(resolve(root, file)); return [bytes.readUInt32BE(16), bytes.readUInt32BE(20)] }
  assert.deepEqual([png('apple-touch-icon.png'), png('icon-192.png'), png('icon-512.png')], [[180, 180], [192, 192], [512, 512]])
  assert.deepEqual(webManifest, { name: 'Automagik', short_name: 'Automagik', icons: [{ src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any maskable' }, { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' }], theme_color: '#3c3049', background_color: '#3c3049', display: 'browser', start_url: '/' })
  assert.deepEqual(JSON.parse(read('site.webmanifest')), webManifest)
  // The files this logo replaced are gone, and nothing the site serves or builds with names them.
  for (const file of ['assets/lockup.webp', 'assets/brand/lockup.webp', 'assets/brand/mark.webp', 'assets/art/mark.webp', 'assets/art/mark-2x.webp', 'assets/brand/wordmark.webp', 'assets/brand/triskle.webp', 'assets/brand/automagik-wordmark-ink.svg', 'assets/brand/automagik-wordmark-cream.svg']) assert.equal(existsSync(resolve(root, file)), false, file)
  for (const file of ['styles.css', 'scripts/build-pages.mjs', 'scripts/build-lockup.mjs', 'scripts/build-art.mjs', 'waitlist/lib/ui.js', 'verify-browser.mjs']) assert.doesNotMatch(read(file), /(?:lockup|wordmark|triskle)\.webp|automagik-wordmark-|art\/mark|'mark'/, file)
  // Sized by the triskle's height (--mark): the file is 264 tall where the triskle is 222,
  // the g's tail hangs under the link's box, and no rule draws on the logo.
  assert.ok(css.includes('.brand{--mark:32px;display:block;flex-shrink:0}\n.brand picture{display:contents}\n.brand:focus-visible{outline-offset:calc(var(--mark)*42/222 + 3px)}\n.brand img{width:auto;max-width:none;height:calc(var(--mark)*264/222);margin-bottom:calc(var(--mark)*-42/222)}\n'))
  // The brand's floor: a lockup is never under 28 px high (its one exception is the family
  // drawer's phone layout, not the header or the footer).
  for (const [rule, mark] of css.matchAll(/[^{}\n]*\.brand\{--mark:(\d+)px/g)) assert.ok(Number(mark) * 264 / 222 >= 28, `The logo is 28 px high or more: ${rule.trim()} makes it ${(mark * 264 / 222).toFixed(1)} px`)
  assert.deepEqual([...css.matchAll(/\n\s*\.brand\{--mark:(\d+)px/g)].map(match => Number(match[1])), [32, 26, 24])
  for (const [rule] of css.matchAll(/[^{}]*\.brand[^{}]*\{[^}]*\}/g)) assert.doesNotMatch(rule, /filter|shadow|stroke|opacity|transform|scale|rotate|animation|transition|background|object-/, rule)
  // The footer's first column is never narrower than its logo.
  const column = Number(css.match(/\.footer-grid\{display:grid;grid-template-columns:minmax\((\d+)px,1\.5fr\)/)[1])
  assert.ok(column >= 40 * 1632.34 / 222 && column < 300, `the footer's first column holds the logo: ${column}`)
})

// THE BRAND'S RULE 10: a product shows as its own mark with its word. Genie's mark is a flat
// lamp, Omni's a tentacle vortex, Mykes's the cords; each is one colour, ink on a light ground
// and cream on a dark one. The triskle is Automagik's alone (rule 1) and a pet is never a mark
// (rule 3), so neither stands beside a product's name.
test('Genie, Omni and Mykes are shown by their own marks: each page\'s heading, the two home cards and the Products menu', () => {
  const NAMES = { genie: 'Genie', omni: 'Omni', mykes: 'Mykes' }
  const image = (slug, tone, size, attrs) => `<img class="product-logo" src="/assets/brand/${PRODUCT_LOCKUPS[slug][0]}-${tone}${size}.svg" width="${Math.round(PRODUCT_LOCKUPS[slug][1].split(' ')[2])}" height="264" alt="${NAMES[slug]}" ${attrs}>`
  const themed = (slug, size, attrs) => `<picture><source media="(prefers-color-scheme: dark)" srcset="/assets/brand/${PRODUCT_LOCKUPS[slug][0]}-cream${size}.svg">${image(slug, 'ink', size, attrs)}</picture>`
  // The heading of each product's page is its lockup, the large drawing: ink on the light
  // page, cream on the dark page. The image's text is the name, so the page's one h1 still
  // reads "Genie", "Omni" or "Mykes". Mykes is not out yet: "Coming soon." stands under it.
  for (const slug of ['genie', 'omni']) assert.ok(generated.get(`/${slug}/`).includes(`<h1>${themed(slug, '', 'fetchpriority="high" decoding="async"')}</h1><p class="intro">`), slug)
  assert.ok(generated.get('/mykes/').includes(`<div class="hero-heading center"><p class="eyebrow">An Automagik building block</p><h1>${themed('mykes', '', 'fetchpriority="high" decoding="async"')}</h1><p class="intro">Coming soon.</p></div>`))
  // The home's two product cards are titled by the lockup. Omni's card follows the theme and
  // shows the drawing for small sizes (at 44 px its large vortex's suckers would be specks);
  // Genie's is dark in both themes, so it is always the cream file. The lamp has one drawing.
  const home = generated.get('/')
  assert.ok(home.includes(`<h3><a href="/omni/">${themed('omni', '-header', 'loading="lazy" decoding="async"')}</a></h3>`))
  assert.ok(home.includes(`<h3><a href="/genie/">${image('genie', 'cream', '', 'loading="lazy" decoding="async"')}</a></h3>`))
  assert.match(css, /\[data-block="genie"\]\{[^}]*background:radial-gradient\([^;}]*var\(--plum-2\),var\(--plum\) 62%\)[^}]*color:var\(--on-plum\)\}/)
  for (const [route, html] of generated) assert.equal(html.split('class="product-logo"').length - 1, { '/': 2, '/genie/': 1, '/omni/': 1, '/mykes/': 1 }[route] ?? 0, route)
  // The Products menu, on every page: beside each of the three stands its own mark alone,
  // the ink file with the cream one for the dark page. Omni's is the drawing for about 32 px.
  for (const [route, html] of generated) {
    for (const slug of ['omni', 'genie', 'mykes']) {
      const [stem, size, , , width, height] = PRODUCT_MARKS[slug]
      const mark = `<span class="menu-icon"><picture><source media="(prefers-color-scheme: dark)" srcset="/assets/brand/${stem}-cream${size}.svg"><img class="menu-art" src="/assets/brand/${stem}-ink${size}.svg" width="${width}" height="${height}" alt="" aria-hidden="true" loading="lazy" decoding="async"></picture></span><span class="menu-text"><strong>${NAMES[slug]}</strong>`
      const entries = [...html.matchAll(new RegExp(`<a class="menu-item" href="/${slug}/"[^>]*>(.*?)</a>`, 'g'))].map(match => match[1])
      assert.ok(entries.length >= 1 && entries.every(entry => entry.startsWith(mark)), `${route}: beside ${NAMES[slug]} in the Products menu stands its own mark`)
      for (const entry of entries) assert.doesNotMatch(entry, /triskle|\/assets\/art\//, `${route}: no triskle and no pet beside ${NAMES[slug]}`)
    }
    // No page shows a retired lockup, and no product's own page shows the triskle in its content.
    assert.doesNotMatch(html, /(?:genie|omni|mykes)-lockup-three-colours/, route)
    if (['/genie/', '/omni/', '/mykes/'].includes(route)) assert.doesNotMatch(html.slice(html.indexOf('<main'), html.indexOf('</main>')), /triskle/, route)
  }
  // Every file is the brand folder's, byte for byte, and its digest is the one in the notes.
  const notes = read('assets/brand/LICENSES.md')
  for (const [file, folder] of productFiles) {
    const bytes = readFileSync(resolve(root, 'assets/brand', file))
    assert.ok(bytes.equals(readFileSync(resolve(root, '../../docs/brand/logo', folder, file))), `${file} equals the brand folder's`)
    assert.ok(notes.includes(`| \`assets/brand/${file}\` | \`docs/brand/logo/${folder}/${file}\` | \`${createHash('sha256').update(bytes).digest('hex')}\` |`), `${file} is pinned in the notes`)
  }
  // Each is flat and one colour (rule 9): the file's tone and nothing else, but the sparkle
  // on the i of genie (pink) and omni (cyan), whose edge is drawn in its own colour; no
  // shading, gradient, mask or blur, no line in another colour, and nothing that could load
  // or run. Frame and label are the brand folder's.
  const SPARKLE = { genie: '#ee5496', omni: '#15bde0', mykes: null }
  const flat = (file, frame, label, slug, lockup) => {
    const svg = read(`assets/brand/${file}`), tone = file.includes('-ink') ? '#3c3049' : '#f3e9dd'
    assert.ok(svg.startsWith(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="${frame}" role="img" aria-label="${label}">`), file)
    const colours = [...new Set([...svg.matchAll(/(?:fill|stroke|color|stop-color)="([^"]+)"/g)].map(match => match[1]))].sort()
    assert.deepEqual(colours, [tone, ...(lockup ? ['currentColor'] : []), ...(lockup && SPARKLE[slug] ? [SPARKLE[slug]] : [])].sort(), `${file}: one colour`)
    assert.doesNotMatch(svg, /<script|<foreignObject|<image|<text|href=|url\(|<mask|<filter|[gG]radient|opacity/i, file)
  }
  for (const [slug, [stem, frame, label, sizes]] of Object.entries(PRODUCT_LOCKUPS)) for (const size of sizes) for (const tone of ['ink', 'cream']) flat(`${stem}-${tone}${size}.svg`, frame, label, slug, true)
  for (const [slug, [stem, size, frame, label]] of Object.entries(PRODUCT_MARKS)) for (const tone of ['ink', 'cream']) flat(`${stem}-${tone}${size}.svg`, frame, label, slug, false)
  // The retired files are gone from the site: the Genie and Omni lockups that carried the triskle.
  for (const file of ['genie-lockup-three-colours-ink.svg', 'genie-lockup-three-colours-cream.svg', 'genie-lockup-three-colours-cream-header.svg', 'omni-lockup-three-colours-ink.svg', 'omni-lockup-three-colours-cream.svg', 'omni-lockup-three-colours-ink-header.svg', 'omni-lockup-three-colours-cream-header.svg']) assert.equal(existsSync(resolve(root, 'assets/brand', file)), false, file)
  for (const file of ['styles.css', 'scripts/build-pages.mjs']) assert.doesNotMatch(read(file), /lockup-three-colours-\$\{|(?:genie|omni)-lockup-three|coming-mark/, file)
  // Sized by height only, a share of the window's width that fits the heading's column for
  // the widest of the three, Genie's (the browser gate measures each), so no file is
  // stretched and the three pages' letters are one size; a centred heading centres it; a
  // menu's mark keeps its shape inside its 32 px box; and none is ever filtered.
  assert.ok(css.includes('h1 .product-logo{display:block;width:auto;height:min(128px,10.4vw);object-fit:contain;object-position:left}\n.center h1 .product-logo{margin-inline:auto;object-position:center}\n'))
  assert.ok(css.includes('@media (max-width:860px){\n  h1 .product-logo{height:min(128px,18.5vw)}\n'))
  assert.ok(css.includes('.product-card h3 .product-logo{display:block;width:auto;height:44px}'))
  assert.ok(css.includes('\n.menu-art{width:32px;height:32px;object-fit:contain}\n'))
  assert.doesNotMatch(css, /(?:product-logo|menu-art)[^{]*\{[^}]*(?:filter|opacity|mix-blend|transform)/)
})

test('derived art: each file is one recorded rectangle of a hashed source, at 1x and 2x', () => {
  const files = readdirSync(resolve(root, 'assets/art')).filter(file => file !== 'manifest.json').sort()
  assert.deepEqual(Object.keys(art.files).sort(), files)
  for (const [file, entry] of Object.entries(art.files)) {
    assert.match(file, /^[a-z0-9-]+\.webp$/)
    assert.equal(createHash('sha256').update(readFileSync(resolve(root, 'assets/art', file))).digest('hex'), entry.sha256, file)
    const source = resolve(root, '../..', entry.source)
    assert.equal(createHash('sha256').update(readFileSync(source)).digest('hex'), entry.sourceSha256, `${file} source changed: rebuild the art`)
    // A crop of a capture comes from the unchanged, provenance-backed file itself.
    if (entry.source.startsWith('apps/landing/assets/screens/')) assert.equal(entry.sourceSha256, manifest.images[entry.source.split('/').pop()], file)
    else assert.ok(/^apps\/(?:desktop|bots-dsh|landing)\/(?:assets|src)\//.test(entry.source), entry.source)
    assert.equal(entry.rect.length, 4)
    // An app capture never sits as a bright box on a dark page: each crop has a twin cut from
    // the dark capture of the same view, with the same rectangle (the pack's share image is
    // dark in both).
    if (entry.source.startsWith('apps/landing/assets/screens/') && !entry.source.endsWith('/code-sidebar.png')) {
      const other = art.files[/-dark(?:-2x)?\.webp$/.test(file) ? file.replace('-dark', '') : file.replace(/(-2x)?\.webp$/, '-dark$1.webp')]
      assert.ok(other, `${file} needs its light or dark twin`)
      assert.deepEqual(other.rect, entry.rect, file)
      const view = source => source.replace(/-(?:light|dark)\.png$/, '.png')
      assert.equal(view(other.source), view(entry.source), file)
      assert.notEqual(other.source, entry.source, file)
    }
    const twin = file.endsWith('-2x.webp') ? file.replace('-2x.webp', '.webp') : file.replace('.webp', '-2x.webp')
    assert.ok(Object.hasOwn(art.files, twin), `${file} needs its ${twin}`)
  }
  for (const [file, entry] of Object.entries(art.files)) {
    if (!file.endsWith('-2x.webp')) assert.ok(art.files[file.replace('.webp', '-2x.webp')].width >= entry.width * 1.5, `${file}: 2x is too small`)
  }
})

test('only Cloud carries the add/removal forms, fields, explicit consent and privacy', () => {
  for (const route of routes) {
    const forms = htmlAt(route).match(/<form\b/g) ?? []
    assert.equal(forms.length, route === '/cloud/' ? 2 : 0, route)
  }
  const html = htmlAt('/cloud/')
  assert.equal((html.match(/method="post" action="\/api\/waitlist"/g) ?? []).length, 2)
  for (const field of ['goal', 'platform', 'apps', 'expected_result', 'channel', 'language', 'email', 'consent']) assert.ok(html.includes(`name="${field}"`), field)
  assert.match(html, /name="goal" required maxlength="1000"/)
  assert.match(html, /name="apps" maxlength="200"/)
  assert.match(html, /name="expected_result" required maxlength="500"/)
  assert.match(html, /type="checkbox" name="consent" value="yes" required/)
  for (const text of ['Namastex Labs', 'European Union', 'Resend', 'WhatsApp/Meta', 'opaque sender ID', 'ANPD', 'six months', 'withdraw consent', 'Remove my details']) assert.ok(html.includes(text), text)
})

test('theme primitives match the app source, with keyboard and motion support', () => {
  assert.equal(theme, themeCss())
  for (const source of [...(theme + css).matchAll(/url\("([^"]+)"\)/g)].map(match => match[1])) local(source)
  assert.match(css, /background:var\(--st-stage\)/)
  assert.match(css, /:focus-visible/)
  assert.match(theme, /prefers-color-scheme:dark/)
  assert.match(css, /prefers-reduced-motion:reduce/)
  assert.doesNotMatch(css, /overflow-x:\s*hidden/)
})

test('the status colours are the brand\'s: the theme takes them from docs/brand, light and dark', () => {
  const brand = JSON.parse(read('../../docs/brand/tokens/tokens.json')).color.tokens
  const generated = themeCss()
  const blocks = { light: generated.match(/^:root\{([^}]*)\}$/m)[1], dark: generated.match(/^@media \(prefers-color-scheme:dark\)\{:root\{([^}]*)\}\}$/m)[1] }
  assert.deepEqual(statusNames, ['st-ok', 'st-okdot', 'st-bad', 'st-warn', 'st-warndot', 'st-work', 'bt-danger', 'bt-green'])
  for (const name of statusNames) for (const theme of ['light', 'dark']) {
    const set = blocks[theme].split(';').map(part => part.trim()).filter(part => part.startsWith(`--${name}:`))
    assert.deepEqual(set, [`--${name}:${brand.find(token => token.name === name).value[theme]}`], `${name}, ${theme}`)
  }
})

test('the title face is the brand\'s: Fredoka from docs/brand, at its three weights only', () => {
  const brand = JSON.parse(read('../../docs/brand/tokens/tokens.json')).type
  // The site serves byte copies of the brand's font and licence, and the font is the recorded build.
  assert.deepEqual(brandFonts.map(file => file.to.pathname.split('/').pop()), ['fredoka-latin.woff2', 'OFL-Fredoka.txt'])
  for (const { from, to } of brandFonts) assert.ok(readFileSync(to).equals(readFileSync(from)), to.pathname.split('/').pop())
  assert.equal(createHash('sha256').update(readFileSync(brandFonts[0].to)).digest('hex'), 'd1ceb16007127919aa1900fb85e4b5d612a4f242404a4068d43f3bc628b2aeca')
  assert.ok(read('../../docs/brand/fonts/README.md').includes('`d1ceb16007127919aa1900fb85e4b5d612a4f242404a4068d43f3bc628b2aeca`'))
  // The theme takes the family, the file, the size adjustment and the weights from the brand's tokens.
  assert.deepEqual({ family: titleFace.family, weight: titleFace.weight, sizeAdjust: titleFace.sizeAdjust }, { family: 'Fredoka', weight: '300 700', sizeAdjust: '105%' })
  assert.deepEqual(brand.weights.map(weight => [weight.name, weight.value]), [['weight-title', 536], ['weight-strong', 469], ['weight-label', 402]])
  assert.ok(theme.includes('@font-face{font-family:Fredoka;font-style:normal;font-weight:300 700;font-display:swap;size-adjust:105%;src:url("assets/brand/fredoka-latin.woff2") format("woff2")}\n'))
  assert.ok(theme.includes(':root{color-scheme:light;--weight-title:536;--weight-strong:469;--weight-label:402;'))
  assert.deepEqual(theme.match(/--bt-head-font:[^;]+;/g), ['--bt-head-font:Fredoka,"DM Sans",ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;'])
  assert.ok(css.includes('--head:var(--bt-head-font);'))
  // Nothing set in the title face carries a weight of its own: a heavier Fredoka is heavier than the logo.
  assert.equal(css.match(/font:[^;}]*var\(--head\)/g).length, 37)
  assert.deepEqual(css.match(/font:[^;}]*var\(--head\)/g).filter(rule => !/^font:var\(--weight-(?:title|strong|label)\) /.test(rule)), [])
  // Each heading's letter spacing is its own brand token's: only the leading zero CSS drops is put back.
  const headings = brand.groups.find(group => group.name === 'Headings').styles
  for (const [tag, style, rule] of [
    ['h1', 'heading-1', 'font-weight:var(--weight-title);font-size:clamp(2.6rem,1.4rem + 4.2vw,4.6rem);line-height:1.02;'],
    ['h2', 'heading-2', 'font-weight:var(--weight-title);font-size:clamp(1.85rem,1.15rem + 2.3vw,3.05rem);line-height:1.08;'],
    ['h3', 'heading-3', 'font-weight:var(--weight-strong);font-size:1.3rem;line-height:1.25;'],
  ]) {
    const start = `${tag}{${rule}letter-spacing:`
    const line = css.split('\n').find(text => text.startsWith(start) && /^[^;}]+\}$/.test(text.slice(start.length)))
    assert.ok(line, `${tag}: the weight, size and line height are not the brand's`)
    const spacing = line.slice(start.length, -1).replace(/^(-?)\./, (_, sign) => `${sign}0.`)
    assert.equal(spacing, headings.find(entry => entry.name === style).letterSpacing, `${tag}: the letter spacing is not ${style}'s`)
  }
  // Fredoka's own word space is wide; the extra word spacing the old face needed is gone.
  assert.doesNotMatch(css, /word-spacing/)
  // Widths counted in the face's own zero: Fredoka's zero is narrower, so the counts grew to keep the same lines.
  for (const rule of ['.home-hero h1{font-size:clamp(1.95rem,.62rem + 5.5vw,5.6rem);max-width:16.5ch;', '.open-line{max-width:26.4ch;', 'bottom:clamp(30px,3.6vw,46px);max-width:27.5ch;']) assert.ok(css.includes(rule), rule)
  // The face it replaced is gone from what the site serves, and every page preloads the new file.
  for (const file of ['assets/brand/manrope-latin.woff2', 'assets/brand/OFL-Manrope.txt']) assert.equal(existsSync(resolve(root, file)), false, file)
  assert.doesNotMatch(theme + css + read('scripts/build-pages.mjs') + read('verify-browser.mjs'), /manrope/i)
  for (const route of routes) {
    const html = htmlAt(route)
    assert.equal(html.split('<link rel="preload" href="/assets/brand/fredoka-latin.woff2" as="font" type="font/woff2" crossorigin>').length, 2, route)
    assert.doesNotMatch(html, /manrope/i, route)
  }
})

test('the title face never ships without its licence, in the brand folder and on the site', () => {
  const places = { 'docs/brand/fonts': resolve(root, '../../docs/brand/fonts'), 'apps/landing/assets/brand': resolve(root, 'assets/brand') }
  for (const [place, folder] of Object.entries(places)) {
    assert.ok(existsSync(resolve(folder, 'fredoka-latin.woff2')), `${place} has no title font`)
    assert.ok(existsSync(resolve(folder, titleFace.license)), `${place} ships the title font without its licence, ${titleFace.license}`)
    const licence = readFileSync(resolve(folder, titleFace.license))
    assert.equal(createHash('sha256').update(licence).digest('hex'), '5c9e7eee5c6b25f4b05b8d53b2e470ea4962f9ced742d044a98f7d95d1375bab', `${place}: the licence text changed`)
    assert.match(licence.toString(), /^Copyright 2016 The Fredoka Project Authors/)
    assert.match(licence.toString(), /SIL OPEN FONT LICENSE Version 1\.1 - 26 February 2007/)
  }
  assert.equal(titleFace.license, 'OFL-Fredoka.txt')
  assert.ok(read('assets/brand/LICENSES.md').includes('SIL Open Font License 1.1, in `OFL-Fredoka.txt`'))
  assert.ok(read('../../docs/brand/fonts/README.md').includes('OFL-Fredoka.txt'))
})

test('motion: only for visitors who allow it, only transform and opacity, and never Arca\'s logo', () => {
  // Scroll-driven motion, page transitions and the entrances all sit inside the one
  // no-preference block; a visitor who asks for reduced motion gets none of it.
  const start = css.indexOf('@media (prefers-reduced-motion:no-preference){'), end = css.indexOf('@keyframes page-out')
  assert.ok(start > 0 && end > start)
  const outside = css.slice(0, start) + css.slice(end)
  assert.doesNotMatch(outside, /animation-timeline|view-timeline|@view-transition|@starting-style|view-transition-name/)
  const motion = css.slice(start, end)
  for (const feature of ['@view-transition{navigation:auto}', '@supports (animation-timeline:view())', 'animation-timeline:view()', 'animation-timeline:scroll(root)', '@starting-style']) assert.ok(motion.includes(feature), feature)
  assert.match(css, /@media \(prefers-reduced-motion:reduce\)\{html\{scroll-behavior:auto\}\*,\*::before,\*::after\{animation:none!important;transition:none!important\}\}/)
  // Nothing that moves can shift the layout: keyframes and transitions touch only these.
  const still = new Set(['opacity', 'translate', 'scale', 'rotate', 'transform'])
  const frames = [...css.matchAll(/@keyframes ([\w-]+)\{((?:[^{}]*\{[^{}]*\})+)\}/g)]
  assert.ok(frames.length >= 15)
  for (const [, name, body] of frames) for (const [, property] of body.matchAll(/[{;]\s*([a-z-]+):/g)) assert.ok(still.has(property), `@keyframes ${name} animates ${property}`)
  for (const [, list] of css.matchAll(/transition:([^;}]+)/g)) {
    for (const part of list.replace(/\([^)]*\)/g, '').split(',')) assert.match(part.trim(), /^(?:opacity|translate|scale|rotate|transform|box-shadow|border-color|background|color|none)\b/, `transition: ${part}`)
  }
  // Arca's rule: its logo is never animated here. No motion rule names it.
  assert.ok(motion.includes('.hero-heading>*{animation:'))
  assert.doesNotMatch(motion, /arca/)
})

test('all landing files pass privacy; no tracking or preview URL is committed', () => {
  const walk = folder => {
    for (const entry of readdirSync(resolve(root, folder), { withFileTypes: true })) {
      const path = `${folder}${folder ? '/' : ''}${entry.name}`
      if (entry.isDirectory()) walk(path)
      else assert.deepEqual(scan(`apps/landing/${path}`, fileText(readFileSync(resolve(root, path))), privacy), [], path)
    }
  }
  walk('')
  for (const html of generated.values()) assert.doesNotMatch(html, /(?:gtag|googletagmanager|google-analytics|plausible\.io)/i)
  // The site's own headers never keep a crawler out; previews get Cloudflare Pages' own header.
  assert.equal(read('_headers'), '/*\n  X-Content-Type-Options: nosniff\n  Referrer-Policy: no-referrer\n')
})


test('Arca\'s page is Arca\'s own: Pages carries no /arca page and nothing under it, and the site links to its same-tab address', () => {
  // NO PAGE HERE. Arca's Worker serves automagik.si/arca and everything under it (RFC 0027),
  // and this site's deploy uploads its folder as it is: a file at arca/ would be published
  // beside Arca's page. So there is no arca folder, no /arca route and no built page.
  assert.equal(existsSync(resolve(root, 'arca')), false, 'this site carries no file at /arca/')
  assert.deepEqual(routes.filter(route => route.startsWith('/arca')), [])
  assert.deepEqual([...generated.keys()].filter(route => route.startsWith('/arca')), [])
  assert.doesNotMatch(read('scripts/build-pages.mjs'), /arcaPage|install-line|get\.automagik\.si/)
  assert.doesNotMatch(read('styles.css'), /install-line|arca-logo/)
  assert.match(arcaLogo, / role="img" aria-label="arca">/)
  // The owner's own line, exactly, wherever Arca is described: the home block, the drawer's
  // row and the Products menu on every page.
  assert.deepEqual(arca, { line: 'Be your own cloud. Infrastructure for AI agents.' })
  for (const [route, html] of generated) {
    const said = [...html.matchAll(/<strong>Arca<\/strong><span>([^<]*)<\/span>/g)].map(match => match[1])
    assert.deepEqual(said, [arca.line], `${route}: the menu says Arca's line`)
  }
  // THE SITE LINKS TO IT, in the same tab, by the one address: the Products menu, the
  // drawer's row and the footer on every page, and the home card. The product pages' way to
  // the next or the earlier product does not: it passes Arca by. Nothing links to a place
  // under it, to the installer or to Arca's repository.
  for (const [route, html] of generated) {
    const links = [...html.matchAll(/<a\b[^>]*href="(\/arca[^"]*)"[^>]*>/g)]
    for (const [link, href] of links) { assert.equal(href, arcaPath, route); assert.doesNotMatch(link, /target=|aria-current/, route) }
    const footer = html.slice(html.indexOf('<footer'), html.indexOf('</footer>'))
    assert.match(html, /<a class="menu-item" href="\/arca\/"/, `${route}: the Products menu links to Arca's page`)
    assert.match(html, /<a class="fam-item is-logo" href="\/arca\/"/, `${route}: the drawer's row links to Arca's page`)
    assert.ok(footer.includes('<a href="/arca/">Arca</a>'), `${route}: the footer links to Arca's page`)
    // Three links a page (the menu, the drawer, the footer) and the home card: the pager on
    // Cloud's and Mykes's pages is not one of them, it passes Arca by.
    assert.equal(links.length, 3 + (route === '/' ? 1 : 0), `${route}: ${links.map(([, href]) => href)}`)
    assert.doesNotMatch(html, /href="[^"]*(?:get\.automagik\.si|automagik-si\/arca)/, `${route}: neither the installer nor Arca's repository is a link`)
  }
  const card = htmlAt('/').match(/<article class="product-card" data-block="arca">[\s\S]*?<\/article>/)?.[0]
  assert.ok(card?.includes(`<h3><a href="/arca/">Arca</a></h3><p>${arca.line}</p><span class="detail-link" aria-hidden="true">Get Arca →</span>`))
  // The card says only Arca's name and the owner's line: no tag of guessed wording.
  assert.doesNotMatch(card, /tile-tag/)
  // Beside the name "Arca" stands the ark alone, the package's file as it is (the test of the
  // ark, below, holds its bytes and that no arch is left): once in the Products menu on
  // every page, once more on the home card, and nowhere else. Never another product's mark
  // beside Arca, and never the Open Intelligence tag.
  for (const [route, html] of generated) {
    assert.equal(html.split(arcaArk).length - 1, route === '/' ? 2 : 1, route)
    assert.equal((html.match(/class="arca-ark"/g) ?? []).length, route === '/' ? 2 : 1, route)
    for (const [item] of html.matchAll(/<a class="menu-item" href="\/arca\/"[\s\S]*?<\/a>/g)) assert.doesNotMatch(item, /<img[^>]*\/assets\/(?:art|brand\/(?:mark|lockup))/, route)
    assert.doesNotMatch(html.slice(html.indexOf('<div class="footer-end">'), html.indexOf('</footer>')), /arca-ark|<img/, route)
  }
  for (const html of generated.values()) for (const [link] of html.matchAll(/<a\b[^>]*href="\/arca\/"[^>]*>/g)) assert.doesNotMatch(link, /target=/)
  // The root sitemap lists Arca only through Arca's own supplied line.
  assert.equal(read('sitemap.xml').split('https://automagik.si/arca/</loc>').length, 2)
})

test('we unfold and Open Intelligence: the approved wording, from one constant, on every page', () => {
  assert.equal(weUnfold.url, 'https://weunfold.ai/')
  assert.equal(weUnfold.partOf, 'Automagik is part of we unfold, the home of the Open Intelligence movement.')
  assert.equal(weUnfold.openIntelligence, 'Open Intelligence: a future more people can understand, question, and shape.')
  for (const [route, html] of generated) {
    // The tag's own words are capitals inside the tag; the wording rules are for sentences.
    const text = plain(html.replace(oiTag, ''))
    // The part-of line stays in the footer and in the Company menu, never beside the tag.
    const footer = html.slice(html.indexOf('<footer'))
    assert.ok(plain(footer.slice(0, footer.indexOf('<div class="footer-end">'))).includes(weUnfold.partOf), route)
    assert.ok(plain(html.match(/id="menu-company"[\s\S]*?<\/div><\/div>/)[0]).includes(weUnfold.partOf), route)
    assert.ok(html.includes(`<a href="${weUnfold.url}">we unfold</a>`), route)
    // Open Intelligence keeps both capitals and is never shortened; we unfold is lower case
    // in running text and one word only in its address; it is a movement, not an owner.
    for (const [found] of text.matchAll(/open intelligence/gi)) assert.equal(found, 'Open Intelligence', route)
    for (const [found] of html.matchAll(/we ?unfold/gi)) assert.ok(found === 'we unfold' || found === 'weunfold', `${route}: ${found}`)
    assert.equal(html.split('weunfold').length, html.split(/https:\/\/weunfold\.ai[\/"]/).length, route)
    assert.doesNotMatch(text, /\bby we unfold\b|\bwe unfold (?:product|company)\b|\bOI\b/i, route)
    assert.doesNotMatch(html, /<img[^>]*unfold/i, route)
  }
  const home = plain(htmlAt('/').match(/<main[\s\S]*<\/main>/)[0])
  assert.ok(home.includes(weUnfold.openIntelligence) && home.includes(weUnfold.partOf))
})

test('Open Intelligence is applied as on Arca\'s site: the horizontal tag in the footer, and the official lockup', () => {
  // The tag is we unfold's file, pasted as given: one colour (the text colour around it), its
  // own words, no round seal anywhere. A new tag file is a reviewed change here.
  assert.equal(oiTag, read('assets/brand/open-intelligence/open-intelligence-tag.svg').trim())
  assert.equal(createHash('sha256').update(readFileSync(resolve(root, 'assets/brand/open-intelligence/open-intelligence-tag.svg'))).digest('hex'), '5fc165fb016108292d99eb21bc3ba7f3fcd8a1cb6d96ce14501c3a26c332666c')
  assert.match(oiTag, /^<svg id="oi-badge-ink-kit" xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="0 0 340 64" width="340" height="64" role="img" aria-label="Open Intelligence badge, one colour">/)
  assert.match(oiTag, /<text x="68" y="39" font-family="IBM Plex Mono, monospace" font-size="18" font-weight="600" letter-spacing="3\.2" fill="currentColor">OPEN INTELLIGENCE<\/text><\/svg>$/)
  assert.deepEqual([...new Set([...oiTag.matchAll(/(?:fill|stroke)="([^"]+)"/g)].map(match => match[1]))].sort(), ['currentColor', 'none'])
  assert.deepEqual(readdirSync(resolve(root, 'assets/brand/open-intelligence')), ['open-intelligence-tag.svg'])
  for (const [route, html] of generated) {
    // Footer: the last row ends with the tag, a link to we unfold that holds nothing but the
    // tag. No words in the link, no sentence about it, no seal, and the tag nowhere else.
    assert.ok(html.includes(`<span aria-hidden="true">↗</span></a></p><a class="oi-tag" href="${weUnfold.url}">${oiTag}</a></div></div></footer>`), route)
    assert.match(html, /<div class="footer-end"><p class="footer-license">[^<]*Apache-2\.0[^<]*<a href="https:\/\/github\.com\/automagik-si\/automagik">Source code /, route)
    assert.equal(html.split(oiTag).length, 2, route)
    assert.equal(html.split('OPEN INTELLIGENCE').length, 2, route)
    assert.doesNotMatch(html, /Support Open Intelligence|Open Intelligence seal|site-seal|footer-open|class="stamp|seal-ring/, route)
    // The official lockup is shown once, on the home page's brand block: never in a header,
    // a hero, the favicon or a share picture.
    assert.equal(html.split('automagik-lockup-oi').length, route === '/' ? 7 : 1, route)
    assert.doesNotMatch(html.slice(0, html.indexOf('<main')), /lockup-oi|oi-tag|oi-badge/, route)
    assert.doesNotMatch(html, /<meta[^>]*(?:og:image|twitter:image)/, route)
  }
  const block = htmlAt('/').match(/<section id="brand" class="wrap kit"[\s\S]*?<\/section>/)[0]
  assert.ok(block.includes('<picture><source media="(prefers-color-scheme: dark)" srcset="/assets/brand/automagik/automagik-lockup-oi-cream.svg"><img src="/assets/brand/automagik/automagik-lockup-oi-ink.svg" width="1628" height="529" alt="The Automagik logo, with the Open Intelligence tag under it at the right" loading="lazy" decoding="async"></picture>'))
  assert.deepEqual([...block.matchAll(/href="([^"]+)" download/g)].map(match => match[1]), ['ink.svg', 'ink.png', 'cream.svg', 'cream.png'].map(name => `/assets/brand/automagik/automagik-lockup-oi-${name}`))
  assert.ok(htmlAt('/').indexOf('<section id="brand"') > htmlAt('/').indexOf('<section id="film"'))
  // Size and colour, as Arca's footer: 170 by 32 px in the footer's text colour, never an
  // effect on it, and never bigger than the logo it sits with: the footer's word alone (its
  // letters are 1325 wide when the triskle is 222 tall) passes 170 px at every width.
  assert.match(css, /\.oi-tag,\.oi-tag:hover\{flex:none;display:block;border-radius:16px;color:var\(--text\)\}\n\.oi-tag svg\{width:170px;height:32px;max-width:none\}/)
  for (const [rule] of css.matchAll(/[^{}]*oi-tag[^{}]*\{[^}]*\}/g)) assert.doesNotMatch(rule, /filter|shadow|stroke|outline|opacity|transform|scale|rotate|animation|transition|background/, rule)
  const footerMarks = [...css.matchAll(/\.footer-brand \.brand\{--mark:(\d+)px[;}]/g)].map(match => Number(match[1]))
  assert.deepEqual(footerMarks, [40, 34], 'the footer logo: one size, and one for phones')
  for (const mark of footerMarks) assert.ok(mark * 1325 / 222 >= 170, 'the footer logo\'s word is at least as wide as the tag')
  assert.match(css, /@media \(max-width:700px\)\{\.footer-end\{flex-direction:column;align-items:flex-start\}\}/)
  assert.match(css, /@font-face\{font-family:"IBM Plex Mono";font-style:normal;font-weight:600;font-display:block;src:url\("assets\/brand\/ibm-plex-mono-latin-600\.woff2"\) format\("woff2"\)\}/)
  // The lockup files: the kit's large lockup, set inside unchanged, with the tag under it,
  // right edges together, the tag 170/275 of the logo's width (Arca's proportion), one tone
  // per ground. The logo ends where its letters end: at the k, and under the g's tail.
  assert.deepEqual(readdirSync(resolve(root, 'assets/brand/automagik')).sort(), ['automagik-lockup-oi-cream.png', 'automagik-lockup-oi-cream.svg', 'automagik-lockup-oi-ink.png', 'automagik-lockup-oi-ink.svg'])
  assert.ok(Math.abs(GEOMETRY.scale * 340 / LOGO.width - 170 / 275) < 1e-9 && Math.abs(GEOMETRY.x + 340 * GEOMETRY.scale - LOGO.width) < 1e-9 && GEOMETRY.y > LOGO.height)
  assert.deepEqual([TONES, BOX, LOGO], [{ ink: '#3c3049', cream: '#f3e9dd' }, { x: 0, y: -186, width: 1632.34, height: 264 }, { width: 321.34 + 1307, height: 186 + 76 }])
  const font = readFileSync(resolve(root, 'assets/brand/ibm-plex-mono-latin-600.woff2')).toString('base64')
  const size = png => [png.readUInt32BE(16), png.readUInt32BE(20), png[25]]
  for (const [tone, colour] of Object.entries(TONES)) {
    const svg = read(`assets/brand/automagik/automagik-lockup-oi-${tone}.svg`), kit = read(`assets/brand/automagik-lockup-three-colours-${tone}.svg`)
    assert.equal(kit, `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 -186 1632.34 264" role="img" aria-label="Automagik" color="${colour}">${logoInner(tone)}</svg>\n`, tone)
    assert.equal(svg, `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1628.34 529.22" width="1628.34" height="529.22" color="${colour}" role="img" aria-label="Automagik, with the Open Intelligence tag"><style>@font-face{font-family:"IBM Plex Mono";font-weight:600;src:url(data:font/woff2;base64,${font}) format("woff2")}</style><svg width="1632.34" height="264" viewBox="0 -186 1632.34 264">${logoInner(tone)}</svg><g transform="translate(621.73 339.74) scale(2.96062)">${tagInner()}</g></svg>\n`, tone)
    assert.doesNotMatch(svg, /<image|<script|<foreignObject/, tone)
    assert.deepEqual(size(readFileSync(resolve(root, `assets/brand/automagik/automagik-lockup-oi-${tone}.png`))), [3000, 976, 6], tone)
  }
  assert.equal(oiTag, oiTag.replace(/^(<svg\b[^>]*>)[\s\S]*(<\/svg>)$/, `$1${tagInner()}$2`))
  // Arca's own lockup is not cleared for a public repository: it is never among these files.
  const walk = folder => readdirSync(folder, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? walk(resolve(folder, entry.name)) : [entry.name])
  assert.deepEqual(walk(root).filter(name => /arca-lockup/i.test(name)), [])
})

// THE FAMILY DRAWER: the menu the product family shares, from Arca's drawer package, issue
// 12 (issue 11 as the owner approved it on 2026-11-12, with the case where the host is
// Automagik and two faults fixed, and no change to how it looks): Automagik's lockup; omni, genie and mykes as
// words in the lettering with no mark; "Coming soon." under Mykes; no pet, no Genie head, and
// the triskle beside nothing but Automagik. The package's own checksums, for the files taken:
const familyFiles = {
  'family.html': '5941c2d0abcddc4956d1183aeac2d65d3f8de059c0377a2310423fbbb139b6b7',
  'header-button.html': '3d502e338a526ce541f3cef809cd0f33d233f660897294bab9c670260ae9eefe',
  'family.css': '12c60e79838cda45b0f5c36f87b2b936de46f4c4291c48f41ad058a1562d33e2',
  'family.js': 'a24cd31a4a967980e0d3dddafd4b7f46d5e95788f45541a67d22637ee1f287ec',
  'automagik-lockup-three-colours-cream-48.png': '5518af46313bc1678c77f382b85476638fe15dd99e4dbf275e6e21403bc36b37',
  'automagik-lockup-three-colours-cream-64.png': 'f4a31554d492a201bd123ad149930b24a3a2f4ccb5ba514d522a652d048d26ef',
  'automagik-lockup-three-colours-cream-128.png': 'f1113affc7f486217330d7ebc4fbce0c9538d63f84ddea88c40680ec79a87e9a',
  'automagik-lockup-three-colours-ink-48.png': 'b7f32743404095a1b50e56539dd08be79564db5ace2342a0e2f9375e8162ceaa',
  'automagik-lockup-three-colours-ink-64.png': '4a4313b88432dc3187c86cb6b64fe00ebd565a172b243b83fd5fa3a4bf337b19',
  'automagik-lockup-three-colours-ink-128.png': '89a274a63cf3812a4ff2ecf832204e33236444118c06ece93d5766b58d595380',
  'omni-wordmark-cream.svg': 'e930250e3797750d6ad118b8a5f7639e2604db3a78d68645666177f69191b5d2',
  'omni-wordmark-ink.svg': 'e8c21842b9c280fddacfbf20e8ce998a1ea4be5069b47a43002ebf7db40e8e37',
  'genie-wordmark-cream.svg': '4bf79674edd489de7172b76b48d64982cbd973e56679a9575d560044b9b8a317',
  'genie-wordmark-ink.svg': '481008dcd0b1281308e22474cebef71a20f78b247e51095896bebec9561d647d',
  'mykes-wordmark-cream.svg': '9099d9566ebee75e3cc683987f5b69bfc8c1c41873871f5415654a1efbc12752',
  'mykes-wordmark-ink.svg': '28c80ac26bea923146094869fafe032a9397d85c4fd0ad6432a885ceb24219dc',
  'arca-logo-b.svg': 'ea2cfc8b60be3fe0b064e11b6238b290a1545a654e8fe44a190ebc0a623db116',
  'arca-ark-icon.svg': '165f7bbb1bf0d3ac6a079c2f2b547564f31c5f13dedd275c63816af9fd33ff87',
}
const digest = path => createHash('sha256').update(readFileSync(resolve(root, path))).digest('hex')
const uncommented = html => html.replace(/<!--[\s\S]*?-->\n?/g, '').trim()

test('the family drawer: the piece and its art are byte copies of the package, and the words are the brand folder\'s', () => {
  // The folder holds the taken files and their note, and nothing else.
  assert.deepEqual(readdirSync(resolve(root, 'assets/family')).sort(), [...Object.keys(familyFiles), 'SOURCE.md'].sort())
  for (const [file, sum] of Object.entries(familyFiles)) assert.equal(digest(`assets/family/${file}`), sum, `${file} is not the package's file`)
  // The note names the issue, the package's own checksum list and every file's digest.
  const note = read('assets/family/SOURCE.md')
  assert.match(note, /\*\*the menu drawer and its button,\nissue 12\*\*/)
  assert.ok(note.includes('`06741c53a17ee6e3125d6d5eb83bff98f5c6b5c30689cb68649a581dfa08a06f`'))
  const listed = Object.fromEntries([...note.matchAll(/^\| `([^`]+)` \| `(?:piece|art)\/[^`]+` \| `([0-9a-f]{64})` \|$/gm)].map(([, file, sum]) => [file, sum]))
  assert.deepEqual(listed, familyFiles)
  // The three words are the brand folder's files: Omni's and Genie's were there, and the
  // Mykes word, which came from we unfold through the package, is carried there too.
  for (const name of ['omni', 'genie', 'mykes']) for (const tone of ['ink', 'cream']) {
    const file = `${name}-wordmark-${tone}.svg`
    assert.ok(readFileSync(resolve(root, 'assets/family', file)).equals(readFileSync(resolve(root, '../../docs/brand/logo/wordmark', file))), `${file} equals the brand folder's`)
    // A word is letters and a sparkle, nothing that could load or run.
    assert.doesNotMatch(read(`assets/family/${file}`), /<script|<foreignObject|<image|<text|href=|url\(/i, file)
    assert.match(read(`assets/family/${file}`), new RegExp(`color="${tone === 'ink' ? '#3c3049' : '#f3e9dd'}"`), `${file} has ${tone} letters`)
  }
  // Arca's logo is the package's file: shapes and letters in the text colour, nothing that
  // could load or run. The builder writes it into the page as it is.
  const ark = read('assets/family/arca-logo-b.svg')
  assert.match(ark, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="0 0 2041\.97 488\.4" fill="currentColor" role="img" aria-label="arca">(?:<path d="[^"]+"\/>)+<\/svg>\n$/)
  // The ark alone came after issue 11c, in that package's art/ark-icon folder, which has a
  // checksum list of its own (issue 12 does not carry the folder): the note names that list.
  assert.ok(note.includes('`fcb0b261ca11121c97265d779b286517d38e19fc28bbf607ae2607eb67e2923d`'))
  assert.match(read('assets/family/arca-ark-icon.svg'), /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="0 0 710\.4 488\.4" fill="currentColor" role="img" aria-label="arca">(?:<path d="[^"]+"\/>){3}<\/svg>\n$/)
  // Every picture in the folder is one the drawer shows, or Arca's ark for the site's own
  // places (the Products menu and the home card), and the drawer shows no other.
  assert.deepEqual([...Object.values(familyArt), 'arca-logo-b.svg', 'arca-ark-icon.svg'].sort(), Object.keys(familyFiles).filter(file => /\.(?:png|svg)$/.test(file)).sort())
})

test('the family drawer on every page: the piece\'s markup with Automagik in the top block, three words and no mark beside them', () => {
  // Arca's row, written here from the piece's own Arca item (its top block's link): a logo
  // row without "You are here", holding the package's logo file.
  const arcaRow = `<a class="fam-item is-logo" href="/arca/" data-family-product="Arca" data-family-line="${arca.line}"><span class="fam-words"><span class="fam-logo">${read('assets/family/arca-logo-b.svg').trim()}</span><span>${arca.line}</span></span></a>`
  const piece = uncommented(read('assets/family/family.html')), pieceButton = uncommented(read('assets/family/header-button.html')).split('\n')[0]
  const slots = Object.fromEntries(Object.entries(familyArt).map(([slot, file]) => [`/assets/family/${file}`, slot]))
  // The button is the piece's own; only its script-off address is this site's.
  assert.equal(familyButton.replace('href="#sitemap"', 'href="https://automagik.si/"'), pieceButton)
  assert.equal(pieceButton, '<a class="fam-btn" href="https://automagik.si/" data-family-open aria-label="Menu"><span class="fam-lines" aria-hidden="true"><span></span><span></span><span></span></span></a>')
  for (const [route, html] of generated) {
    const drawer = family(route)
    // Where it stands: the page is wrapped whole, header and footer included; the drawer and
    // its layers come after the wrapper; the script is the last thing in the body.
    assert.ok(html.includes('<body><div class="page" data-family-page><a class="skip" href="#main">Skip to content</a><header class="top topbar">'), route)
    assert.ok(html.includes(`<header class="top topbar">${familyButton}<div class="wrap top-inner topbar-in">`), `${route}: the button is the header's first child, outside the column`)
    assert.equal(html.split('data-family-open').length, 2, route)
    assert.ok(html.includes('</footer></div>') && html.indexOf('</footer></div>') < html.indexOf(drawer), route)
    // The wrapper holds the whole page: no stray closing tag inside it shuts it early (one
    // did, on the home page, and everything under the hero stood outside the wrapper, in
    // reach behind the open drawer). Its one closing tag is the one after the footer.
    const wrapped = html.slice(html.indexOf('<div class="page" data-family-page>'), html.indexOf('</footer></div>') + '</footer></div>'.length)
    let depth = 0
    const shut = [...wrapped.matchAll(/<(\/?)div\b[^>]*>/g)].filter(([, closing]) => (depth += closing ? -1 : 1) === 0)
    assert.ok(shut.length === 1 && shut[0].index === wrapped.length - '</div>'.length && depth === 0, `${route}: the page wrapper closes after the footer and nowhere else`)
    for (const part of ['<main id="main">', '</main>', '<footer class="site-footer">']) assert.ok(wrapped.includes(part), `${route} ${part}`)
    assert.ok(html.endsWith(`\n${drawer}\n${familyScript}</body></html>\n`), route)
    assert.equal(html.split('data-family-drawer').length, 2, route)
    // The piece's stylesheet loads before the site's, which holds the host's side.
    assert.ok(html.includes('<link rel="stylesheet" href="/theme.css"><link rel="stylesheet" href="/assets/family/family.css"><link rel="stylesheet" href="/styles.css"></head>'), route)
    // With script off the button leads to the footer's sitemap, which every page has.
    assert.ok(html.includes('<div id="sitemap" class="wrap footer-grid">'), route)
    // The site sets no theme attribute: the visitor's system picks, in the drawer too.
    assert.doesNotMatch(html, /data-theme=|data-family-stay/, route)

    // AS GIVEN: undo this site's own parts, one by one, and what is left is the piece's file.
    let back = drawer
    const undo = (from, to, times = 1) => { assert.equal(back.split(from).length - 1, times, `${route}: ${from}`); back = back.replaceAll(from, to) }
    // 1. The mark on the page being read.
    if (!['/', '/cloud/'].includes(route)) undo(`href="${route}" aria-current="page" data-family-product=`, `href="${route}" data-family-product=`)
    // 2. The list under the top block: this site's pages, where the piece has Arca's sections.
    const links = familyLinks.map(([href, name]) => { const [path, place] = href.split('#'); return `<li><a href="${place && path === route ? `#${place}` : href}"${href === route ? ' aria-current="page"' : ''}>${name}</a></li>` }).join('')
    undo(`<ul class="fam-links" data-family-links aria-label="Sections">${links}</ul>`, piece.match(/<ul class="fam-links" data-family-links aria-label="Sections">.*?<\/ul>/)[0])
    // 3. The pictures: each address back to its slot.
    for (const [file, slot] of Object.entries(slots)) back = back.replaceAll(file, slot)
    // 4. Arca's row leaves Products: it is the piece's own Arca item, which goes back to the top block below.
    undo(`<ul class="fam-list">\n    <li>${arcaRow}</li>\n`, '<ul class="fam-list">\n')
    // 5. The top block: Automagik, its lockup (the piece's own lockup markup, named) and its line.
    const lockup = piece.match(/<span class="fam-lockup"><picture class="fam-lock-cream">.*?<\/picture><picture class="fam-lock-ink">.*?<\/picture><\/span>/)[0]
    undo(`<span class="fam-logo">${lockup.replaceAll('alt=""', 'alt="Automagik"')}</span>`, '<span class="fam-logo">__FAM_ARCA__</span>')
    undo(`<a class="fam-item is-here" href="/" data-family-product="Automagik" data-family-line="${familyHost.line}" aria-current="${route === '/' ? 'page' : 'true'}">`, `<a class="fam-item is-here" href="https://automagik.si/arca/" data-family-product="Arca" data-family-line="${arca.line}" aria-current="page">`)
    undo(`</span><span>${familyHost.line}</span></span><span class="fam-here">`, `</span><span>${arca.line}</span></span><span class="fam-here">`)
    // 6. Addresses: this site's own pages are written from its root.
    undo('href="/', 'href="https://automagik.si/', 5)
    // 7. The host is Automagik: Desktop and Mobile go back from the top block to the
    // Automagik row, and the row itself (the piece's own lines) goes back in.
    const apps = piece.match(/<span class="fam-apps" role="group" aria-label="The Automagik app">.*?<\/span>/)[0]
    const row = piece.match(/\n  <div class="fam-top">\n    <a class="fam-home" .*<\/a>\n    .*\n  <\/div>/)[0]
    assert.ok(row.endsWith(`\n    ${apps}\n  </div>`))
    undo(`</a>\n    ${apps}\n    <ul class="fam-links"`, '</a>\n    <ul class="fam-links"')
    undo('\n  </div>\n  <span class="eyebrow">Products</span>', `\n  </div>${row}\n  <span class="eyebrow">Products</span>`)
    assert.equal(back, piece, `${route}: the drawer is the piece's markup`)

    // WHAT IT SHOWS, said outright so a later issue of the piece cannot change it unseen.
    const rows = [...drawer.matchAll(/data-family-product="([^"]+)" data-family-line="([^"]*)"/g)].map(([, name, line]) => [name, line])
    assert.deepEqual(rows, [['Automagik', 'Open building blocks of superintelligence.'], ['Desktop', 'Your agent team, in your chats.'], ['Mobile', 'Your agents on your Android phone.'], ['Arca', 'Be your own cloud. Infrastructure for AI agents.'], ['Omni', 'Your chat apps, connected.'], ['Genie', 'A wish, a branch, a report.'], ['Mykes', 'Coming soon.']], route)
    // Each product's line is the one the site's own menu gives it.
    for (const [name, line] of rows.slice(1)) assert.ok(html.includes(`<strong>${name}</strong><span>${line}</span>`), `${route} ${name}`)
    assert.ok(html.slice(html.indexOf('<footer')).includes(`<p>${familyHost.line}</p>`), route)
    // Omni, Genie and Mykes: the word alone, cream and ink, then the line. "Coming soon." under Mykes.
    const list = drawer.match(/<ul class="fam-list">([\s\S]*?)<\/ul>/)[1].trim().split('\n').map(row => row.trim())
    // (Each word picture has the size of its drawing, so the row keeps its place while it loads.)
    const wordSize = ['width="617" height="264"', 'width="677" height="264"', 'width="793" height="257"']
    assert.deepEqual(list.slice(1), [['omni', 'Omni', 'Your chat apps, connected.', ''], ['genie', 'Genie', 'A wish, a branch, a report.', ''], ['mykes', 'Mykes', 'Coming soon.', ' is-mykes']].map(([file, name, line, own], at) =>
      `<li><a class="fam-item is-word" href="/${file}/"${route === `/${file}/` ? ' aria-current="page"' : ''} data-family-product="${name}" data-family-line="${line}"><span class="fam-words"><span class="fam-lockup fam-word${own}"><img class="fam-lock-cream" data-src="/assets/family/${file}-wordmark-cream.svg" alt="${name}" ${wordSize[at]} decoding="async"><img class="fam-lock-ink" data-src="/assets/family/${file}-wordmark-ink.svg" alt="${name}" ${wordSize[at]} decoding="async"></span><span>${line}</span></span></a></li>`), route)
    // No pet, no Genie head, no mark beside a product: the only pictures are Automagik's
    // lockup and the three words, and nothing comes from the site's art or logo folders.
    // A CLOSED DRAWER FETCHES NOTHING (issue 12): every one of its pictures carries its
    // address in data-src or data-srcset, where the browser does not read it, and the piece's
    // script gives a picture its address when it is shown. None is among the page's requests.
    const pictures = [...drawer.matchAll(/ data-(?:src|srcset)="([^"]+)"/g)].map(match => match[1])
    assert.deepEqual(drawer.match(/ (?:src|srcset)="[^"]*"/g), null, `${route}: no drawer picture is among the page's own requests`)
    assert.equal(drawer.split(/<(?:img|source)\b/).length - 1, 12, route)
    assert.doesNotMatch(drawer, /loading="lazy"/, route)
    assert.ok(pictures.length === 12 && pictures.every(file => /^\/assets\/family\/(?:automagik-lockup-three-colours-(?:cream|ink)-(?:48|64|128)\.png|(?:omni|genie|mykes)-wordmark-(?:cream|ink)\.svg)$/.test(file)), `${route} ${pictures}`)
    assert.doesNotMatch(drawer, /assets\/(?:art|brand)\/|triskle|(?:genie|omni|mykes)-lockup|\.webp/, route)
    // The drawer reaches every page of the site, the docs, the app and the privacy note. A
    // place on the page being read is a bare #name, so the piece shuts the drawer first.
    const reach = [...drawer.matchAll(/<a\b[^>]*href="([^"]+)"/g)].map(match => match[1])
    for (const page of routes) assert.ok(reach.includes(page), `${route}: the drawer reaches ${page}`)
    assert.ok(reach.includes(docs) && reach.includes(route === '/desktop/' ? '#install' : '/desktop/#install') && reach.includes(route === '/cloud/' ? '#privacy' : '/cloud/#privacy'), route)
    for (const place of reach.filter(href => href.startsWith('#'))) assert.ok(html.includes(`id="${place.slice(1)}"`), `${route} ${place}`)
    assert.ok(reach.every(href => href === docs || href.startsWith('/') || href.startsWith('#')), `${route}: every other address is this site's own`)
  }
})

// THE HOST IS AUTOMAGIK (the package's issue 11b, "A case of its own"). On Automagik's own
// pages the "You are here" block and the Automagik row would show the same lockup, one under
// the other. The rule: Automagik appears once, as the "You are here" block; the Automagik row
// is left out; Desktop and Mobile move into that block, right under the link and above the
// page list; Products lists Arca first, by its own logo, then omni, genie and mykes.
test('the family drawer, the host is Automagik: its lockup once, Desktop and Mobile in the top block, Arca first in Products', () => {
  const piece = uncommented(read('assets/family/family.html'))
  const lockup = piece.match(/<span class="fam-lockup"><picture class="fam-lock-cream">.*?<\/picture><picture class="fam-lock-ink">.*?<\/picture><\/span>/)[0]
  const apps = piece.match(/<span class="fam-apps" role="group" aria-label="The Automagik app">.*?<\/span>/)[0].replaceAll('href="https://automagik.si/', 'href="/')
  for (const [route] of generated) {
    const drawer = family(route), menu = drawer.slice(drawer.indexOf('<nav class="fam"'), drawer.indexOf('</nav>'))
    const mark = route === '/desktop/' || route === '/mobile/' ? apps.replace(`href="${route}" data-family-product=`, `href="${route}" aria-current="page" data-family-product=`) : apps
    // ONCE: the menu holds Automagik's lockup one time, in the top block's link, and has
    // no Automagik row. (The layer that opens on the way to another product keeps the
    // piece's large lockup: it is not in the menu, and shows only then.)
    assert.equal(menu.split('<span class="fam-lockup">').length, 2, `${route}: Automagik's lockup stands once in the menu`)
    assert.equal(menu.split('data-family-product="Automagik"').length, 2, route)
    assert.doesNotMatch(drawer, /fam-top|fam-home/, `${route}: the Automagik row is left out`)
    // THE TOP BLOCK, in order: the link (lockup, line, "You are here"), Desktop and Mobile
    // right under it, then the list of pages.
    const block = menu.match(/<div class="fam-here-block" data-family-here>\n([\s\S]*?)\n  <\/div>/)[1].split('\n').map(line => line.trim())
    assert.equal(block.length, 3, route)
    assert.ok(block[0].startsWith('<a class="fam-item is-here" href="/" data-family-product="Automagik"') && block[0].includes(`<span class="fam-logo">${lockup.replaceAll('alt=""', 'alt="Automagik"')}</span><span>${familyHost.line}</span>`.replace(/__FAM_LOCKUP_(CREAM|INK)_(48|64)__/g, (slot, tone, size) => `/assets/family/automagik-lockup-three-colours-${tone.toLowerCase()}-${size}.png`)) && block[0].endsWith('<span class="fam-here">You are here</span></a>'), `${route}: the top block's link`)
    assert.equal(block[1], mark, `${route}: Desktop and Mobile stand in the top block, right under the link`)
    assert.ok(block[2].startsWith('<ul class="fam-links" data-family-links aria-label="Sections">'), `${route}: the page list comes after them`)
    // PRODUCTS: Arca first, by its own logo (the package's file, inline, in the text colour)
    // and its own line; then the three words.
    const names = [...menu.slice(menu.indexOf('<ul class="fam-list">')).matchAll(/data-family-product="([^"]+)"/g)].map(match => match[1])
    assert.deepEqual(names, ['Arca', 'Omni', 'Genie', 'Mykes'], `${route}: Arca is the first of the products`)
    const first = menu.match(/<ul class="fam-list">\n\s*<li>(.*)<\/li>\n/)[1]
    assert.ok(first.startsWith('<a class="fam-item is-logo" href="/arca/"') && first.includes(`<span class="fam-logo">${read('assets/family/arca-logo-b.svg').trim()}</span><span>${arca.line}</span>`), `${route}: Arca's row is its logo and its line`)
    assert.ok(!first.includes(' aria-current'), `${route}: Arca's page is never the page being read here`)
    assert.equal(menu.split('<svg').length, 2, `${route}: the ark is the menu's one drawing`)
    // NEVER REPEATED LOWER DOWN: each thing has one place in the menu, and the page list
    // holds only pages with no row or button of their own.
    const places = [...menu.matchAll(/data-family-product="([^"]+)"/g)].map(match => match[1])
    assert.deepEqual(places, ['Automagik', 'Desktop', 'Mobile', 'Arca', 'Omni', 'Genie', 'Mykes'], route)
    const own = [...menu.matchAll(/<a class="fam-(?:item|chip)[^"]*" href="([^"]+)"/g)].map(match => match[1])
    for (const [href] of familyLinks) assert.ok(!own.includes(href), `${route}: ${href} already has its place in the menu`)
  }
  assert.deepEqual(familyLinks.map(([href]) => href), ['/cloud/', '/desktop/#install', '/cloud/#privacy'])
  assert.equal(familyHost.arcaLine, arca.line)
  // The two rules this case needs are in the piece's own stylesheet since issue 12 (they were
  // in the package's README before, for the host to add). Here they are, word for word: the
  // piece holds each once, and this site's stylesheet does not say them again.
  const squeeze = text => text.replace(/\s+/g, '')
  const css = squeeze(read('styles.css')), given = squeeze(read('assets/family/family.css'))
  for (const rule of [
    '.fam-here-block .fam-apps { padding: var(--space-8) var(--space-13) 0; }',
    '.fam-item.is-logo .fam-words > span:last-child { padding-left: calc(var(--lock) * 321.34 / 264); }',
  ]) {
    assert.equal(given.split(squeeze(rule)).length, 2, `the piece's stylesheet holds ${rule}`)
    assert.ok(!css.includes(squeeze(rule).split('{')[0] + '{'), `this site's stylesheet does not set ${rule.split(' {')[0]} again`)
  }
  // The label over Products and Arca's line stand in the same column: the piece's own measure.
  assert.ok(read('assets/family/family.css').includes('.fam > .eyebrow { padding-left: calc(var(--lock) * 321.34 / 264); }'))
})

test('the family drawer wears this site: every name the piece reads is given, and the light page takes the piece\'s own day values', () => {
  const piece = read('assets/family/family.css')
  // The piece is written against names its host supplies. Every one it reads, and does not
  // set itself (or leave to its script, the four --fam- places), is set by this site's stylesheets.
  const set = new Set([...piece.matchAll(/(--[a-z0-9-]+)\s*:/g)].map(match => match[1]))
  const needed = [...new Set([...piece.matchAll(/var\((--[a-z0-9-]+)/g)].map(match => match[1]))].filter(name => !set.has(name) && !/^--fam-[bxy]/.test(name)).sort()
  assert.deepEqual(needed, ['--card-active', '--duration-base', '--duration-fast', '--duration-move', '--duration-page', '--ease', '--ease-move', '--font-display', '--font-mono', '--ground', '--line', '--max-width', '--radius-pill', '--space-13', '--space-21', '--space-8', '--tap-target', '--text', '--text-faint', '--text-label', '--text-lead', '--text-muted', '--text-title'])
  // --max-width is the one not given: the piece reads it only to keep the logo clear of the
  // button, and that rule is said again here with this site's own column.
  for (const name of needed.filter(name => name !== '--max-width')) assert.match(css, new RegExp(`[{;\\s]${name}:`), `${name} is given`)
  assert.ok(piece.includes('.topbar-in { padding-left: max(var(--space-21), calc(var(--fam-clear) - max(0px, (100% - var(--max-width)) / 2))); }'))
  assert.ok(css.includes('\n.top-inner.topbar-in{padding-left:max(var(--gutter),calc(var(--fam-clear) - max(0px,(100% - (var(--max) + 2 * var(--gutter))) / 2)))}\n'))
  // Colours come from this site's tokens, type from its two families at its three weights.
  const given = css.match(/\n:root\{--ground:[^}]+\}/)[0]
  for (const pair of ['--ground:var(--bg)', '--text-muted:var(--muted)', '--text-faint:var(--muted)', '--card-active:var(--bt-active)', '--font-mono:var(--head)', '--font-display:var(--head)']) assert.ok(given.includes(pair), pair)
  assert.doesNotMatch(given, /#[0-9a-f]{3,8}\b|rgb/i)
  assert.ok(css.includes('\n.fam-chip,.fam-here,.fam-links a,.fam-item::after{font-weight:var(--weight-label)}\n') && css.includes('\n.fam-world-in b{font-weight:var(--weight-title);letter-spacing:-.02em}\n'))
  // The drawer's close and the page's slide end before the script's own timers do.
  const seconds = name => Number(given.match(new RegExp(`${name}:([.\\d]+)s`))[1])
  assert.ok(seconds('--duration-move') <= 0.48 && seconds('--duration-page') <= 0.7 && seconds('--duration-fast') < seconds('--duration-base'))
  assert.match(read('assets/family/family.js'), /calm \? 0 : 480\)/); assert.match(read('assets/family/family.js'), /calm \? 0 : 700\)/)
  // The piece marks its day theme with an attribute; this site follows the visitor's system
  // and sets none. So the piece's day values are said again for a light page, word for word.
  const squeeze = text => text.replace(/\s+/g, '').replace(/;\}/g, '}')
  const day = squeeze(piece.match(/\[data-theme="day"\] \.fam-btn \{[^}]+\}/)[0]).replace('[data-theme="day"]', '')
  assert.equal(day, '.fam-btn{--fam-violet:#9062be;--fam-pink:#d03f7c;--fam-cyan:#0781a4}')
  assert.ok(squeeze(piece).includes('[data-theme="day"].fam-lockup.fam-lock-ink{display:block}[data-theme="day"].fam-lockup.fam-lock-cream{display:none}'))
  assert.ok(css.includes(`\n@media (prefers-color-scheme:light){\n  ${day}\n  .fam-lockup .fam-lock-ink{display:block}\n  .fam-lockup .fam-lock-cream{display:none}\n}\n`))
  // The ground the piece gives another product's world is this site's own page colour and
  // ink in both themes, so the site names them by token.
  assert.ok(squeeze(piece).includes('background:#1e1923;color:#f3e9dd;') && squeeze(piece).includes('[data-theme="day"].fam-world,[data-theme="day"].fam-world{background:#f6eee2;color:#3c3049}'))
  assert.ok(theme.includes('--bt-main:#f6eee2;') && theme.includes('--bt-ink:#3c3049;') && theme.includes('--bt-main:#1e1923;') && theme.includes('--bt-ink:#f3e9dd;'))
  assert.ok(css.includes('\n.fam-world{background:var(--bg);color:var(--text)}\n'))
  // The button stands in the middle of this header, and the site's pages fold into the
  // drawer at the width where the header's menus fold away.
  assert.ok(css.includes('\n.top .fam-btn{top:calc((var(--top-h) - 48px) / 2)}\n'))
  assert.match(css, /@media \(max-width:860px\)\{[^@]*\n  \.main-nav\{display:none\}[^@]*\n  \.fam-links\{display:grid\}/)
  // The site's own focus ring would square the round button and the pills.
  assert.ok(css.includes('\n.fam-btn:focus-visible{border-radius:50%}\n.fam-chip:focus-visible{border-radius:var(--radius-pill)}\n'))
  // The family's rule for the move between pages, inside the reduced-motion guard.
  assert.match(css, /@media \(prefers-reduced-motion:no-preference\)\{[\s\S]*\n  \.fam-btn\{view-transition-name:fb-bar\}\n  ::view-transition-group\(fb-bar\)\{animation:none\}\n/)
  // The phone sheet's styles went with the sheet.
  assert.doesNotMatch(css, /\.menu-open|\.menu-fallback|\.drawer\b|\.menu-glyph/)
  // The Cloud form's answer pages keep their own small header and their no-script policy.
  assert.ok(read('waitlist/lib/ui.js').includes(`'Content-Security-Policy': "default-src 'none'; style-src 'self'; img-src 'self' data:; font-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'"`))
  assert.doesNotMatch(read('waitlist/lib/ui.js'), /family|<script/)
})

test('navigation: menus, footer sitemap, breadcrumb and previous/next on every page', () => {
  const hrefs = html => [...html.matchAll(/<a\b[^>]*href="([^"]+)"/g)].map(match => match[1])
  for (const [route, html] of generated) {
    // Three header menus: a button that opens a popover panel, no scripting.
    const buttons = [...html.matchAll(/<button class="menu-button" type="button" popovertarget="(menu-[a-z]+)"/g)].map(match => match[1])
    assert.deepEqual(buttons, ['menu-products', 'menu-resources', 'menu-company'], route)
    for (const id of buttons) assert.match(html, new RegExp(`id="${id}" popover`), `${route} ${id}`)
    // One menu button: the family drawer's. The phone sheet and its Menu button are gone.
    assert.doesNotMatch(html, /class="menu-open"|id="site-menu"|class="menu-fallback"|class="drawer/, route)
    // The browser owns the expanded state of a popover's button, and the drawer's script sets
    // its own button's: a written one would go stale.
    assert.doesNotMatch(html, /aria-expanded=/, route)
    const panel = id => html.match(new RegExp(`id="menu-${id}" popover>([\\s\\S]*?)</div></div></li>`))[1]
    const drawer = family(route), footer = html.slice(html.indexOf('<footer'), html.indexOf('</footer>'))
    const group = (source, label, end) => source.slice(source.indexOf(`>${label}</`), end ? source.indexOf(`>${end}</`) : undefined)
    // Products: the seven, in one order, in the menu and the footer.
    assert.deepEqual(hrefs(panel('products')).slice(0, 7), productOrder, route)
    assert.deepEqual(hrefs(group(footer, 'Products', 'Resources')), productOrder, route)
    // Resources and Company: the same links in the menu and the footer.
    const resources = hrefs(panel('resources')), company = hrefs(panel('company')).slice(0, 3)
    assert.deepEqual(resources, [docs, '/desktop/#install', '/mobile/#install'], route)
    assert.deepEqual(company, [weUnfold.url, docs, '/cloud/#privacy'], route)
    assert.deepEqual(hrefs(group(footer, 'Resources', 'Company')), resources, route)
    assert.deepEqual(hrefs(group(footer, 'Company')).slice(0, 3), company, route)
    // Every menu entry has a one-line description and its character, mark or glyph.
    for (const source of [panel('products'), panel('resources'), panel('company')]) {
      for (const [item] of source.matchAll(/<a class="menu-item"[\s\S]*?<\/a>/g)) assert.match(item, /<span class="menu-icon">(?:<img|<svg|<picture>|<span class="arca-ark")[\s\S]*<strong>[^<]+[\s\S]*<\/strong><span>[^<]{8,}<\/span>/, `${route} ${item.slice(0, 80)}`)
    }
    // The active page: marked in the header button, the menu, the drawer and the footer.
    // On the home page the one mark is the drawer's top block, the site itself.
    const current = (html.match(/aria-current="page"/g) ?? []).length
    if (route === '/') {
      assert.equal(current, 1); assert.ok(drawer.includes('<a class="fam-item is-here" href="/" data-family-product="Automagik"') && drawer.includes(' aria-current="page"><span class="fam-words"><span class="fam-logo">'))
      assert.doesNotMatch(html, /class="crumbs|class="pager/)
      continue
    }
    const name = html.match(/<span aria-current="page">([^<]+)<\/span>/)[1]
    assert.ok(html.includes(`data-here>Products<span class="menu-here"><span class="sr">, current page: </span>${name}</span>`), route)
    for (const source of [panel('products'), drawer, footer]) assert.ok(source.includes(`href="${route}" aria-current="page"`), route)
    assert.equal(current, 4, route)
    // The way back, and the neighbours in the product order.
    assert.ok(html.includes(`<nav class="crumbs wrap" aria-label="Breadcrumb"><ol><li><a href="/#blocks">All products</a></li><li><span aria-current="page">${name}</span></li></ol></nav>`), route)
    // The pager walks the pages this site builds: Arca's page is Arca's own and has no pager
    // that leads back, so the round passes it by (after Cloud comes Mykes).
    const round = productOrder.filter(href => href !== arcaPath)
    const at = round.indexOf(route), step = by => round[(at + by + round.length) % round.length]
    const pager = html.match(/<nav class="pager"[^>]*>.*?<\/nav>/s)[0]
    assert.deepEqual(hrefs(pager), [step(-1), '/#blocks', step(1)], `${route}: previous and next are the neighbours among this site's pages`)
    assert.ok(pager.includes(`rel="prev" href="${step(-1)}"`) && pager.includes(`rel="next" href="${step(1)}"`), route)
    assert.match(html, /<a class="pager-all" href="\/#blocks">All products<\/a>/, route)
  }
})

// ARCA'S LOGO IS THE ARK (the family package's issue 11c): the ark, in one colour, the text
// colour, never coloured; with "arca" as the logo, alone as the small picture. The arch is
// Arca's earlier logo and no other site should use it. So this site shows no arch: the
// drawer's row is the ark logo, the Products menu and the home card show the ark alone,
// all the package's files as they are, and the arch's files are gone.
test('Arca is shown by the ark, the package\'s files, and the site shows no arch', () => {
  // NO ARCH: not in a page, not in the stylesheet, not in the builder, not as a file.
  for (const [route, html] of generated) assert.doesNotMatch(html, /arca-mark|arca-icon|assets\/brand\/arca\//, `${route} shows no arch`)
  const css = read('styles.css')
  assert.doesNotMatch(css, /arca-mark|arca-icon/)
  assert.doesNotMatch(read('scripts/build-pages.mjs'), /arca-mark|arca-icon|arcaMark/)
  assert.equal(existsSync(resolve(root, 'assets/brand/arca')), false, 'the arch\'s files are not in this site')

  // THE ARK WITH ITS WORD is the package's file, byte for byte, written once into every
  // page: the drawer's row. No page's content holds it (Arca's own page is not built here).
  const logo = read('assets/family/arca-logo-b.svg')
  assert.equal(arcaLogo, logo.trim())
  for (const [route, html] of generated) {
    assert.equal(html.split(arcaLogo).length, 2, route)
    assert.ok(!html.match(/<main[\s\S]*<\/main>/)[0].includes(arcaLogo), route)
  }

  // THE PRODUCTS MENU AND THE HOME CARD show the ark alone: the package's file, byte for
  // byte, in a holder that hides it from assistive technology (the name stands beside it).
  const ark = read('assets/family/arca-ark-icon.svg')
  assert.equal(arcaArk, `<span class="arca-ark" aria-hidden="true">${ark.trim()}</span>`)
  for (const [route, html] of generated) {
    const entry = html.match(/<a class="menu-item" href="\/arca\/"[\s\S]*?<\/a>/)[0]
    assert.ok(entry.includes(`<span class="menu-icon">${arcaArk}</span><span class="menu-text"><strong>Arca</strong>`), `${route}: the menu's entry for Arca shows the ark`)
  }
  const card = htmlAt('/').match(/<article class="product-card" data-block="arca">[\s\S]*?<\/article>/)[0]
  assert.ok(card.includes(`<div class="tile-copy">${arcaArk}<h3><a href="/arca/">Arca</a></h3>`), 'the home card shows the ark over the name')
  // Drawn whole and centred in the menu's own square, in the text colour.
  assert.ok(css.includes('\n.arca-ark{display:block;flex:none;color:var(--text)}\n.arca-ark svg{display:block;width:100%;height:auto}\n.menu-icon .arca-ark{width:28px}\n.product-card .arca-ark{width:56px;margin-bottom:18px}\n'))
  assert.ok(css.includes('\n.menu-icon{flex:none;display:grid;place-items:center;width:44px;height:44px;'))

  // ONE COLOUR, THE TEXT COLOUR, NEVER COLOURED: neither file names a colour, and no rule
  // here tints, filters or moves either drawing.
  for (const file of [logo, ark]) { assert.match(file, / fill="currentColor" /); assert.doesNotMatch(file, /#[0-9a-f]{3,8}\b|rgb|gradient|style=|<script|<image|href=/i) }
  assert.doesNotMatch(css.replace('.arca-ark{display:block;flex:none;color:var(--text)}', ''), /arca-(?:logo|ark)[^{]*\{[^}]*(?:fill|color|filter|animation|transition|transform)/)
})

test('root discovery files allow every crawler including training and preserve Arca lines', () => {
  for (const [path, text] of rootFiles()) assert.equal(read(path), text, path)
  const robots = read('robots.txt')
  assert.match(robots, /^User-agent: \*\nAllow: \/\nAllow: \/arca\n/m)
  assert.doesNotMatch(robots, /Disallow|ai-train=no|ai-input=no/i)
  const sitemap = read('sitemap.xml')
  for (const route of routes) assert.ok(sitemap.includes(`<url><loc>https://automagik.si${route}</loc></url>`))
  assert.ok(!existsSync(resolve(root, 'arca/llms.txt')) && !existsSync(resolve(root, 'arca/index.md')))
  assert.ok(sitemap.includes('<url><loc>https://automagik.si/arca/</loc></url> <url><loc>https://automagik.si/arca/llms.txt</loc></url> <url><loc>https://automagik.si/arca/index.md</loc></url>'))
  for (const line of ['- [Automagik Arca, the page](https://automagik.si/arca/)', '- [Automagik Arca, for an assistant](https://automagik.si/arca/llms.txt)']) assert.ok(read('llms.txt').split('\n').includes(line))
  assert.doesNotMatch(read('_headers'), /X-Robots-Tag|noindex|nofollow/i)
  assert.doesNotMatch(read('llms.txt'), /noindex/i)
})

test('the Cloud form offers email only while WhatsApp sign-ups are paused; removal keeps WhatsApp', async () => {
  assert.equal(WHATSAPP_SIGNUPS_OPEN, false)
  const html = htmlAt('/cloud/')
  const { onRequest } = await import('./functions/api/waitlist.js')
  const served = await (await onRequest({ request: new Request('https://automagik.si/api/waitlist'), env: {} })).text()
  for (const [where, page] of [['/cloud/', html], ['/api/waitlist', served]]) {
    const add = page.match(/<form class="waitlist-form"[\s\S]*?<\/form>/)[0]
    assert.match(add, /<input type="hidden" name="channel" value="email">/, where)
    assert.match(add, /type="email" name="email" [^>]*required/, where)
    assert.doesNotMatch(add, /whatsapp|wa\.me|AMG-/i, where)
    const removal = page.match(/<form class="removal-form"[\s\S]*?<\/form>/)[0]
    assert.match(removal, /<option value="whatsapp">WhatsApp sender ID or number<\/option><option value="code">WhatsApp confirmation code<\/option>/, where)
    // No sentence on confirming by WhatsApp anywhere the person reads, in either language.
    for (const text of ['WhatsApp shows a code', 'WhatsApp confirmation may take a little while', 'pode demorar um pouco', 'wa.me', 'Choose email or WhatsApp', 'Send a WhatsApp code', 'Use email if you prefer']) assert.ok(!page.includes(text), `${where}: ${text}`)
  }
  assert.match(html, /<p>Confirm your interest by email\./)
  // Earlier WhatsApp sign-ups: what they store, who processes them and for how long.
  for (const text of ['For an earlier sign-up that chose WhatsApp, its confirmation stores the sender ID or number', 'an earlier sign-up that chose WhatsApp involves WhatsApp/Meta and our Omni', 'An earlier WhatsApp code counts if it was sent within half an hour', 'Pending WhatsApp entries are kept for that backlog window']) assert.ok(html.includes(text), text)
  // The switch turned on: the same source offers WhatsApp again, with its notice and wording.
  const open = waitlistIntro({ whatsapp: true }) + waitlistForm({ whatsapp: true }) + privacyNote({ whatsapp: true })
  for (const text of ['Choose email or WhatsApp', '<option value="whatsapp">WhatsApp — you send the first message</option>', 'lang="pt-BR">A confirmação pelo WhatsApp pode demorar um pouco', 'WhatsApp shows a code', 'Send a WhatsApp code within half an hour', 'Use email if you prefer']) assert.ok(open.includes(text), text)
})


test('approved WhatsApp support privacy is verbatim in English with its Portuguese counterpart', () => {
  const markup = supportPrivacy()
  const english = markup.match(/<section lang="en"[\s\S]*?<\/section>/)[0]
  const plain = text => text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
  const approved = read('waitlist/privacy-support.en.md').replace(/^## /, '')
  assert.equal(plain(english), plain(approved))
  const portuguese = markup.match(/<section lang="pt-BR"[\s\S]*?<\/section>/)[0]
  assert.equal(plain(portuguese), plain(read('waitlist/privacy-support.pt-BR.md').replace(/^## /, '')))
  for (const phrase of ['nunca inicia a conversa', 'seu próprio sandbox', 'nada é excluído automaticamente', 'modelo de IA', 'Não vendemos seus dados', 'baixar sua conversa ou reiniciá-la', 'nunca armazena o texto da sua mensagem']) assert.ok(plain(portuguese).includes(phrase), phrase)
  const html = htmlAt('/cloud/')
  assert.ok(html.includes(markup))
  assert.match(html, /180 days after code expiry/)
})


test('every public page forbids internal delivery and product-team jargon, including attributes', async () => {
  const forbidden = /\b(?:D[1-9]|GTM|rail|release\s+lane|lane)\b/i
  function inspect(directory = '') {
    for (const entry of readdirSync(resolve(root, directory), { withFileTypes: true })) {
      const path = directory ? `${directory}/${entry.name}` : entry.name
      if (entry.isDirectory()) inspect(path)
      else if (path.endsWith('.html')) assert.doesNotMatch(read(path), forbidden, path)
    }
  }
  inspect()
  // The shared dynamic form/confirmation pages expose the same privacy copy.
  const { onRequest } = await import('./functions/api/waitlist.js')
  const response = await onRequest({ request: new Request('https://automagik.si/api/waitlist'), env: {} })
  assert.doesNotMatch(await response.text(), forbidden, '/api/waitlist')
})

// The default companion is Pirlim (#1442): the capture scripts hatch it for the next regeneration.
// Read as text: importing them would start the capture runtime or browsers.
test('the capture scripts name the companion Pirlim and hold no Pip word', () => {
  for (const file of ['capture.mjs', 'scripted-model.mjs', 'theme.mjs']) {
    const source = read(`capture/${file}`)
    assert.match(source, /\bPirlim\b/, file)
    assert.doesNotMatch(source, /\bPip\b/, file)
  }
  const capture = read('capture/capture.mjs')
  assert.match(capture, /name: 'Pirlim', exact: true/)
  assert.match(capture, /name: 'Hatch Pirlim'/)
  assert.match(capture, /getByText\('Pirlim leads\. Who comes along\?'\)/)
  assert.match(capture, /keepWorkspace\('Pirlim'\)/)
  assert.match(capture, /name: 'Pirlim, Orchestrator, Main Bot'/)
  const model = read('capture/scripted-model.mjs')
  assert.ok(model.includes("Hi, I\\'m Pirlim!"))
  assert.match(model, /who === 'Pirlim'/)
  const theme = read('capture/theme.mjs')
  assert.match(theme, /api\('update-bot', \{ id: main\.id, name: 'Pirlim'/)
  assert.match(theme, /scenario: 'Fictional Pirlim, Rowan and Sage/)
})
