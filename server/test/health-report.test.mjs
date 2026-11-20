import assert from 'node:assert/strict'
import { once } from 'node:events'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { healthReport } from '../healthcheck.mjs'
import { FOLLOW_STATUS, markSeed, packageHash, SEED_MARKER } from '../profile-state.mjs'
import { PLUGINS } from '../plugin-payload.mjs'
import { GATE_VIEW, profileDirOf } from '../lib.mjs'

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(),'automagik-report-')), home=join(root,'data','dsh'), source=join(root,'profile'), profile=profileDirOf(home)
  const build={automagik:'3.93.0',revision:'b'.repeat(40),plugins:Object.fromEntries(PLUGINS.map(name=>[name,'3.93.0']))}
  const manifest=JSON.parse(readFileSync(new URL('../profile/package.json',import.meta.url),'utf8'))
  for(const name of PLUGINS)manifest.dependencies[name]=`file:vendor/automagik-${name.split('/')[1]}-3.93.0.tgz`
  mkdirSync(source,{recursive:true});writeFileSync(join(source,'package.json'),`${JSON.stringify(manifest,null,2)}\n`)
  for(const name of PLUGINS){const dir=join(source,'node_modules',...name.split('/'));mkdirSync(dir,{recursive:true});writeFileSync(join(dir,'package.json'),JSON.stringify({name,version:'3.93.0'}))}
  cpSync(source,profile,{recursive:true});markSeed(profile,'3.93.0')
  writeFileSync(join(root,'versions.json'),JSON.stringify(build))
  t.after(()=>rmSync(root,{recursive:true,force:true}))
  const viewDir = join(root, 'data', GATE_VIEW)
  mkdirSync(viewDir, { mode: 0o700 })
  return {root,home,source,profile,build,viewDir}
}
async function listener(t, initial=401) {
  let status=initial
  const server=http.createServer((req,res)=>{res.writeHead(status);res.end('private response body')})
  server.listen(0,'127.0.0.1');await once(server,'listening')
  t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve))})
  return {server,port:server.address().port,set:value=>{status=value}}
}
const report = (f, port, env = {}) => healthReport({
  root: f.root, dshHome: f.home, viewDir: f.viewDir, dshPort: port, env,
})

// HEALTH_FENCE_200: treating a successful HTTP response as a healthy authentication fence fails open.
test('JSON health has a fixed non-secret shape and only a 401 fence is healthy',async t=>{
  const f=fixture(t),dsh=await listener(t)
  const r=await report(f,dsh.port)
  assert.deepEqual(Object.keys(r).sort(),['schemaVersion','image','plugins','followsImage','ownerManaged','reason','dsh','gate','fence','healthy'].sort())
  assert.deepEqual(r.image,{version:'3.93.0',revision:'b'.repeat(40)})
  assert.deepEqual(r.plugins,f.build.plugins);assert.equal(r.followsImage,true);assert.equal(r.reason,'matching-image');assert.equal(r.healthy,true)
  assert.deepEqual(r.gate,{enabled:false,up:null,status:null});assert.deepEqual(r.dsh,{up:true,status:401})
  assert.ok(!JSON.stringify(r).includes(f.root));assert.ok(!JSON.stringify(r).includes('private response body'))
  dsh.set(200)
  const bypass=await report(f,dsh.port);assert.equal(bypass.fence.healthy,false);assert.equal(bypass.healthy,false)
  await new Promise(resolve=>dsh.server.close(resolve))
  const down=await report(f,dsh.port);assert.equal(down.dsh.up,false);assert.equal(down.fence.status,null);assert.equal(down.healthy,false)
})

test('gate mode reports both listeners and cannot conceal a missing or open DSH fence',async t=>{
  const f=fixture(t),dsh=await listener(t),gate=await listener(t),env={AUTOMAGIK_GATE_ENABLED:'1',AUTOMAGIK_GATE_PORT:String(gate.port)}
  await report(f, dsh.port)
  assert.equal((await report(f,dsh.port,env)).healthy,true)
  gate.set(200);assert.equal((await report(f,dsh.port,env)).healthy,false)
  gate.set(401);dsh.set(500)
  const broken=await report(f,dsh.port,env);assert.equal(broken.gate.up,true);assert.equal(broken.dsh.status,500);assert.equal(broken.healthy,false)
})

