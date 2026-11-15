import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test, { after } from 'node:test'
import { fileURLToPath } from 'node:url'
import { imageRecord, parseRecord, RECORD_ASSET } from '../image-record.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..', '..')
const SCRIPT = join(HERE, '..', 'image-record.mjs')
const temps = []
after(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true })
})

const revision = 'ab12'.repeat(10)
const digest = `sha256:${'0f'.repeat(32)}`
const good = { image: 'ghcr.io/automagik-si/automagik-server', digest, version: '3.93.0', revision, tag: `3.93.0-${revision.slice(0, 8)}` }
const run = (args) => {
  try {
    return { status: 0, stdout: execFileSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', stdio: 'pipe' }) }
  } catch (error) {
    return { status: error.status, stderr: String(error.stderr) }
  }
}

test('the record pins the image by the pushed digest, never by a tag', () => {
  const record = imageRecord(good)
  assert.deepEqual(record, { schema: 1, ...good, ref: `${good.image}@${digest}`, image: good.image })
  assert.deepEqual(Object.keys(record), ['schema', 'image', 'digest', 'ref', 'version', 'revision', 'tag'])
  assert.ok(!record.ref.includes(':latest'))
  assert.deepEqual(parseRecord(JSON.stringify(record)), record)
  const pre = { ...good, version: '3.94.0-rc.1', tag: `3.94.0-rc.1-${revision.slice(0, 8)}` }
  assert.equal(imageRecord(pre).version, '3.94.0-rc.1')
})

test('anything that is not what a push produced is refused', () => {
  const bad = [
    ['an empty digest', { digest: '' }, /digest/],
    ['a tag for a digest', { digest: 'latest' }, /digest/],
    ['a short digest', { digest: `sha256:${'0f'.repeat(31)}` }, /digest/],
    ['an uppercase digest', { digest: `sha256:${'0F'.repeat(32)}` }, /digest/],
    ['another algorithm', { digest: `sha512:${'0f'.repeat(32)}` }, /digest/],
    ['an image with a tag', { image: `${good.image}:latest` }, /image/],
    ['an image with a digest', { image: `${good.image}@${digest}` }, /image/],
    ['a bare image name', { image: 'automagik-server' }, /image/],
    ['a version with its v', { version: 'v3.93.0' }, /version/],
    ['a short revision', { revision: revision.slice(0, 8) }, /revision/],
    ['the latest tag', { tag: 'latest' }, /tag/],
    ['a tag of another commit', { tag: '3.93.0-00000000' }, /tag/],
    ['a tag of another release', { tag: `3.92.0-${revision.slice(0, 8)}` }, /tag/],
  ]
  for (const [label, change, message] of bad) assert.throws(() => imageRecord({ ...good, ...change }), message, label)
  assert.throws(() => imageRecord({}), /digest/)
  const record = imageRecord(good)
  assert.throws(() => parseRecord(JSON.stringify({ ...record, schema: 2 })), /schema/)
  assert.throws(() => parseRecord(JSON.stringify({ ...record, ref: `${good.image}:latest` })), /ref/)
  assert.throws(() => parseRecord('{'), SyntaxError)
})

test('the CLI writes the asset and checks the posted one against the pushed digest', () => {
  const dir = mkdtempSync(join(tmpdir(), 'automagik-image-record-'))
  temps.push(dir)
  const out = join(dir, RECORD_ASSET)
  const flags = ['--image', good.image, '--digest', digest, '--version', good.version, '--revision', revision, '--tag', good.tag]
  assert.equal(run(['write', ...flags, '--out', out]).status, 0)
  assert.deepEqual(JSON.parse(readFileSync(out, 'utf8')), imageRecord(good))
  assert.match(run(['check', out, '--digest', digest]).stdout, new RegExp(`records ${good.image}@${digest}`))

  const other = run(['check', out, '--digest', `sha256:${'1e'.repeat(32)}`])
  assert.equal(other.status, 1)
  assert.match(other.stderr, /not the pushed/)
  const empty = run(['write', ...flags.map((flag) => (flag === digest ? '' : flag)), '--out', join(dir, 'none.json')])
  assert.equal(empty.status, 1)
  assert.throws(() => readFileSync(join(dir, 'none.json')))
  assert.equal(run([]).status, 1)
  assert.equal(run(['check', join(dir, 'missing.json'), '--digest', digest]).status, 1)
})

// The workflow's wiring, read as text: the record is the release's own, on every pushing run.
const workflow = readFileSync(join(ROOT, '.github/workflows/server-image.yml'), 'utf8')
const readme = readFileSync(join(ROOT, 'server/README.md'), 'utf8')
const rfc = readFileSync(join(ROOT, 'docs/rfcs/0011-monorepo-parts-and-releases.md'), 'utf8')
const job = (name) => {
  const start = workflow.indexOf(`\n  ${name}:\n`)
  assert.notEqual(start, -1, name)
  const next = workflow.slice(start + 1).search(/\n  [a-z-]+:\n/)
  return workflow.slice(start, next === -1 ? undefined : start + 1 + next)
}

test('every run that pushes records the digest: a release and a dispatch alike', () => {
  const record = job('record')
  assert.match(record, /needs: \[image, publish\]/)
  // The same condition as the push itself, with no event filter of its own.
  assert.match(record, /\n    if: needs\.image\.outputs\.publish == 'true'\n/)
  assert.match(job('publish'), /\n    if: needs\.image\.outputs\.publish == 'true'\n/)
  assert.ok(!/github\.event_name/.test(record))
  // The digest is the push step's own output, and the record goes on the content release.
  assert.match(job('publish'), /outputs:\n      digest: \$\{\{ steps\.push\.outputs\.digest \}\}/)
  assert.match(record, /DIGEST: \$\{\{ needs\.publish\.outputs\.digest \}\}/)
  assert.match(record, /node server\/image-record\.mjs write --image "\$\{GHCR\}" --digest "\$\{DIGEST\}"/)
  assert.ok(record.includes(`gh release upload "v\${CONTENT}" ${RECORD_ASSET} --clobber`))
  assert.ok(record.includes(`gh release download "v\${CONTENT}" --pattern ${RECORD_ASSET}`))
  assert.match(record, /node server\/image-record\.mjs check posted\/server-image\.json --digest "\$\{DIGEST\}"/)
  // Both jobs name the same registry image.
  const ghcr = /GHCR: (\S+)/
  assert.equal(ghcr.exec(record)[1], ghcr.exec(job('publish'))[1])
})

test('only the record job may write to a release or attest; publish retains registry access', () => {
  assert.match(workflow, /\npermissions:\n  contents: read\n/)
  const record = job('record')
  assert.match(record, /permissions:\n      contents: write\n/)
  assert.ok(record.includes('packages: write'))
  assert.ok(record.includes('id-token: write'))
  assert.ok(record.includes('attestations: write'))
  assert.ok(record.includes('docker login'))
  const publish = job('publish')
  assert.match(publish, /permissions:\n      contents: read\n      packages: write\n/)
  assert.ok(!job('image').includes('permissions:'))
  assert.ok(!publish.includes('id-token:'))
  assert.ok(!publish.includes('attestations:'))
})

test("a desktop rebuild's asset sweep keeps the record", () => {
  const sweep = readFileSync(join(ROOT, '.github/workflows/desktop-build.yml'), 'utf8')
    .split('\n').find((line) => /case "\$\{name\}" in .*\) continue ;; esac/.test(line)) ?? ''
  const kept = /in (.*)\) continue/.exec(sweep)?.[1].split('|') ?? []
  assert.ok(kept.includes(RECORD_ASSET))
})

