#!/usr/bin/env node
// The server image's secrecy gate, run before the image is ever pushed: extract the built
// image's rootfs, inventory every file in it, and refuse any that could carry a person's data
// or a credential.
//
// Every file gets the repository's own privacy grep (herdr/scripts/privacy-check.mjs, same
// deny list) and the image rules: a provider key, a token=, a JSON token field, a complete
// private-key block, /mnt/ai, a home path, a credential URL, .env/launch-url files, an archive,
// or any file under /data. The image's config and environment are scanned too. A hit fails the
// job; the one exception is an exact, reviewed entry in server/secrecy-allowlist.json (file +
// rule + matched string or its sha256), with a reason, for a vendored package's example or a
// toolchain's build account. There are no path patterns: an entry names one file, one rule and
// the exact match. Keys, private-key blocks, /data, our own code, /etc and config files may
// never be allowlisted.
//
// The billing rules (RFC 0025 Decided 12; issue #910) are a static scan of the image's
// dependencies and imports: the image is the open-source one, and Cloud supplies only
// configuration. They refuse the Stripe SDK (a `stripe` or `@stripe/*` package, a dependency on
// one, an import of one), a Stripe host, key or object id, and, in this repository's own code
// and the image's config, a billing or ledger import, a billing route, and a built-in gateway
// address or credential. A hit in our own code or the config may never be allowlisted. `--repo`
// runs the Stripe key and id rules over the repository's tracked files: no price or account
// value is written here, and this file names none (the rules are shapes, the tests build theirs).
//
// The image is exported (docker export), never run: the entrypoint, the profile seed and dsh
// do not execute. The layer list comes from the image's RootFS and from docker save's manifest;
// the file inventory, the allowlist used and any external symlinks go to --inventory so CI can
// keep them. Any unallowed hit exits 1.
//
//   node server/secrecy.mjs automagik-server:3.93.0 [--inventory secrecy] [--keep]
//   node server/secrecy.mjs --rootfs /tmp/rootfs [--inventory secrecy]   (no docker)
//   node server/secrecy.mjs --repo .                                     (tracked files only)
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { denyMatcher, fileText, scan } from '../herdr/scripts/privacy-check.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const LIST = join(ROOT, 'herdr', 'scripts', 'privacy-list.json')
export const ALLOWLIST_FILE = join(ROOT, 'server', 'secrecy-allowlist.json')
/** The only directories /data may carry; every file under it is a finding. */
export const DATA_DIRS = new Set(['data', 'data/dsh', 'data/bots', 'data/workspace', 'data/secrets'])
/** The dotenv names allowed: an example file has no values. */
const ENV_EXAMPLE = '.env.example'
/** Home paths, in text and in a binary's strings. */
const HOME = /(?:\/Users\/|\/home\/|[A-Za-z]:\\Users\\)([A-Za-z0-9._-]+)/g
/** Archives are not opened by this scan: an archive in a runtime image is a finding until one is reviewed. */
export const ARCHIVE = /\.(?:tgz|tar|tar\.gz|gz|xz|bz2|zip|7z|rar)$/i

const mb = (bytes) => `${(bytes / 1048576).toFixed(1)} MiB`
const lineOf = (text, index) => text.slice(0, index).split('\n').length
export const sha256 = (text) => createHash('sha256').update(String(text)).digest('hex')
/** A file digest over its bytes, equal to `sha256sum`; `sha256` above is for matched text. */
export const sha256Bytes = (bytes) => createHash('sha256').update(bytes).digest('hex')
const usage = 'usage: node server/secrecy.mjs <image> [--inventory <dir>] [--keep]\n'
  + '       node server/secrecy.mjs --rootfs <dir> [--inventory <dir>]\n'
  + '       node server/secrecy.mjs --repo <dir>'

/**
 * High-confidence live-secret shapes, applied to every file. `label` is a key of LABELS (or
 * picks one): a finding names the rule and the file, never the credential.
 */
export const SECRET_RULES = [
  { rule: 'key', re: /\bsk-(?:ant-)?[A-Za-z0-9_-]{16,}\b/g, label: 'key-sk' },
  { rule: 'key', re: /\bgh[pousr]_[A-Za-z0-9]{30,}\b/g, label: 'key-gh' },
  { rule: 'key', re: /\bgithub_pat_[A-Za-z0-9_]{40,}\b/g, label: 'key-github-pat' },
  { rule: 'key', re: /\bAKIA[0-9A-Z]{16}\b/g, label: 'key-akia' },
  { rule: 'key', re: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g, label: 'key-xox' },
  // A real block: a header, at least one body element (a base64 line of any length, including a
  // short final line, a Proc-Type/DEK-Info header, or the blank line after it), and a footer. A
  // bare BEGIN/END label constant is not a key.
  { rule: 'private-key', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\r\n]+(?:(?:Proc-Type|DEK-Info):[^\r\n]*[\r\n]+|[\r\n]+|[A-Za-z0-9+/=]+[\r\n]+)+-----END [A-Z ]*PRIVATE KEY-----/g, label: 'private-key' },
  { rule: 'private-path', re: /\/mnt\/ai(?:\/|\b)/g, label: 'private-path' },
]
/**
 * A token URL shows its scheme only: its userinfo, host, path and other parameters can each
 * carry a second credential beside the token.
 */