// HEALTH_IGNORE_VERSIONS: a 401 alone conceals a failed plugin update.
test('a rollback or newer installed release is unhealthy even while the HTTP fence answers 401',async t=>{
  const f=fixture(t),dsh=await listener(t)
  for(const name of PLUGINS)writeFileSync(join(f.profile,'node_modules',...name.split('/'),'package.json'),JSON.stringify({name,version:'3.90.1'}))
  markSeed(f.profile,'3.90.1')
  writeFileSync(join(f.home,FOLLOW_STATUS),JSON.stringify({version:1,imageVersion:'3.93.0',packageSha256:packageHash(f.profile),result:'update-rolled-back'}))
  const failed=await report(f,dsh.port);assert.equal(failed.reason,'update-rolled-back');assert.equal(failed.healthy,false);assert.equal(failed.fence.status,401)
  for(const name of PLUGINS)writeFileSync(join(f.profile,'node_modules',...name.split('/'),'package.json'),JSON.stringify({name,version:'3.94.0'}))
  markSeed(f.profile,'3.94.0');rmSync(join(f.home,FOLLOW_STATUS))
  const newer=await report(f,dsh.port);assert.equal(newer.reason,'newer-than-image');assert.equal(newer.followsImage,false);assert.equal(newer.healthy,false)
})

test('only an explicitly owner-edited profile gets the owner-managed version exception',async t=>{
  const f=fixture(t),dsh=await listener(t)
  writeFileSync(join(f.profile,'package.json'),'{"description":"owner settings"}\n')
  for(const name of PLUGINS)writeFileSync(join(f.profile,'node_modules',...name.split('/'),'package.json'),JSON.stringify({name,version:'3.90.1'}))
  const owned=await report(f,dsh.port);assert.equal(owned.reason,'owner-managed');assert.equal(owned.ownerManaged,true);assert.equal(owned.followsImage,false);assert.equal(owned.healthy,true)
  writeFileSync(join(f.profile,SEED_MARKER),'unsupported marker')
  const invalid=await report(f,dsh.port);assert.equal(invalid.ownerManaged,false);assert.equal(invalid.healthy,false)
})

test('missing installed packages and untrusted metadata cannot yield a false-green or leak values',async t=>{
  const f=fixture(t),dsh=await listener(t)
  rmSync(join(f.profile,'node_modules',...PLUGINS[0].split('/'),'package.json'))
  const missing=await report(f,dsh.port);assert.equal(missing.plugins[PLUGINS[0]],null);assert.equal(missing.healthy,false)
  const secret='sk-'+ 'a'.repeat(32),privatePath=join(f.root,'private-location')
  writeFileSync(join(f.root,'versions.json'),JSON.stringify({...f.build,automagik:secret,revision:privatePath,token:secret}))
  const scrubbed=await report(f,dsh.port,{DEEPSEEK_API_KEY:secret});assert.equal(scrubbed.image.version,null);assert.equal(scrubbed.image.revision,null);assert.equal(scrubbed.healthy,false)
  assert.ok(!JSON.stringify(scrubbed).includes(secret));assert.ok(!JSON.stringify(scrubbed).includes(privatePath))
})

// LEGACY_BROKEN_OWNER_EXCEPTION: using installed versions to identify the seed mislabels corruption as owner intent.
test('missing or mixed plugins in a canonical legacy seed never receive an owner-managed health exception',async t=>{
  const dsh=await listener(t)
  for(const broken of ['missing','mixed']) {
    const f=fixture(t)
    rmSync(join(f.profile,SEED_MARKER))
    const plugin=join(f.profile,'node_modules',...PLUGINS[0].split('/'),'package.json')
    if(broken==='missing')rmSync(plugin)
    else writeFileSync(plugin,JSON.stringify({name:PLUGINS[0],version:'3.90.1'}))
    const state=await report(f,dsh.port)
    assert.equal(state.ownerManaged,false,broken)
    assert.equal(state.healthy,false,broken)
  }
})