test('the record job attests the pushed digest keylessly; the lane job holds no OIDC or registry access', () => {
  const record = job('record')
  assert.match(record, /uses: actions\/attest-build-provenance@[0-9a-f]{40}/)
  assert.match(record, /subject-digest: \$\{\{ needs\.publish\.outputs\.digest \}\}/)
  assert.match(record, /push-to-registry: true/)
  const lane = job('server-lane')
  assert.match(lane, /permissions:\n      contents: write\n    env:/)
  assert.ok(!lane.includes('id-token') && !lane.includes('packages:') && !lane.includes('docker login'))
})

test('server-lane advances only for stable content, one at a time, and never marks Latest', () => {
  const lane = job('server-lane')
  assert.match(lane, /needs: \[image, record\]/)
  assert.match(lane, /if: needs\.image\.outputs\.publish == 'true' && needs\.image\.outputs\.latest == 'true'/)
  assert.match(lane, /concurrency:\n      group: server-lane\n      cancel-in-progress: false/)
  assert.match(lane, /node server\/server-lane\.mjs/)
  const script = readFileSync(join(HERE, '..', 'server-lane.mjs'), 'utf8')
  assert.match(script, /'--prerelease', '--latest=false'/)
  assert.ok(!script.includes('release edit'))
})

test('the consumer docs pin the rolling pointer and provenance verification', () => {
  assert.match(readme, /https:\/\/github\.com\/automagik-si\/automagik\/releases\/download\/server-lane\/server-image\.json/)
  assert.match(readme, /gh attestation verify "oci:\/\/\$\{ref\}" --repo automagik-si\/automagik/)
  assert.match(rfc, /\[server-lane\/server-image\.json\]\(https:\/\/github\.com\/automagik-si\/automagik\/releases\/download\/server-lane\/server-image\.json\)/)
})

