import { redactText } from './redact.js'

// What may be kept of SSH's or Hermes's own words: no token or nonce of this connection,
// no credential shape, no key material, and no path that names a home folder (its user)
// or a file in the SSH folder (a key's name). One rule for both paths that show those
// words: SSH's own diagnostics and a remote Hermes failure reason.
export function redactSshText(text, secrets = []) {
  let out = String(text ?? '').replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/[\x00-\x08\x0b-\x1f\x7f]/g, ' ')
  // The connection's own value in its plain spelling, and in the encodings a diagnostic or a
  // URL can put it in, plus a spelling broken across lines. Short values are left alone: they
  // are indistinguishable from ordinary text, and the exact value is still removed.
  const forms = []
  for (const secret of secrets) {
    if (typeof secret !== 'string' || secret.length < 8) continue
    const encodings = [secret]
    try { encodings.push(encodeURIComponent(secret)) } catch { /* a lone surrogate has no URL form */ }
    encodings.push(JSON.stringify(secret).slice(1, -1))
    const bytes = Buffer.from(secret, 'utf8')
    encodings.push(bytes.toString('base64'), bytes.toString('base64url'), bytes.toString('hex'))
    for (const form of new Set(encodings)) {
      forms.push(form)
      if (form.length >= 12 && form.length <= 128) {
        forms.push(new RegExp(form.split('').map(char => char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s*'), 'g'))
      }
    }
  }
  for (const form of forms) out = typeof form === 'string' ? out.split(form).join('[hidden]') : out.replace(form, '[hidden]')
  out = redactText(out)
    .replace(/-----BEGIN [A-Z0-9 ]+-----[\s\S]*?(?:-----END [A-Z0-9 ]+-----|$)/g, '[key]')
    .replace(/\b(?:ssh-(?:ed25519|rsa|dss)|ecdsa-sha2-[a-z0-9-]+|sk-[a-z0-9-]+@openssh\.com)\s+AAAA[A-Za-z0-9+/=]+/g, '[key]')
    // A socket address names its credential in the query; `token=` is already gone above.
    .replace(/([?&](?:ticket|internal)=)[^&#\s"'<>]+/gi, '$1[hidden]')
    .replace(/\b(SHA256|MD5):[A-Za-z0-9+/:=_-]{16,}/g, '$1:[hidden]')
    .replace(/\b[0-9a-fA-F]{32,}\b/g, '[hidden]')
    .replace(/[A-Za-z0-9+/_=-]{40,}/g, '[hidden]')
    // An opaque token below the long-run rule, still too long and mixed to be prose.
    .replace(/\b(?=[A-Za-z0-9+/_=-]*\d)(?=[A-Za-z0-9+/_=-]*[A-Za-z])[A-Za-z0-9+/_=-]{24,}\b/g, '[hidden]')
    // Encoded and escaped spellings of a home folder, and a folder named by user.
    .replace(/(?:%2F|%2f)(?:home|Users|export)(?:(?:%2F|%2f)[^%\s'":;,)]*)+/gi, '~')
    .replace(/(?:\\\/)(?:home|Users|export)(?:(?:\\\/)[^\\\s'":;,)]*)+/g, '~')
    .replace(/\\\\Users\\\\[^\\\s'":;,)]+/g, '~')
    .replace(/\B~[A-Za-z0-9._-]+(?=[/\\])/g, '~')
    .replace(/(?:\/home|\/Users|\/export\/home)\/[^/\s'":;,)]+|\/root(?=[/\s'":;,)]|$)|\b[A-Za-z]:\\Users\\[^\\\s'":;,)]+/g, '~')
    // Under ~/.ssh only the two standard names stay: a key file's name can say whose it is.
    .replace(/~[/\\]\.ssh[/\\](?!(?:known_hosts2?|config)(?=[\s'":;,)]|$))[^\s'":;,)]+/g, '~/.ssh/[hidden]')
  return out
}
