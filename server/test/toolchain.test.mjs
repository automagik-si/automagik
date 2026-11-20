import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  HC_RUNTIME, HC_SESSION, HERDR_APP_HOME, HERDR_CORE_SHA256, HERDR_CORE_SOCKET,
  HERDR_CORE_VERSION, PNPM_PATH, TINI_LICENSE_SHA256, TINI_PATH, TINI_SHA256, TINI_URL,
  TINI_VERSION, XDG_RUNTIME_DIR, herdrCoreSocket, onSharedVolume, toolchainChildEnv,
} from '../toolchain.mjs'
import { tmpdir } from 'node:os'
import { BOT_CLI_POINTER_ENV, NATIVE_WORKER_LOGIN_ENV } from '../native-worker-login.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const dockerfile = readFileSync(join(ROOT, 'server/Dockerfile'), 'utf8')

test('the Dockerfile defaults match the pinned toolchain constants', () => {
  assert.match(dockerfile, new RegExp(`^ARG HERDR_CORE_VERSION=${HERDR_CORE_VERSION}$`, 'm'))
  assert.match(dockerfile, new RegExp(`^ARG HERDR_CORE_SHA256=${HERDR_CORE_SHA256}$`, 'm'))
  assert.match(dockerfile, new RegExp(`AUTOMAGIK_PNPM=${PNPM_PATH}`))
})

test('the image sets the Arca app home, runtime and session; the socket derives from the session', () => {
  assert.match(dockerfile, new RegExp(`HERDR_APP_HOME=${HERDR_APP_HOME}`))
  assert.doesNotMatch(dockerfile, /HC_TERMINAL_SOCKET=/)
  assert.match(dockerfile, new RegExp(`XDG_RUNTIME_DIR=${XDG_RUNTIME_DIR}`))
  assert.match(dockerfile, new RegExp(`HC_RUNTIME=${HC_RUNTIME}`))
  assert.match(dockerfile, new RegExp(`HC_SESSION=${HC_SESSION}`))
  assert.equal(HERDR_CORE_SOCKET, herdrCoreSocket())
  assert.equal(herdrCoreSocket('other-session'), `${HC_RUNTIME}/other-session.sock`)
})

test('every shipped pnpm entry is wrapped by the one admission script', () => {
  assert.match(dockerfile, /^RUN node \/build\/server\/install-pnpm-admission\.mjs \/build\/out$/m)
  assert.match(dockerfile, /^COPY --from=builder \/build\/out\/pnpm-admission\.json \/opt\/automagik\/pnpm-admission\.json$/m)
  assert.match(dockerfile, /^COPY --chmod=0755 server\/bin\/dsh server\/bin\/pnpm server\/bin\/pnpm-admission server\/bin\/am \/usr\/local\/bin\/$/m)
})

test('the image runs the app under a pinned tini so it is never PID 1', () => {
  assert.match(dockerfile, new RegExp(`^ARG TINI_VERSION=${TINI_VERSION}$`, 'm'))
  assert.match(dockerfile, new RegExp(`^ARG TINI_SHA256=${TINI_SHA256}$`, 'm'))
  assert.ok(TINI_URL.endsWith(`/v${TINI_VERSION}/tini-static`))
  assert.match(dockerfile, /curl -fsSL --proto '=https' -o \/tmp\/tini-static/)
  assert.match(dockerfile, /echo "\$\{TINI_SHA256\}  \/tmp\/tini-static" \| sha256sum -c -/)
  assert.match(dockerfile, new RegExp(`^COPY --from=tools /out/bin/tini ${TINI_PATH}$`, 'm'))
  assert.match(dockerfile, /^STOPSIGNAL SIGTERM$/m)
  assert.match(dockerfile, /^ENTRYPOINT \["\/usr\/local\/bin\/tini", "--", "\/nodejs\/bin\/node", "\/opt\/automagik\/entrypoint\.mjs"\]$/m)
})