const SRC = ROOT + '/server/server-lane.mjs'
const { postServerLane } = await import(SRC)
const rec = (version, image = good.image) => {
  const r = imageRecord({ ...good, image, version, tag: `${version}-${revision.slice(0, 8)}` })
  const dir = mkdtempSync(join(tmpdir(), 'lane-'))
  temps.push(dir)
  const file = join(dir, 'server-image.json')
  writeFileSync(file, JSON.stringify(r))
  return { file, text: JSON.stringify(r) }
}
// laneRead, when given, is gh's whole answer to the read of the server-lane release.
const fakeGh = ({ source, lane, posted, calls, laneRead }) => (args) => {
  calls.push(args.join(' '))
  const http = (code, body) => ({ status: 0, stdout: `HTTP/2 ${code}\r\n\r\n${body ? JSON.stringify(body) : ''}` })
  if (args[0] === 'api' && args[1] === '--include') {
    const tag = args[2].split('/tags/')[1]
    if (tag === 'server-lane') return laneRead ?? (lane ? http(200, lane) : http(404))
    return http(200, source)
  }
  if (args[0] === 'api') return { status: 0, stdout: posted }
  return { status: 0, stdout: '' }
}
const stable = { prerelease: false, draft: false }
const laneRel = { prerelease: true, draft: false, assets: [{ name: RECORD_ASSET, id: 7 }] }
const input = (file, version = '3.94.0') => ({ repo: 'o/r', content: version, image: good.image, file })

test('server-lane is created as a prerelease, never Latest, when missing', () => {
  const calls = []
  postServerLane(input(rec('3.94.0').file), fakeGh({ source: stable, calls }))
  assert.ok(calls.some((c) => c.startsWith('release create server-lane') && c.includes('--prerelease --latest=false')))
  assert.ok(calls.some((c) => c.startsWith('release upload server-lane') && c.includes('--clobber')))
})

// A release's target is a branch or a commit, never a tag: the lane's own tag does not exist yet,
// and every sibling lane (herdr, plugin, pocket, am, meter) is created on dev.
test('the bootstrap creates server-lane on dev, as every sibling lane does', () => {
  const argv = []
  const gh = fakeGh({ source: stable, calls: [] })
  postServerLane(input(rec('3.94.0').file), (args) => {
    argv.push(args)
    return gh(args)
  })
  const creates = argv.filter((args) => args[0] === 'release' && args[1] === 'create')
  assert.equal(creates.length, 1)
  const [create] = creates
  assert.deepEqual(create.slice(0, 9),
    ['release', 'create', 'server-lane', '--repo', 'o/r', '--target', 'dev', '--prerelease', '--latest=false'])
  assert.deepEqual([create[9], create[11], create.length], ['--title', '--notes', 13])
  assert.ok(!create.some((arg) => /^v\d/.test(arg)))
})

