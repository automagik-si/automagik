import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test, { after } from 'node:test'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const temps = []
after(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true })
})

// The tag names the content release and the tree that built it; the version label is the
// content the plugins come from and the revision label is the full workflow commit. Both
// must reach the docker build command, and the Dockerfile must put them on the image.
test('the content version and the full revision reach the docker build and its labels', () => {
  const dir = mkdtempSync(join(tmpdir(), 'automagik-build-test-'))
  temps.push(dir)
  const log = join(dir, 'docker.log')
  const fake = join(dir, 'docker')
  writeFileSync(fake, `#!/bin/sh
printf '%s\\n' "$*" >> "$DOCKER_LOG"
if [ "$1 $2" = "image inspect" ]; then printf '123\\n'; fi
`)
  chmodSync(fake, 0o755)

  const revision = '29600dc1c62b584adec8446ff76944675e351926'
  execFileSync(process.execPath, [
    'server/build.mjs',
    '--tag', 'automagik-server:3.93.0-29600dc1',
    '--version', '3.93.0',
    '--image-version', '3.93.0',
    '--revision', revision,
  ], { cwd: ROOT, env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, DOCKER_LOG: log } })

  const build = readFileSync(log, 'utf8').split('\n').find((line) => line.startsWith('build '))
  assert.ok(build, 'server/build.mjs invokes docker build')
  assert.match(build, /--tag automagik-server:3\.93\.0-29600dc1(?: |$)/)
  assert.match(build, /--build-arg AUTOMAGIK_VERSION=3\.93\.0(?: |$)/)
  assert.match(build, /--build-arg IMAGE_VERSION=3\.93\.0(?: |$)/)
  assert.match(build, new RegExp(`--build-arg IMAGE_REVISION=${revision}(?: |$)`))

  const dockerfile = readFileSync(join(ROOT, 'server/Dockerfile'), 'utf8')
  assert.match(dockerfile, /^ARG IMAGE_VERSION=/m)
  assert.match(dockerfile, /^ARG IMAGE_REVISION=/m)
  assert.match(dockerfile, /org\.opencontainers\.image\.version="\$\{IMAGE_VERSION\}"/)
  assert.match(dockerfile, /org\.opencontainers\.image\.revision="\$\{IMAGE_REVISION\}"/)
})

// The distroless Node binary ships with its DWARF sections (17.8 MB); the tools stage strips
// them before the rootfs reaches the runtime image, and the non-root user, the health check and
// the pinned digests stay.
test('the tools stage strips the Node debug symbols and keeps the image controls', () => {
  const dockerfile = readFileSync(join(ROOT, 'server/Dockerfile'), 'utf8')
  assert.match(dockerfile, /strip --strip-all \/out\/rootfs\/nodejs\/bin\/node/)
  assert.match(dockerfile, /apt-get install -y --no-install-recommends [^\n]*binutils/)
  assert.match(dockerfile, /^USER 1000:1000$/m)
  assert.match(dockerfile, /^HEALTHCHECK --interval=30s /m)
  const bases = dockerfile.split('\n').filter((line) => line.startsWith('FROM ')).filter((line) => !line.includes('scratch'))
  for (const line of bases) assert.match(line, /@sha256:[0-9a-f]{64}\b/, line)
})