test('the tools stage checks the pinned tini license after downloading it', () => {
  assert.match(dockerfile, new RegExp(`^ARG TINI_LICENSE_SHA256=${TINI_LICENSE_SHA256}$`, 'm'))
  const licenseDownload = dockerfile.indexOf('/krallin/tini/v${TINI_VERSION}/LICENSE')
  const licenseCheck = 'echo "${TINI_LICENSE_SHA256}  /out/licenses/tini/LICENSE" | sha256sum -c -'
  assert.ok(licenseDownload > 0)
  const following = dockerfile.slice(licenseDownload).split('\n')[1]
  assert.ok(following.trim().startsWith(licenseCheck))
})

test('the runtime delivers env and printenv for am launch paths and shebangs', () => {
  assert.match(dockerfile, /for f in .*\/usr\/bin\/env .*\/usr\/bin\/printenv /)
  assert.match(dockerfile, /cp .*\/usr\/bin\/env .*\/usr\/bin\/printenv .*\/out\/bin\//)
  assert.match(dockerfile, /^COPY --from=tools \/out\/bin\/env \/usr\/bin\/env$/m)
  assert.match(dockerfile, /^COPY --from=tools \/out\/bin\/printenv \/usr\/bin\/printenv$/m)
})

test('the final image carries both hc and herdr-core at literal paths', () => {
  assert.match(dockerfile, /^COPY --from=tools \/out\/bin\/herdr-core \/usr\/local\/bin\/herdr-core$/m)
  assert.match(dockerfile, /^COPY --from=tools \/out\/bin\/hc \/usr\/local\/bin\/hc$/m)
  assert.match(dockerfile, /\/out\/bin\/hc --version \| grep -qx "hc \$\{HERDR_CORE_VERSION\}"/)
})

test('the final image carries am from the fetched release tarball and its command shim', () => {
  assert.match(dockerfile, /^COPY --from=builder \/build\/out\/am \/opt\/automagik\/am$/m)
  assert.match(dockerfile, /^COPY --chmod=0755 server\/bin\/dsh server\/bin\/pnpm server\/bin\/pnpm-admission server\/bin\/am \/usr\/local\/bin\/$/m)
  assert.doesNotMatch(dockerfile, /COPY .*automagik-am-.*\.tgz/)
})

test('the first-boot hook and the in-image smoke are inside the image', () => {
  for (const file of ['first-boot.mjs', 'cli-store.mjs', 'in-image-smoke.mjs', 'toolchain.mjs']) {
    assert.match(dockerfile, new RegExp(`server/${file.replace('.', '\\.')}`), `${file} is copied into the runtime`)
  }
})

test('the core and am children keep the native worker login variables, and no key', () => {
  const env = toolchainChildEnv({
    [BOT_CLI_POINTER_ENV]: '/data/acp/cli-homes/current/claude', [NATIVE_WORKER_LOGIN_ENV]: 'required',
    DEEPSEEK_API_KEY: 'test-only', PATH: '/usr/bin',
  })
  assert.deepEqual(env, {
    [BOT_CLI_POINTER_ENV]: '/data/acp/cli-homes/current/claude', [NATIVE_WORKER_LOGIN_ENV]: 'required', PATH: '/usr/bin',
  })
})

test('a runtime directory that resolves into the shared volume is refused, symlink included', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'shared-volume-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const volume = join(root, 'data'), outside = join(root, 'run'), link = join(root, 'run-link')
  mkdirSync(join(volume, 'run'), { recursive: true }); mkdirSync(outside)
  symlinkSync(join(volume, 'run'), link)
  assert.equal(onSharedVolume(join(volume, 'run'), volume), true)
  assert.equal(onSharedVolume(link, volume), true, 'a symlink into the volume')
  assert.equal(onSharedVolume(join(link, 'herdr-core'), volume), true, 'a path under such a symlink')
  assert.equal(onSharedVolume(outside, volume), false)
  assert.equal(onSharedVolume(`${volume}-other`, volume), false, 'a sibling with the same prefix')
})