test('server-lane replaces an older record, keeps a newer one, and never moves for a prerelease', () => {
  const older = rec('3.93.0')
  let calls = []
  postServerLane(input(rec('3.94.0').file), fakeGh({ source: stable, lane: laneRel, posted: older.text, calls }))
  assert.ok(calls.some((c) => c.startsWith('release upload server-lane')))
  assert.ok(!calls.some((c) => c.startsWith('release create') || c.startsWith('release edit')))
  calls = []
  const result = postServerLane(input(rec('3.93.0').file, '3.93.0'),
    fakeGh({ source: stable, lane: laneRel, posted: rec('3.94.0').text, calls }))
  assert.match(result, /stays at 3\.94\.0/)
  assert.ok(!calls.some((c) => c.startsWith('release upload')))
  calls = []
  postServerLane(input(rec('3.94.0').file), fakeGh({ source: { prerelease: true, draft: false }, calls }))
  assert.ok(!calls.some((c) => c.startsWith('release ')))
})

test('server-lane fails closed on an unreadable pointer or a lane that is not a prerelease', () => {
  const file = rec('3.94.0').file
  assert.throws(() => postServerLane(input(file), fakeGh({ source: stable, lane: laneRel, posted: 'not json', calls: [] })))
  assert.throws(() => postServerLane(input(file),
    fakeGh({ source: stable, lane: { ...laneRel, assets: [] }, calls: [] })), /no readable record/)
  assert.throws(() => postServerLane(input(file),
    fakeGh({ source: stable, lane: { ...laneRel, prerelease: false }, calls: [] })), /prerelease/)
})

const writes = (calls) => calls.filter((c) => c.startsWith('release '))

// The lane holds one image's records: a pointer that names another image is never replaced,
// whether its content is older or newer than the candidate.
test('server-lane refuses a posted record that names another image, and writes nothing', () => {
  const other = 'ghcr.io/automagik-si/another-server'
  for (const version of ['3.93.0', '3.94.0', '3.95.0']) {
    const calls = []
    assert.throws(() => postServerLane(input(rec('3.94.0').file),
      fakeGh({ source: stable, lane: laneRel, posted: rec(version, other).text, calls })),
    /server-lane names another image/, version)
    assert.ok(calls.some((c) => c.startsWith('api repos/o/r/releases/assets/7')), version)
    assert.deepEqual(writes(calls), [], version)
  }
})

// Only a confirmed 404 means the lane is missing. Any other answer to that read is an unreadable
// lane: bootstrapping over it would replace a pointer nobody compared. One test per answer, so
// each of them fails by name.
const answer = (status, line) => ({ status, stdout: `${line}\r\n\r\n{"message":"refused"}` })
const unreadable = [
  ['500', answer(1, 'HTTP/2.0 500 Internal Server Error')],
  ['403', answer(1, 'HTTP/2.0 403 Forbidden')],
  ['401', answer(1, 'HTTP/2.0 401 Unauthorized')],
  ['500 with gh exit 0', answer(0, 'HTTP/2 500')],
  ['403 with gh exit 0', answer(0, 'HTTP/2 403')],
  ['401 with gh exit 0', answer(0, 'HTTP/2 401')],
  ['gh did not run', { error: new Error('spawn gh ENOENT'), status: null, stdout: null }],
  ['gh failed after a 404 line',
    { error: new Error('spawnSync gh ENOBUFS'), status: null, stdout: 'HTTP/2.0 404 Not Found\r\n\r\n' }],
]
for (const [name, laneRead] of unreadable) {
  test(`server-lane stops on an unreadable lane read and writes nothing: ${name}`, () => {
    const calls = []
    assert.throws(() => postServerLane(input(rec('3.94.0').file), fakeGh({ source: stable, laneRead, calls })),
      /cannot read release server-lane/)
    assert.ok(calls.some((c) => c.endsWith('/releases/tags/server-lane')))
    assert.deepEqual(writes(calls), [])
  })
}

// gh exits 1 on a 404 and still prints the status line: that is the missing lane, and it bootstraps.
test('server-lane still bootstraps on a 404, whatever gh exits with', () => {
  for (const status of [0, 1]) {
    const calls = []
    const laneRead = { status, stdout: 'HTTP/2.0 404 Not Found\r\n\r\n{"message":"Not Found"}' }
    const result = postServerLane(input(rec('3.94.0').file), fakeGh({ source: stable, laneRead, calls }))
    assert.match(result, /^server-lane records /)
    assert.deepEqual(writes(calls).map((c) => c.split(' ').slice(0, 3).join(' ')),
      ['release create server-lane', 'release upload server-lane'], `exit ${status}`)
  }
})
