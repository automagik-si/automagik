// Whose account the app may use (#869). A CLI signed in on this computer is one sign-in per OS
// user, shared with the person's terminal: Automagik uses it for chats, images and the welcome
// only after the person said so, once per vendor and per account. This module is that record.
//
// Per vendor (`acp-claude`, `acp-codex`) the file keeps:
//   consent  'given'    the person confirmed this account, or signed in to it from the app;
//            'carried'  the vendor was already signed in when an install made by an earlier
//                       version first ran this one: it keeps working, and a notice says so once;
//   account  HMAC-SHA256 digests of what names the account (its kind, email, organisation id,
//            key source: account.js `facets`), one per facet, keyed by `key`, a random value
//            made for this install. Never an email, an organisation, a token or a key;
//   carry    true while a vendor an earlier version already offered has not been read signed
//            in yet. The mark stays through every other answer: a check that says "signed out"
//            may be a failed read (a CLI that cannot load its config exits as signed out, a
//            locked keychain, another environment), and a Bot that worked before the upgrade
//            must not go silent for it. The first signed-in read makes it `carried`;
//   noticed  the one-time notice of a carried vendor was shown.
//
// What a read means (`note`):
//   signed out or not known            no state: the sign-in check alone decides, as before,
//                                      and the record (a `carry` mark too) stays as it is;
//   signed in, no record               `needed`, unless the vendor is still marked `carry`;
//   signed in, account not readable    the record stands. An unreadable account never turns a
//                                      consented vendor into `needed`; a facet the record does
//                                      not have yet is taken from the first read that has it;
//   signed in, another account         `needed`, until the person confirms that account: a
//                                      facet both the record and the read have differs. A facet
//                                      only one of them has says nothing (a CLI release that
//                                      starts or stops printing a field is not another account).
//                                      The record stays: the first account coming back needs
//                                      nothing.
//
// The file is written the first time there is something to keep, and always before this
// version installs a connector (`settle`), so a connector found installed with no file can only
// come from an earlier version. An unreadable file is read as that same first run. A version
// that does not know the file ignores it.
//
// Several DSH processes may share one Automagik home (install.js), so the file is never written
// from memory alone: before each read (`note`) and each write (`save`) it is read again, and
// only the vendors this process changed since its last write are its own; every other vendor
// takes what is on disk. A file another process created meanwhile gives its key, and a digest
// made under the key this process had goes (the next read of the account records it again).
import { createHmac, randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

export const CONSENT_FILE = 'accounts.json'
const DIGEST = /^[A-Za-z0-9_-]{20,64}$/
const FACET = /^[a-z]{1,16}$/
const KEY = /^[A-Za-z0-9_-]{32,128}$/
const STATES = new Set(['given', 'carried'])

// Another account: a facet both sides have, with another digest.
const differs = (stored, seen) => stored !== undefined && seen !== undefined && Object.keys(seen).some(facet => stored[facet] !== undefined && stored[facet] !== seen[facet])

export class ConsentStore {
  /**
   * @param {object} options
   * @param {string} options.file where the record is kept
   * @param {string[]} options.ids the vendors
   * @param {(id: string) => boolean} [options.earlier] whether an earlier version already offered this vendor
   * @param {() => number} [options.now]
   * @param {(message: string) => void} [options.log]
   */
  constructor({ file, ids, earlier = () => false, now = Date.now, log = () => {} }) {
    this.file = file
    this.ids = [...ids]
    this.now = now
    this.log = log
    this.saved = false
    this.vendors = {}
    // The vendors this process changed since its last write.
    this.dirty = new Set()
    const stored = this.read()
    if (stored !== undefined) {
      this.key = stored.key
      this.rest = stored.rest
      this.vendors = stored.vendors
      this.saved = true
      return
    }
    this.key = randomBytes(32).toString('base64url')
    this.rest = {}
    for (const id of this.ids) {
      let before = false
      try { before = earlier(id) === true } catch {}
      if (before) this.vendors[id] = { carry: true }
    }
  }

  read({ quiet = false } = {}) {
    let text
    try { text = readFileSync(this.file, 'utf8') } catch { return undefined }
    let doc
    try { doc = JSON.parse(text) } catch {}
    if (doc === null || typeof doc !== 'object' || Array.isArray(doc) || typeof doc.key !== 'string' || !KEY.test(doc.key)) {
      if (!quiet) this.log('the account record could not be read; it starts again')
      return undefined
    }
    const { key, vendors: listed, ...rest } = doc
    const vendors = {}
    for (const id of this.ids) {
      const row = listed !== null && typeof listed === 'object' ? listed[id] : undefined
      if (row === null || typeof row !== 'object' || Array.isArray(row)) continue
      const record = {}
      if (STATES.has(row.consent)) record.consent = row.consent
      else if (row.carry === true) record.carry = true
      if (record.consent !== undefined) {
        const digests = row.account !== null && typeof row.account === 'object' && !Array.isArray(row.account)
          ? Object.fromEntries(Object.entries(row.account).filter(([facet, digest]) => FACET.test(facet) && typeof digest === 'string' && DIGEST.test(digest)))
          : {}
        if (Object.keys(digests).length > 0) record.account = digests
        if (Number.isFinite(row.at)) record.at = row.at
        if (row.noticed === true) record.noticed = true
      }
      if (Object.keys(record).length > 0) vendors[id] = record
    }
    return { key, vendors, rest }
  }

  /**
   * Takes what another process wrote since this one last read the file: its key, the fields
   * this version does not know, and the record of every vendor this process has not changed.
   * A file that is missing or unreadable changes nothing.
   */
  sync() {
    const disk = this.read({ quiet: true })
    if (disk === undefined) return
    if (disk.key !== this.key) {
      this.key = disk.key
      // Made under the key this process had: they would never match again.
      for (const id of this.dirty) delete this.vendors[id]?.account
    }
    this.rest = disk.rest
    for (const id of this.ids) {
      if (this.dirty.has(id)) continue
      if (disk.vendors[id] !== undefined) this.vendors[id] = disk.vendors[id]
    }
    this.saved = true
  }

  save() {
    this.sync()
    try {
      mkdirSync(dirname(this.file), { recursive: true })
      const tmp = `${this.file}.${process.pid}.tmp`
      writeFileSync(tmp, `${JSON.stringify({ ...this.rest, version: 1, key: this.key, vendors: this.vendors }, null, 2)}\n`, { mode: 0o600 })
      renameSync(tmp, this.file)
      this.saved = true
      this.saveError = undefined
      this.dirty.clear()
    } catch (error) {
      // Why the last write failed, for whoever waits on the record (index.js): the code only.
      this.saveError = typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]{1,31}$/.test(error.code) ? error.code : 'error'
      // Kept in memory for this run; the next change tries again.
      this.log(`the account record was not saved: ${error?.code ?? 'error'}`)
    }
  }

  /** Writes the first-run record if it is not on disk yet. Called before a connector install. */
  settle() {
    if (!this.saved) this.save()
  }

  /** The digest of a value under this install's key. */
  digest(id) {
    return createHmac('sha256', this.key).update(String(id)).digest('base64url')
  }

  /** The digests of what names an account, one per facet, or undefined when nothing does. */
  digests(account) {
    const facets = account?.facets
    if (facets === null || typeof facets !== 'object') return undefined
    const entries = Object.entries(facets).filter(([facet, value]) => FACET.test(facet) && typeof value === 'string' && value !== '')
    return entries.length === 0 ? undefined : Object.fromEntries(entries.map(([facet, value]) => [facet, this.digest(`${facet}\n${value}`)]))
  }

  /**
   * Whether a read names the account the record holds (#2064): a naming facet both have, none
   * that differs. A Claude account needs its email on both sides (its org alone, or a key's
   * source, never says it is the same person's account).
   */
  sameAccount(id, account) {
    if (!this.ids.includes(id)) return false
    this.sync()
    const stored = this.vendors[id]?.account
    const seen = this.digests(account)
    if (stored === undefined || seen === undefined || differs(stored, seen)) return false
    if (id === 'acp-claude' && (stored.email === undefined || seen.email === undefined)) return false
    return Object.keys(seen).some(facet => facet !== 'kind' && stored[facet] !== undefined)
  }

  /**
   * What a fresh read of a vendor means: 'given', 'carried', 'needed', or undefined when the
   * vendor is not (known to be) signed in.
   * @param {string} id
   * @param {boolean | undefined} signedIn
   * @param {{ id: string } | undefined} account
   */
  note(id, signedIn, account) {
    if (!this.ids.includes(id)) return undefined
    if (signedIn === false) {
      // "Signed out" may be a read that failed: a `carry` mark waits for a signed-in read.
      this.settle()
      return undefined
    }
    if (signedIn !== true) return undefined
    this.sync()
    const record = this.vendors[id]
    const seen = this.digests(account)
    if (record?.consent === undefined) {
      if (record?.carry !== true) {
        this.settle()
        return 'needed'
      }
      this.vendors[id] = { consent: 'carried', at: this.now(), ...(seen === undefined ? {} : { account: seen }) }
      this.dirty.add(id)
      this.save()
      return 'carried'
    }
    if (seen === undefined) return record.consent
    if (differs(record.account, seen)) return 'needed'
    // Recorded once per facet, as soon as the CLI says it.
    if (Object.keys(seen).some(facet => record.account?.[facet] === undefined)) {
      record.account = { ...seen, ...record.account }
      this.dirty.add(id)
      this.save()
    }
    return record.consent
  }

  /** The person's word for the account signed in now. */
  confirm(id, account) {
    if (!this.ids.includes(id)) return
    // First, so the digests are made under the key the file has.
    this.sync()
    const seen = this.digests(account)
    this.vendors[id] = { consent: 'given', at: this.now(), ...(seen === undefined ? {} : { account: seen }) }
    this.dirty.add(id)
    this.save()
  }

  /**
   * What a native session is bound to for this vendor's account (continuity.js): a digest of the
   * account the person confirmed (or that was carried), or undefined when there is no word for
   * an account that names itself. Never the account's facets: only their digests, digested again.
   */
  accountKey(id) {
    if (!this.ids.includes(id)) return undefined
    this.sync()
    const record = this.vendors[id]
    if (!STATES.has(record?.consent) || record.account === undefined || Object.keys(record.account).length === 0) return undefined
    const facets = Object.keys(record.account).sort().map(facet => [facet, record.account[facet]])
    return createHmac('sha256', this.key).update(`account\n${JSON.stringify(facets)}`).digest('base64url')
  }

  /** A fresh home generation has no inherited word for the previous Bot account. */
  forget(id) {
    if (!this.ids.includes(id)) return
    this.sync()
    delete this.vendors[id]
    this.dirty.add(id)
    this.save()
  }

  /** Whether a carried vendor's one-time notice is still to be shown. */
  noticePending(id) {
    const record = this.vendors[id]
    return record?.consent === 'carried' && record.noticed !== true
  }

  /** The one-time notice of a carried vendor was shown. */
  noticed(id) {
    this.sync()
    const record = this.vendors[id]
    if (record?.consent !== 'carried' || record.noticed === true) return
    record.noticed = true
    this.dirty.add(id)
    this.save()
  }
}