import { EventEmitter } from 'node:events'
import { createCarrier } from '../../apps/multiuser-dsh/src/carrier.js'
import { reservationOf } from '../../apps/multiuser-dsh/src/reservation.js'
import { followImage } from '../profile-follow.mjs'
import { readProfileState } from '../gate-view.mjs'

function mockHealthHttp(t, replies) {
  t.mock.method(http, 'get', (options, callback) => {
    const request = new EventEmitter()
    Promise.resolve(replies(options)).then(([statusCode, body]) => {
      const response = Object.assign(new EventEmitter(), { statusCode })
      callback(response)
      if (body) response.emit('data', Buffer.from(body))
      response.emit('end')
    }, error => request.emit('error', error))
    return request
  })
}

test('mode on requires all four empty probe responses and leaves the off-mode report unchanged', async t => {
  const f = fixture(t)
  const caller = '/_automagik/caller/api/__automagik_probe', reservation = '/_automagik/__automagik_probe'
  const paths = [], replies = {
    '/': [401],
    [caller]: [401],
    [reservation]: [404],
  }
  let watermarkStatus = 401, originReply = [403]
  mockHealthHttp(t, options => {
    paths.push(options.path)
    assert.equal(options.host, '127.0.0.1')
    assert.equal(options.agent, false)
    assert.equal(options.headers.host, `127.0.0.1:${options.port}`)
    assert.equal(options.headers.connection, 'keep-alive')
    if (Object.hasOwn(options.headers, 'x-automagik-caller')) {
      assert.equal(options.path, caller)
      assert.equal(options.headers['x-automagik-caller'], 'invalid-probe')
      return [watermarkStatus]
    }
    if (Object.hasOwn(options.headers, 'origin')) {
      assert.equal(options.path, caller)
      assert.equal(options.headers.origin, 'http://automagik-probe.invalid')
      return originReply
    }
    return replies[options.path]
  })
  const off = await report(f, 3081)
  assert.equal(off.healthy, true)
  assert.equal(Object.hasOwn(off, 'multiuser'), false)
  assert.deepEqual(paths, ['/'])
  const on = () => report(f, 3081, { AUTOMAGIK_MULTIUSER: '1' })
  const good = await on()
  assert.equal(good.healthy, true)
  assert.deepEqual(good.multiuser, { caller: true, reservation: true, healthy: true })
  assert.deepEqual(paths.slice(1), ['/', caller, caller, reservation, caller])
  replies[caller] = [401, 'ordinary fallback']
  assert.deepEqual((await on()).multiuser, { caller: false, reservation: true, healthy: false })
  replies[caller] = [401]
  watermarkStatus = 503
  assert.deepEqual((await on()).multiuser, { caller: false, reservation: true, healthy: false })
  watermarkStatus = 401
  originReply = [403, 'ordinary fallback']
  assert.deepEqual((await on()).multiuser, { caller: false, reservation: true, healthy: false })
  originReply = [403]
  replies[reservation] = [404, 'ordinary fallback']
  assert.deepEqual((await on()).multiuser, { caller: true, reservation: false, healthy: false })
  replies[reservation] = [503]
  const missing = await on()
  assert.deepEqual(missing.multiuser, { caller: true, reservation: false, healthy: false })
  assert.equal(missing.fence.healthy, true)
  assert.equal(missing.healthy, false)
})

