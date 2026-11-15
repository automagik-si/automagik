import { redactText } from './redact.js'

// What may be kept of SSH's or Hermes's own words: no token or nonce of this connection,
// no credential shape, no key material, and no path that names a home folder (its user)
// or a file in the SSH folder (a key's name). One rule for both paths that show those
// words: SSH's own diagnostics and a remote Hermes failure reason.
export function redactSshText(text, secrets = []) {
  let out = String(text ?? '').replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/[\x00-\x08\x0b-\x1f\x7f]/g, ' ')
  for (const secret of secrets) if (typeof secret === 'string' && secret.length >= 8) out = out.split(secret).join('[hidden]')
  out = redactText(out)
    .replace(/-----BEGIN [A-Z0-9 ]+-----[\s\S]*?(?:-----END [A-Z0-9 ]+-----|$)/g, '[key]')
    .replace(/\b(?:ssh-(?:ed25519|rsa|dss)|ecdsa-sha2-[a-z0-9-]+|sk-[a-z0-9-]+@openssh\.com)\s+AAAA[A-Za-z0-9+/=]+/g, '[key]')
    // A socket address names its credential in the query; `token=` is already gone above.
    .replace(/([?&](?:ticket|internal)=)[^&#\s"'<>]+/gi, '$1[hidden]')
    .replace(/\b(SHA256|MD5):[A-Za-z0-9+/:=_-]{16,}/g, '$1:[hidden]')
    .replace(/\b[0-9a-fA-F]{32,}\b/g, '[hidden]')
    .replace(/[A-Za-z0-9+/_=-]{40,}/g, '[hidden]')
    .replace(/(?:\/home|\/Users|\/export\/home)\/[^/\s'":;,)]+|\/root(?=[/\s'":;,)]|$)|\b[A-Za-z]:\\Users\\[^\\\s'":;,)]+/g, '~')
    // Under ~/.ssh only the two standard names stay: a key file's name can say whose it is.
    .replace(/~[/\\]\.ssh[/\\](?!(?:known_hosts2?|config)(?=[\s'":;,)]|$))[^\s'":;,)]+/g, '~/.ssh/[hidden]')
  return out
}
