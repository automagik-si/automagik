import { createDecipheriv, createDiffieHellman, hkdfSync } from 'node:crypto'

export const algorithm = 'dh-ietf1024-sha256-aes128-cbc-pkcs7'
// RFC 2409, second Oakley group. Electron may omit the modp2 named group.
const prime = Buffer.from(
  'ffffffffffffffffc90fdaa22168c234c4c6628b80dc1cd129024e088a67cc74'
  + '020bbea63b139b22514a08798e3404ddef9519b3cd3a431b302b0a6df25f1437'
  + '4fe1356d6d51c245e485b576625e7ec6f44c42e9a637ed6b0bff5cb6f406b7ed'
  + 'ee386bfb5a899fa5ae9f24117c4b1fe649286651ece65381ffffffffffffffff', 'hex')
const empty = Buffer.alloc(0)

export function sessionKey(shared) {
  if (shared.length === 0 || shared.length > prime.length) throw new Error('Invalid session key.')
  const padded = Buffer.alloc(prime.length)
  shared.copy(padded, padded.length - shared.length)
  try { return Buffer.from(hkdfSync('sha256', padded, empty, empty, 16)) }
  finally { padded.fill(0) }
}

export function exchange() {
  const dh = createDiffieHellman(prime, 2)
  const publicKey = dh.generateKeys()
  return {
    publicKey,
    key(peer) {
      if (peer.length === 0 || peer.length > prime.length) throw new Error('Invalid public key.')
      const shared = dh.computeSecret(peer)
      try { return sessionKey(shared) }
      finally { shared.fill(0) }
    },
  }
}

export function decrypt(key, iv, encrypted) {
  if (iv.length !== 16 || encrypted.length === 0 || encrypted.length % 16 !== 0) throw new Error('Invalid encrypted secret.')
  const decipher = createDecipheriv('aes-128-cbc', key, iv)
  const prefix = decipher.update(encrypted)
  let tail
  try {
    tail = decipher.final()
    return Buffer.concat([prefix, tail])
  } finally {
    prefix.fill(0)
    tail?.fill(0)
  }
}