test('gate multiuser health probes the DSH reservation despite two healthy root fences', async t => {
  const f = fixture(t)
  mockHealthHttp(t, ({ path, port, headers }) => {
    if (path === '/') return [401]
    assert.equal(port, 3081)
    if (headers.origin) return [403]
    return path.startsWith('/_automagik/caller/') ? [401] : [503]
  })
  await report(f, 3081)
  const result = await report(f, 3081, { AUTOMAGIK_GATE_ENABLED: '1', AUTOMAGIK_GATE_MULTIUSER: '1' })
  assert.equal(result.dsh.status, 401)
  assert.equal(result.gate.status, 401)
  assert.equal(result.fence.healthy, true)
  assert.deepEqual(result.multiuser, { caller: true, reservation: false, healthy: false })
  assert.equal(result.healthy, false)
})

test('gate mode-on health distinguishes DSH mode with the real carrier and reservation handlers', async t => {
  const f = fixture(t), port = 3081
  const env = { AUTOMAGIK_GATE_ENABLED: '1', AUTOMAGIK_GATE_MULTIUSER: '1', AUTOMAGIK_CALLER_KEYS: '/caller-keys/caller-keys.json' }
  let webserver, watermarkChecks = 0
  const setDshMode = multiuser => {
    webserver = { match: () => undefined, upgrades: new Map() }
    const owner = reservationOf(webserver).claim({})
    owner.register({ kind: 'prefix', path: '/_automagik/caller', handler: createCarrier({
      connection: { createSharedFetchHandler() {} }, multiuser, keysConfigured: Boolean(env.AUTOMAGIK_CALLER_KEYS),
      expectedAuthority: () => `127.0.0.1:${port}`,
      nonces: { verificationSecond(second) { watermarkChecks++; return second } },
    }) })
  }
  const results = []
  mockHealthHttp(t, async ({ path, headers }) => {
    if (path === '/') return [401]
    let status, body
    const req = { method: 'GET', url: path, rawHeaders: Object.entries(headers).flat() }
    const res = { writeHead(code) { status = code; return this }, end(bytes) { body = bytes } }
    await webserver.match(path).handler(req, res)
    results.push([status, body])
    return [status, body]
  })
  await report(f, port)
  setDshMode(false)
  const off = await report(f, port, env)
  assert.equal(off.fence.healthy, true)
  assert.deepEqual(off.multiuser, { caller: false, reservation: true, healthy: false })
  assert.equal(off.healthy, false)
  assert.deepEqual(results.splice(0), [[401, undefined], [401, undefined], [404, undefined], [401, undefined]])
  assert.equal(watermarkChecks, 0)

  setDshMode(true)
  const on = await report(f, port, env)
  assert.deepEqual(on.multiuser, { caller: true, reservation: true, healthy: true })
  assert.equal(on.healthy, true)
  assert.deepEqual(results, [[401, undefined], [401, undefined], [404, undefined], [403, undefined]])
  assert.equal(watermarkChecks, 1)
})

test('a newer seed marker keeps follower, published state and health aligned after restoring installed files', async t => {
  const f = fixture(t), release = '3.94.0'
  const file = join(f.profile, 'package.json'), manifest = JSON.parse(readFileSync(file, 'utf8'))
  for (const name of PLUGINS) manifest.dependencies[name] = manifest.dependencies[name].replace(f.build.automagik, release)
  writeFileSync(file, JSON.stringify(manifest, null, 2) + '\n')
  markSeed(f.profile, release)
  const followed = await followImage({ dshHome: f.home, source: f.source, build: f.build,
    install: () => assert.fail('newer managed profile reached install') })
  assert.equal(followed.result, 'newer-than-image')
  assert.equal(followed.reason, 'newer-than-image')
  assert.equal(followed.matchesImage, false)
  assert.deepEqual(followed.plugins, f.build.plugins)

  mockHealthHttp(t, () => [401])
  const dsh = await report(f, 3081)
  const published = readProfileState(f.viewDir, f.build)
  const gate = await report(f, 3081, { AUTOMAGIK_GATE_ENABLED: '1' })
  for (const state of [published, dsh, gate]) {
    assert.equal(state.reason, 'newer-than-image')
    assert.equal(state.followsImage, false)
  }
  for (const health of [dsh, gate]) {
    assert.equal(health.fence.healthy, true)
    assert.equal(health.healthy, false)
  }
})
