# Security

## Report a vulnerability

1. Open **Security → Report a vulnerability** on this repository (GitHub private vulnerability reporting).
2. Describe what an attacker can do, the steps, and the app version (**Settings → About**).

Please don't open a public issue for a vulnerability.

## Check that an APK is ours

Every release is signed with one key. Its certificate's SHA-256 fingerprint:

```
59:2D:CE:D9:09:10:7A:B4:3E:7E:41:74:2C:92:7B:22:F6:8C:A7:83:25:CD:86:54:F3:80:D3:58:43:0F:91:83
```

Check a download before installing it:

```sh
apksigner verify --print-certs automagik-pocket-<version>.apk   # "Signer #1 certificate SHA-256 digest" must match
```

The app installs an update only when its SHA-256 matches `latest.json` (on the `pocket-lane` release; builds up to v0.23.0 were `automagik.apk`), and Android installs it only when it is signed with this same key.

## What the app can reach

- **Your machines:** over Pocket Link only (iroh, end-to-end encrypted, no open port). The app no longer connects over SSH; it deletes the SSH key an older version stored once no machine saved over SSH is left ([RFC 0008](docs/rfcs/0008-drop-ssh.md)).
  The phone's Pocket Link key stays in app storage that Android never backs up. The app encrypts
  it with an AES key held in Android Keystore that cannot be exported. The app decrypts the
  Pocket Link key into memory to connect. On the first start after updating, the app wraps an
  older plain key and deletes the plain copy once the encrypted copy is safely written and
  verified. If the encrypted copy can't be written or read, the existing plain key stays in that
  storage and the app retries wrapping it on each start. The app keeps a new key plain in the same
  storage if Keystore is unavailable or sealing fails before the encrypted file is put in place.
  It retries wrapping that key on each start.
- **Typing into agents:** only what you send, from the app, a notification's Reply, or its Yes/No and option buttons. A button re-reads the agent's screen first and does nothing if the question changed.
- **Lock screen:** with the app lock off, answering from the lock screen is off by default (**Settings → Alerts**). If you allow it, anyone holding your locked phone can read what an agent asks and answer it.
- **App lock:** turn on **Settings → Alerts → Lock Automagik** to require Android authentication
  at startup and after 60 seconds off screen. Alerts are generic and answers happen in the app.
  Recents hides app thumbnails. On API 26–32, the lock also blocks screenshots and screen sharing.
  [RFC 0010](docs/rfcs/0010-app-lock.md)
- **Microphone:** only while you dictate in the side-button panel.