export const TOKEN_RULES = [
  { rule: 'token', re: /(?<![A-Za-z0-9_])token=[A-Za-z0-9_.~+\/-]{24,}/g, label: 'token' },
  { rule: 'token-url', re: /https?:\/\/[^\s"'<>]*[?&]token=[^&\s"'<>]+/g, label: (m) => `token-url-${m.slice(0, m.indexOf(':')).toLowerCase()}` },
  { rule: 'token-json', re: /["'](?:access_?|refresh_?|api_?|launch_?)?token["']\s*:\s*["'](?=[A-Za-z0-9_.~+\/-]{32,}["'])(?=[A-Za-z0-9_.~+\/-]*\d)[A-Za-z0-9_.~+\/-]+["']/gi, label: 'token-json' },
]
export const CREDENTIAL_RULES = [
  { rule: 'git-credentials', re: /(?:https?|ssh):\/\/[^\s/:@]+:[^\s/@]+@/g, label: 'credential-url' },
]
export const SERVER_RULES = [...SECRET_RULES, ...TOKEN_RULES, ...CREDENTIAL_RULES]

/**
 * Stripe values, by shape only: a secret, restricted or webhook key, and an object id (a price,
 * product, account, customer, subscription or plan, or a publishable key, which names an
 * account). An id needs a digit and a capital, so an ordinary `price_…` identifier is not one.
 * These are also what `--repo` refuses in the repository's tracked files.
 */
export const STRIPE_VALUE_RULES = [
  { rule: 'stripe-key', re: /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}\b/g, label: (m) => `stripe-key-${m.slice(0, 7)}` },
  { rule: 'stripe-key', re: /\bwhsec_[A-Za-z0-9]{24,}\b/g, label: 'stripe-key-whsec' },
  { rule: 'stripe-id', re: /\b(?:price|prod|acct|cus|sub|plan|pk_live|pk_test)_(?=[A-Za-z0-9]*\d)(?=[A-Za-z0-9]*[A-Z])[A-Za-z0-9]{14,}\b/g, label: (m) => `stripe-id-${m.slice(0, m.lastIndexOf('_'))}` },
]
/** A Stripe host: the API, the checkout or the browser script. Only a Stripe client names one. */
const STRIPE_HOST = /\b[a-z0-9-]+\.stripe\.com\b/g
/** The files whose imports are read. */
const SOURCE = /\.(?:[cm]?[jt]sx?|vue|svelte)$/
/** A module specifier: `from '…'`, `import '…'`, `import('…')`, `require('…')`, minified or not. */
const SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)(["'`])([^"'`\n]{1,200})\1/g
const STRIPE_PACKAGE = /^(?:stripe|@stripe\/[^/]+)(?:\/|$)/
/** A package folder of the SDK, however the installer laid it out (pnpm's store included). */
const STRIPE_FOLDER = /(?:^|\/)node_modules\/(?:stripe|@stripe)$/
const BILLING_WORD = /^(?:billing|ledger)$/i
/** Whether a specifier names a billing or ledger module: one of its words, in any segment. */
const billingSpecifier = (specifier) => specifier.split('/')
  .some((segment) => segment.replace(/\.[cm]?[jt]sx?$/, '').split(/[-_.@]/).some((word) => BILLING_WORD.test(word)))
/** A route literal with a billing or ledger segment. */
const BILLING_ROUTE = /(["'`])\/(?:[A-Za-z0-9_.:-]+\/)*(?:billing|ledger)(?:\/[^"'`\s]*)?\1/gi
/**
 * A built-in gateway address: a gateway-named setting whose default is a URL (`gatewayUrl =
 * '…'`, `GATEWAY_URL ?? '…'`, `"gateway": "…"`), or an address on one of this product's own
 * hosts that names a gateway. A provider preset's third-party address is neither: its key is a
 * provider id, and its host is not ours.
 */
const GATEWAY_DEFAULT = /gateway[A-Za-z0-9_]{0,32}["'`]?\s*(?:[:=]|\?\?=?|\|\|=?)\s*["'`](?:https?|wss?):\/\/[^\s"'`<>)\\]+/gi
const OWN_GATEWAY = [
  /(?:https?|wss?):\/\/(?:[a-z0-9-]+\.)*automagik\.[a-z]{2,}(?::\d+)?(?=[^\s"'`<>)\\]*gateway)[^\s"'`<>)\\]*/gi,
  /(?:https?|wss?):\/\/(?:[a-z0-9-]+\.)*gateway[a-z0-9-]*\.(?:[a-z0-9-]+\.)*automagik\.[a-z]{2,}[^\s"'`<>)\\]*/gi,
]
/** A reserved example host (RFC 2606) is a placeholder, never an address. */
const EXAMPLE_HOST = /:\/\/(?:[^/\s"'`]*\.)?(?:example(?:\.(?:com|org|net))?|invalid|test|localhost)(?=[:/"'`]|$)/i
/** A built-in gateway credential: a gateway-named token, key or secret with a literal value. */
const GATEWAY_CREDENTIAL = /gateway[A-Za-z0-9_]{0,32}(?:token|key|secret|credential)[A-Za-z0-9_]{0,16}["'`]?\s*(?:[:=]|\?\?=?|\|\|=?)\s*(["'`])(?=[A-Za-z0-9_.~+\/-]*\d)[A-Za-z0-9_.~+\/-]{16,}\1/gi
/** Every billing rule's name. */
export const BILLING_RULES = new Set([
  'stripe-sdk', 'stripe-client', 'stripe-key', 'stripe-id', 'billing-import', 'billing-route',
  'gateway-address', 'gateway-credential', 'billing-config',
])
const PROFILE_PATCH_HELPER = 'opt/apps/desktop/src/profile-patch.mjs'

/**
 * This repository's own code in the image: the image's scripts and versions file, the seed
 * profile, and the `@automagik` packages wherever the installer put them. A dependency's code
 * under any other `node_modules` folder is third-party.
 */
export function ownCode(file) {
  if (file === 'image-config' || file === PROFILE_PATCH_HELPER) return true
  if (!file.startsWith('opt/automagik/')) return false
  const at = file.lastIndexOf('node_modules/')
  return at === -1 || file.startsWith('@automagik/', at + 'node_modules/'.length)
}

/** Rules that may never be allowlisted: a provider key is never a reviewed exception. */
const NEVER_ALLOW_RULE = new Set(['key', 'data-state', 'launch-url', 'dotenv', 'env-secret', 'archive', 'unreadable', 'stripe-sdk', 'gateway-credential', 'billing-config'])
/** Paths that may never be allowlisted: /data, our own code, /etc and its config. */
const NEVER_ALLOW_PATH = /^(?:data\/|opt\/automagik\/(?:[^/]+\.mjs|versions\.json)|opt\/automagik\/profile\/(?:package\.json|cordis\.patch\.yml|pnpm-workspace\.yaml)|opt\/automagik\/profile\/node_modules\/@automagik\/|usr\/local\/bin\/(?:dsh|pnpm)$|etc\/)/
/** Only the six reviewed gnutls test-vector blocks may be private-key entries; nowhere else. */
const PRIVATE_KEY_ALLOW = /^usr\/lib\/x86_64-linux-gnu\/libgnutls\.so\.30$/
const allowable = (entry) => !NEVER_ALLOW_RULE.has(entry.rule)
  && !NEVER_ALLOW_PATH.test(entry.file)
  && entry.file !== PROFILE_PATCH_HELPER
  && !(BILLING_RULES.has(entry.rule) && ownCode(entry.file))
  && (entry.rule !== 'private-key' || PRIVATE_KEY_ALLOW.test(entry.file))

/**
 * The reviewed exceptions: one exact file, one rule and the exact matched string (or its
 * sha256), each with the reason it is not this repository's state. An entry for a key, a
 * private-key block, /data, our own code or /etc is refused at load.
 */
export function loadAllowlist(file = ALLOWLIST_FILE) {
  const entries = JSON.parse(readFileSync(file, 'utf8'))
  if (!Array.isArray(entries)) throw new Error('secrecy allowlist must be an array')
  const seen = new Set()
  for (const entry of entries) {
    if (!entry || typeof entry.file !== 'string' || typeof entry.rule !== 'string' || typeof entry.reason !== 'string') {
      throw new Error('secrecy allowlist entries need file, rule and reason')
    }
    if (!entry.match && !/^[0-9a-f]{64}$/.test(entry.sha256 ?? '')) throw new Error(`${entry.file}: allowlist entry needs match or sha256`)
    if (entry.fileSha256 !== undefined && !/^[0-9a-f]{64}$/.test(entry.fileSha256)) throw new Error(`${entry.file}: fileSha256 is not a sha256`)
    if (!allowable(entry)) throw new Error(`${entry.file}: ${entry.rule} may not be allowlisted here`)
    const key = `${entry.file}\0${entry.rule}\0${entry.sha256 ?? sha256(entry.match)}`
    if (seen.has(key)) throw new Error(`${entry.file}: duplicate allowlist entry`)
    seen.add(key)
  }
  return entries
}

/** Split hits into the ones an exact entry names (with its reason) and the ones that still fail. */
export function applyAllowlist(hits, entries = []) {
  const exact = new Map(entries
    .filter(allowable)
    .map((entry) => [`${entry.file}\0${entry.rule}\0${entry.sha256 ?? sha256(entry.match)}`, entry]))
  const used = new Map()
  const kept = []
  for (const hit of hits) {
    const key = `${hit.file}\0${hit.rule}\0${sha256(hit.raw ?? hit.match ?? '')}`
    const entry = exact.get(key)
    if (!entry || (entry.fileSha256 && entry.fileSha256 !== hit.fileSha256)) { kept.push(hit); continue }
    if (!used.has(key)) used.set(key, { file: hit.file, rule: hit.rule, reason: entry.reason, count: 0 })
    used.get(key).count += 1
  }
  const allowedKeys = new Set(used.keys())
  return {
    kept,
    allowed: [...used.values()],
    unused: entries.filter((entry) => !allowedKeys.has(`${entry.file}\0${entry.rule}\0${entry.sha256 ?? sha256(entry.match)}`)),
  }
}

const SCHEMES = ['http', 'https', 'ws', 'wss']
const STRIPE_ID_PREFIXES = ['price', 'prod', 'acct', 'cus', 'sub', 'plan', 'pk_live', 'pk_test']
/** The Stripe hosts a finding may name; any other label is shown as `***`. */
const STRIPE_LABELS = ['api', 'js', 'checkout', 'connect', 'files', 'hooks', 'm', 'dashboard', 'billing', 'buy', 'invoice']
/**
 * Every text a finding may show. A finding's public text (`hit.match`: stdout, stderr, the
 * inventory) is one of these constants and nothing else. It is never built from what was
 * scanned: not a matched string, a URL's userinfo, host, path or query, a route, an import, a
 * package name, a setting's key, an environment variable's name or value, or what the
 * repository's privacy grep printed, because any of them can carry a credential. The scanned
 * text stays in `hit.raw`, and the file's digest in `hit.fileSha256`: both are compared in memory
 * with an exact allowlist entry and never written. No hash of either is printed or put in the
 * inventory: an unkeyed sha256 of a short match or a small file can be guessed offline, so it
 * would hand back the very value the label hides. The file and line place the finding.
 */
export const LABELS = Object.freeze({
  'key-sk': 'sk-***',
  'key-gh': 'gh***',
  'key-github-pat': 'github_pat_***',
  'key-akia': 'AKIA***',
  'key-xox': 'xox***',
  'private-key': 'PRIVATE KEY block',
  'private-path': '/mnt/ai',
  token: 'token=***',
  'token-json': 'token: ***',
  'credential-url': '***:***@',
  'launch-url': 'a launch-url file',
  dotenv: 'a .env file',
  'credential-file': 'a credentials file',
  archive: 'an archive',
  'data-state': 'state under /data',
  unreadable: 'an unreadable file',
  'home-path': 'a home path',
  'private-name': 'a private name',
  secret: 'a secret',
  'db-file': 'a database file',
  privacy: 'a privacy finding',
  'stripe-folder': 'a Stripe SDK folder',
  'stripe-package': 'package stripe',
  'stripe-package-scope': 'package @stripe/***',
  'stripe-dependency': 'dependency stripe',
  'stripe-dependency-scope': 'dependency @stripe/***',
  'stripe-import': 'import stripe',
  'stripe-import-scope': 'import @stripe/***',
  'stripe-key-sk_live': 'sk_live_***',
  'stripe-key-sk_test': 'sk_test_***',
  'stripe-key-rk_live': 'rk_live_***',
  'stripe-key-rk_test': 'rk_test_***',
  'stripe-key-whsec': 'whsec_***',
  'stripe-host': '***.stripe.com',
  'gateway-own': 'own gateway host ***',
  'gateway-default': 'gateway default ***',
  'gateway-credential': 'gateway credential ***',
  'route-billing': '/***/billing/***',
  'route-ledger': '/***/ledger/***',
  'import-billing': 'import ***/billing/***',
  'import-ledger': 'import ***/ledger/***',
  'env-secret': 'an environment variable named like a secret',
  'env-gateway': 'a gateway environment variable',
  'env-billing': 'a Stripe, billing or ledger environment variable',
  ...Object.fromEntries(SCHEMES.filter((scheme) => scheme.startsWith('http')).map((scheme) => [`token-url-${scheme}`, `${scheme}://***?token=***`])),
  ...Object.fromEntries(SCHEMES.map((scheme) => [`gateway-own-${scheme}`, `own gateway host ${scheme}://***`])),
  ...Object.fromEntries(SCHEMES.map((scheme) => [`gateway-default-${scheme}`, `gateway default ${scheme}://***`])),
  ...Object.fromEntries(STRIPE_ID_PREFIXES.map((prefix) => [`stripe-id-${prefix}`, `${prefix}_***`])),
  ...Object.fromEntries(STRIPE_LABELS.map((label) => [`stripe-host-${label}`, `${label}.stripe.com`])),
})
/** A label key that is in the table, else the fallback (itself a key). */
const known = (key, fallback) => (Object.hasOwn(LABELS, key) ? key : fallback)
const labelOf = (label, text) => (typeof label === 'function' ? label(text) : label)

/**
 * One finding. `label` is a key of LABELS and the only source of the public text; `raw` is the
 * scanned text, kept for the hash and the exact allowlist. A key that is not in the table is
 * refused, with a message that does not repeat it.
 */
export function hitOf(file, line, rule, raw, label) {
  if (typeof label !== 'string' || !Object.hasOwn(LABELS, label)) throw new Error(`a ${rule} finding has no label in the table`)
  return { file, line, rule, raw, match: LABELS[label] }
}

/** Whether a file name alone is a finding. */
export function nameHits(file, kind = 'file') {
  const base = basename(file)
  const hits = []
  if (kind !== 'dir' && base === 'launch-url') hits.push(hitOf(file, 0, 'launch-url', file, 'launch-url'))
  if (kind !== 'dir' && /^\.env(?:\.|$)/.test(base) && base !== ENV_EXAMPLE) hits.push(hitOf(file, 0, 'dotenv', file, 'dotenv'))
  if (kind !== 'dir' && (base === '.git-credentials' || base === '.netrc' || base === 'netrc')) {
    hits.push(hitOf(file, 0, 'git-credentials', file, 'credential-file'))
  }
  if (kind === 'file' && ARCHIVE.test(base)) hits.push(hitOf(file, 0, 'archive', file, 'archive'))
  if (STRIPE_FOLDER.test(file)) hits.push(hitOf(file, 0, 'stripe-sdk', file, 'stripe-folder'))
  if (kind === 'dir') {
    if ((file === 'data' || file.startsWith('data/')) && !DATA_DIRS.has(file)) hits.push(hitOf(file, 0, 'data-state', file, 'data-state'))
  } else if (file.startsWith('data/')) {
    hits.push(hitOf(file, 0, 'data-state', file, 'data-state'))
  }
  return hits
}

/**
 * Every hit in one file's text: the repository's privacy grep (emails excepted: public package
 * metadata carries author addresses, and the deny list's private names still catch the owner)
 * and every server rule.
 */
export function textHits(file, text, list, denied = denyMatcher(list.deny), { privacy = true } = {}) {
  const hits = []
  if (privacy) {
    for (const found of scan(file, text, list, denied)) {
      if (found.rule !== 'email') hits.push(hitOf(file, found.line, found.rule, found.match, known(found.rule, 'privacy')))
    }
  }
  for (const { rule, re, label } of SERVER_RULES) {
    for (const match of text.matchAll(re)) hits.push(hitOf(file, lineOf(text, match.index), rule, match[0], labelOf(label, match[0])))
  }
  return hits
}

/** The first captured word, lowercased: only ever used to pick a key of LABELS. */
const word = (text, re) => (re.exec(String(text))?.[1] ?? '').toLowerCase()
/** A URL finding's key: the kind and the URL's scheme. */
const addressLabel = (kind, text) => known(`${kind}-${word(text, /\b(https?|wss?):\/\//i)}`, kind)
/** A route's key: which of the two words its first such segment is. */
const routeLabel = (text) => known(`route-${word(text, /\/(billing|ledger)(?![A-Za-z0-9_.:-])/i)}`, 'route-billing')
/** A billing or ledger specifier's key: which word it names first. */
const specifierLabel = (specifier) => known(`import-${word(specifier, /(billing|ledger)/i)}`, 'import-billing')
/** The SDK's key: `stripe`, or the scope without the name under it. */
const stripeLabel = (kind, name) => (/^stripe(?:\/|$)/.test(String(name)) ? `stripe-${kind}` : `stripe-${kind}-scope`)
/** A Stripe host's key: its first label only when it is one of the public ones. */
const stripeHostLabel = (host) => known(`stripe-host-${String(host).split('.')[0].toLowerCase()}`, 'stripe-host')

/** The dependency maps a package installs: a development dependency is not in the image. */
const DEPENDENCY_FIELDS = ['dependencies', 'optionalDependencies', 'peerDependencies', 'bundledDependencies', 'bundleDependencies']

/** The Stripe SDK as a package, or as something a package asks the installer for. */
function manifestHits(file, text) {
  let manifest
  try { manifest = JSON.parse(text) } catch { return [] }
  if (!manifest || typeof manifest !== 'object') return []
  const hits = []
  if (typeof manifest.name === 'string' && STRIPE_PACKAGE.test(manifest.name)) hits.push(hitOf(file, 0, 'stripe-sdk', manifest.name, stripeLabel('package', manifest.name)))
  for (const field of DEPENDENCY_FIELDS) {
    const value = manifest[field]
    const names = Array.isArray(value) ? value : Object.keys(value && typeof value === 'object' ? value : {})
    for (const name of names) {
      if (typeof name === 'string' && STRIPE_PACKAGE.test(name)) hits.push(hitOf(file, 0, 'stripe-sdk', name, stripeLabel('dependency', name)))
    }
  }
  return hits
}

/**
 * The billing rules on one text file (RFC 0025 Decided 12). Everywhere: the Stripe SDK as a
 * package, a dependency or an import, a Stripe host, key or object id, and a gateway address on
 * one of our own hosts. In our own code and the image's config only: a billing or ledger
 * import, a billing route, and a gateway-named setting with a built-in address or credential.
 */
export function billingHits(file, text) {
  const hits = []
  const add = (rule, match, label) => hits.push(hitOf(file, lineOf(text, match.index), rule, match[0], label))
  const own = ownCode(file)
  for (const { rule, re, label } of STRIPE_VALUE_RULES) {
    for (const match of text.matchAll(re)) add(rule, match, labelOf(label, match[0]))
  }
  for (const match of text.matchAll(STRIPE_HOST)) add('stripe-client', match, stripeHostLabel(match[0]))
  for (const re of OWN_GATEWAY) {
    for (const match of text.matchAll(re)) add('gateway-address', match, addressLabel('gateway-own', match[0]))
  }
  if (basename(file) === 'package.json') hits.push(...manifestHits(file, text))
  if (SOURCE.test(file)) {
    for (const match of text.matchAll(SPECIFIER)) {
      if (STRIPE_PACKAGE.test(match[2])) add('stripe-sdk', match, stripeLabel('import', match[2]))
      else if (own && billingSpecifier(match[2])) add('billing-import', match, specifierLabel(match[2]))
    }
  }
  if (own) {
    for (const match of text.matchAll(BILLING_ROUTE)) add('billing-route', match, routeLabel(match[0]))
    for (const match of text.matchAll(GATEWAY_DEFAULT)) {
      if (!EXAMPLE_HOST.test(match[0])) add('gateway-address', match, addressLabel('gateway-default', match[0]))
    }
    for (const match of text.matchAll(GATEWAY_CREDENTIAL)) add('gateway-credential', match, 'gateway-credential')
  }
  return hits
}

/** Home paths in a binary's strings (a text file's are in the privacy grep). */
export function homeHits(file, text) {
  const hits = []
  for (const line of text.split('\n')) {
    for (const match of line.matchAll(HOME)) hits.push(hitOf(file, 0, 'home-path', match[0], 'home-path'))
  }
  return hits
}

/** Every entry under `root`, without following symlinks out of it. */
export function walk(root) {
  const entries = []
  const visit = (dir) => {
    for (const name of readdirSync(dir).sort()) {
      const abs = join(dir, name)
      const file = relative(root, abs).split(sep).join('/')
      const stat = lstatSync(abs)
      if (stat.isDirectory()) {
        entries.push({ file, kind: 'dir' })
        visit(abs)
      } else if (stat.isSymbolicLink()) {
        entries.push({ file, kind: 'symlink', target: readlinkSync(abs) })
      } else if (stat.isFile()) {
        entries.push({ file, kind: 'file', size: stat.size })
      } else {
        entries.push({ file, kind: 'other' })
      }
    }
  }
  visit(root)
  return entries
}

/** Symlinks whose target is outside the rootfs (reported, not followed) or missing. */
export function symlinks(root, entries) {
  const external = []
  for (const entry of entries) {
    if (entry.kind !== 'symlink') continue
    const target = resolve(dirname(join(root, entry.file)), entry.target)
    if (!(target === root || target.startsWith(`${root}${sep}`))) external.push({ file: entry.file, target: entry.target, kind: 'external' })
    else if (!lstatSync(target, { throwIfNoEntry: false })) external.push({ file: entry.file, target: entry.target, kind: 'dangling' })
  }
  return external
}

/** Scan an extracted rootfs: inventory, names, contents and the /data rule; apply exact exceptions. */
export function scanTree(root, list = JSON.parse(readFileSync(LIST, 'utf8')), allowlist = loadAllowlist()) {
  const denied = denyMatcher(list.deny)
  const entries = walk(root)
  const raw = []
  let bytes = 0
  for (const entry of entries) {
    if (entry.kind !== 'file') {
      raw.push(...nameHits(entry.file, entry.kind))
      continue
    }
    bytes += entry.size
    let buf
    try {
      buf = readFileSync(join(root, entry.file))
    } catch (error) {
      raw.push(hitOf(entry.file, 0, 'unreadable', error.code ?? 'read failed', 'unreadable'))
      continue
    }
    const digest = sha256Bytes(buf)
    const tagged = (hits) => hits.map((hit) => ({ ...hit, fileSha256: digest }))
    raw.push(...tagged(nameHits(entry.file, entry.kind)))
    const binary = buf.includes(0)
    const text = fileText(buf)
    raw.push(...tagged(textHits(entry.file, text, list, denied, { privacy: !binary })))
    if (binary) raw.push(...tagged(homeHits(entry.file, text)))
    else raw.push(...tagged(billingHits(entry.file, text)))
  }
  const applied = applyAllowlist(raw, allowlist)
  return { entries, hits: applied.kept, allowed: applied.allowed, unused: applied.unused, bytes, external: symlinks(root, entries) }
}

/** The image's own config (env and labels), scanned like a file; docker keeps no secret there. */
export function scanImageConfig(image, list, denied = denyMatcher(list.deny)) {
  const raw = execFileSync('docker', ['image', 'inspect', image, '--format', '{{json .Config}}'], { encoding: 'utf8' })
  return configHits(raw, list, denied)
}

/**
 * The hits in an image config's JSON. Beside the text rules: a variable named like a secret,
 * and any gateway, Stripe, billing or ledger variable with a value. Cloud supplies those as
 * configuration at run time; the image sets none.
 */
export function configHits(raw, list, denied = denyMatcher(list.deny)) {
  const hits = [...textHits('image-config', raw, list, denied), ...billingHits('image-config', raw)]
  let config
  // The parser's own message quotes its input, so it is not passed on.
  try { config = JSON.parse(raw) } catch { throw new Error('the image config is not JSON') }
  for (const line of config?.Env ?? []) {
    const [name, ...rest] = line.split('=')
    const value = rest.join('=')
    if (!value) continue
    if (/(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/i.test(name)) hits.push(hitOf('image-config', 0, 'env-secret', name, 'env-secret'))
    if (/GATEWAY/i.test(name)) hits.push(hitOf('image-config', 0, 'gateway-address', name, 'env-gateway'))
    else if (/(?:STRIPE|BILLING|LEDGER)/i.test(name)) hits.push(hitOf('image-config', 0, 'billing-config', name, 'env-billing'))
  }
  return hits
}

/**
 * The repository's tracked files against the Stripe value rules: no key, price, product or
 * account id is written in this repository (RFC 0025 phase A's check). Tracked files only, so
 * an install folder or a build output is not read; a binary file is skipped.
 */
export function scanRepo(root, files = execFileSync('git', ['-C', root, 'ls-files', '-z'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).split('\0').filter(Boolean)) {
  const hits = []
  let checked = 0
  for (const file of files) {
    const abs = join(root, file)
    if (!lstatSync(abs, { throwIfNoEntry: false })?.isFile()) continue
    const buf = readFileSync(abs)
    if (buf.includes(0)) continue
    checked += 1
    const text = buf.toString('utf8')
    for (const { rule, re, label } of STRIPE_VALUE_RULES) {
      for (const match of text.matchAll(re)) hits.push(hitOf(file, lineOf(text, match.index), rule, match[0], labelOf(label, match[0])))
    }
  }
  return { hits, checked }
}

/**
 * Export the image's rootfs into a work directory, read its layers (RootFS diff ids and the
 * docker-save manifest blobs) and never run it. `docker create` runs no entrypoint.
 */
export function extractImage(image, work = mkdtempSync(join(tmpdir(), 'automagik-secrecy-'))) {
  const tar = join(work, 'image.tar')
  const saved = join(work, 'image-save.tar')
  const rootfs = join(work, 'rootfs')
  mkdirSync(rootfs, { recursive: true })
  const name = `automagik-secrecy-${process.pid}`
  execFileSync('docker', ['image', 'inspect', image, '--format', '{{.Id}}'], { stdio: 'pipe' })
  const layers = JSON.parse(execFileSync('docker', ['image', 'inspect', image, '--format', '{{json .RootFS.Layers}}'], { encoding: 'utf8' }))
  let blobs = []
  try {
    execFileSync('docker', ['save', '--output', saved, image], { stdio: 'pipe' })
    blobs = JSON.parse(execFileSync('tar', ['-xOf', saved, 'manifest.json'], { encoding: 'utf8' }))[0]?.Layers ?? []
  } catch {
    blobs = []
  } finally {
    rmSync(saved, { force: true })
  }
  try {
    // A command lets docker create an image that declares no CMD (the self-check's imported
    // red image); it is never run, only exported.
    execFileSync('docker', ['create', '--name', name, image, '/bin/true'], { stdio: 'pipe' })
    execFileSync('docker', ['export', '--output', tar, name], { stdio: 'pipe' })
  } finally {
    try { execFileSync('docker', ['rm', '--force', name], { stdio: 'ignore' }) } catch {}
  }
  execFileSync('tar', ['-xf', tar, '-C', rootfs], { stdio: 'pipe' })
  rmSync(tar, { force: true })
  return { work, rootfs, layers, blobs }
}

/** Write what was checked: inventory, layers, exact allowlist used, external symlinks, findings. */
export function writeInventory(dir, { image, layers, blobs, entries, hits, allowed, unused, external }) {
  mkdirSync(dir, { recursive: true })
  const files = entries.map((entry) => {
    const target = entry.target ? ` -> ${entry.target}` : ''
    const size = entry.size !== undefined ? `\t${entry.size}` : ''
    return `${entry.kind}\t${entry.file}${size}${target}`
  })
  const layerLines = ['# RootFS.Layers (diff ids)', ...(layers ?? []), '', '# docker save manifest layers', ...(blobs ?? []), '']
  writeFileSync(join(dir, 'image-files.txt'), `${files.join('\n')}\n`)
  writeFileSync(join(dir, 'image-layers.txt'), layerLines.join('\n'))
  writeFileSync(join(dir, 'secrecy.txt'), hits.length
    ? `${hits.map((hit) => `${hit.file}:${hit.line}: ${hit.rule}: ${hit.match}`).join('\n')}\n`
    : 'clean\n')
  // The findings as data: where, which rule, and the label. No hash of the match or of the file.
  writeFileSync(join(dir, 'secrecy-hits.json'), `${JSON.stringify(hits.map((hit) => ({
    file: hit.file,
    line: hit.line,
    rule: hit.rule,
    match: hit.match,
  })), null, 2)}\n`)
  writeFileSync(join(dir, 'allowlist-used.txt'), allowed.length
    ? `${allowed.map((entry) => `${entry.file}: ${entry.rule} (${entry.count}): ${entry.reason}`).join('\n')}\n`
    : '')
  writeFileSync(join(dir, 'allowlist-unused.txt'), unused.length
    ? `${unused.map((entry) => `${entry.file}: ${entry.rule}: ${entry.reason}`).join('\n')}\n`
    : '')
  writeFileSync(join(dir, 'image-symlinks.txt'), external.length
    ? `${external.map((entry) => `${entry.kind}\t${entry.file} -> ${entry.target}`).join('\n')}\n`
    : '')
  writeFileSync(join(dir, 'image.txt'), `${image ?? 'rootfs'}\n`)
}

function topLevel(entries) {
  const counts = new Map()
  for (const entry of entries) {
    const top = entry.file.split('/')[0]
    counts.set(top, (counts.get(top) ?? 0) + 1)
  }
  return [...counts].sort(([a], [b]) => a.localeCompare(b))
}

function report({ image, layers, blobs, entries, hits, allowed, unused, bytes, external }, inventory) {
  const files = entries.filter((entry) => entry.kind === 'file').length
  const symlinkCount = entries.filter((entry) => entry.kind === 'symlink').length
  const dirs = entries.filter((entry) => entry.kind === 'dir').length
  console.log(`[secrecy] ${image ?? 'rootfs'}`)
  if (layers) console.log(`[secrecy] layers: ${layers.length} RootFS, ${blobs?.length ?? 0} save-manifest blobs`)
  console.log(`[secrecy] files: ${files} (${mb(bytes)}), symlinks: ${symlinkCount} (${external.length} external/dangling), directories: ${dirs}`)
  console.log(`[secrecy] top-level: ${topLevel(entries).map(([name, count]) => `${name} ${count}`).join(', ')}`)
  console.log(`[secrecy] inventory: ${join(inventory, 'image-files.txt')}, layers: ${join(inventory, 'image-layers.txt')}, allowlist: ${join(inventory, 'allowlist-used.txt')}`)
  if (unused.length) console.warn(`[secrecy] warning: ${unused.length} allowlist entry(s) did not match; see ${join(inventory, 'allowlist-unused.txt')}`)
  for (const entry of allowed) console.log(`[secrecy] allowed: ${entry.file} ${entry.rule} (${entry.count}): ${entry.reason}`)
  if (hits.length) {
    for (const hit of hits) {
      console.error(`${hit.file}:${hit.line}: ${hit.rule}: ${hit.match}`)
    }
    console.error(`[secrecy] ${hits.length} finding(s): the image must not be pushed`)
    return false
  }
  console.log(`[secrecy] clean: 0 findings, ${allowed.length} exact allowlist hit(s), ${unused.length} unused`)
  return true
}

function summary({ image, layers, entries, hits, allowed, unused, external }, inventory, clean) {
  const target = process.env.GITHUB_STEP_SUMMARY
  if (!target) return
  const files = entries.filter((entry) => entry.kind === 'file').length
  const lines = [
    '### Server image secrecy',
    '',
    `- image: \`${image ?? 'rootfs'}\``,
    `- layers: ${layers?.length ?? 0}`,
    `- files checked: ${files}`,
    `- exact allowlist: ${allowed.length} used, ${unused.length} unused (\`${join(inventory, 'allowlist-used.txt')}\`)`,
    `- external/dangling symlinks: ${external.length}`,
    `- inventory: \`${join(inventory, 'image-files.txt')}\``,
    `- result: ${clean ? 'clean' : `${hits.length} finding(s)`}`,
    '',
  ]
  writeFileSync(target, `${lines.join('\n')}`, { flag: 'a' })
}

function argsOf(argv) {
  const args = { inventory: 'secrecy', keep: false }
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index]
    if (name === '--keep') { args.keep = true; continue }
    if (!name.startsWith('--')) { args.image = name; continue }
    const value = argv[index + 1]
    if (value === undefined) throw new Error(`${name} needs a value`)
    args[name.slice(2)] = value
    index += 1
  }
  return args
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let extracted
  try {
    const args = argsOf(process.argv.slice(2))
    if (args.repo) {
      const { hits, checked } = scanRepo(resolve(args.repo))
      for (const hit of hits) console.error(`${hit.file}:${hit.line}: ${hit.rule}: ${hit.match}`)
      if (hits.length) throw new Error(`${hits.length} Stripe value(s) in the repository: no key, price or account id is written here`)
      console.log(`[secrecy] repository clean: ${checked} tracked text files, no Stripe key, price or account id`)
      process.exit(0)
    }
    if (!args.rootfs && !args.image) throw new Error(usage)
    const list = JSON.parse(readFileSync(LIST, 'utf8'))
    const denied = denyMatcher(list.deny)
    let image = args.image
    let rootfs = args.rootfs
    let layers
    let blobs
    if (!rootfs) {
      extracted = extractImage(image)
      rootfs = extracted.rootfs
      layers = extracted.layers
      blobs = extracted.blobs
    }
    const tree = scanTree(rootfs, list)
    if (image) tree.hits.push(...scanImageConfig(image, list, denied))
    writeInventory(args.inventory, { image, layers, blobs, ...tree })
    const clean = report({ image, layers, blobs, ...tree }, args.inventory)
    summary({ image, layers, ...tree }, args.inventory, clean)
    if (!clean) process.exitCode = 1
    if (extracted && !args.keep) rmSync(extracted.work, { recursive: true, force: true })
    else if (extracted) console.log(`[secrecy] kept the export at ${extracted.work}`)
  } catch (error) {
    if (extracted && !process.argv.includes('--keep')) rmSync(extracted.work, { recursive: true, force: true })
    console.error(`[secrecy] FAILED: ${error?.message ?? error}`)
    process.exitCode = 1
  }
}
