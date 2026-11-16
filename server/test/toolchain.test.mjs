import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { HC_RUNTIME, HC_SESSION, HERDR_APP_HOME, HERDR_CORE_SHA256, HERDR_CORE_SOCKET, HERDR_CORE_VERSION, PNPM_PATH, TINI_PATH, TINI_SHA256, TINI_URL, TINI_VERSION, XDG_RUNTIME_DIR, herdrCoreSocket } from '../toolchain.mjs'

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

test('the runtime carries the per-vendor install child for bounded, serialized installs', () => {
  assert.match(dockerfile, /^COPY server\/entrypoint\.mjs .*server\/vendor-install\.mjs .*\/opt\/automagik\/$/m)
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
  assert.match(dockerfile, /^COPY --chmod=0755 server\/bin\/dsh server\/bin\/pnpm server\/bin\/am \/usr\/local\/bin\/$/m)
  assert.doesNotMatch(dockerfile, /COPY .*automagik-am-.*\.tgz/)
})

test('the reviewed skill is verified at build time and copied read-only', () => {
  assert.match(dockerfile, /RUN node \/build\/server\/verify-payload\.mjs/)
  assert.match(dockerfile, /^COPY server\/skills \/opt\/automagik\/skills$/m)
})

test('the published #1424 seed is copied into the image until the plugin carries it', () => {
  assert.match(dockerfile, /^COPY server\/vendor\/registry-seed \/opt\/automagik\/registry-seed$/m)
})

test('the first-boot hook and the in-image smoke are inside the image', () => {
  for (const file of ['first-boot.mjs', 'cli-store.mjs', 'in-image-smoke.mjs', 'toolchain.mjs']) {
    assert.match(dockerfile, new RegExp(`server/${file.replace('.', '\\.')}`), `${file} is copied into the runtime`)
  }
})
