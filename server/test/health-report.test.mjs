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
import { profileDirOf } from '../lib.mjs'

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
  return {root,home,source,profile,build}
}
async function listener(t, initial=401) {
  let status=initial
  const server=http.createServer((req,res)=>{res.writeHead(status);res.end('private response body')})
  server.listen(0,'127.0.0.1');await once(server,'listening')
  t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve))})
  return {server,port:server.address().port,set:value=>{status=value}}
}
const report=(f,port,env={})=>healthReport({root:f.root,dshHome:f.home,dshPort:port,env})

// HEALTH_FENCE_200: treating a successful HTTP response as a healthy authentication fence fails open.
test('JSON health has a fixed non-secret shape and only a 401 fence is healthy',async t=>{
  const f=fixture(t),dsh=await listener(t)
  const r=await report(f,dsh.port)
  assert.deepEqual(Object.keys(r).sort(),['schemaVersion','image','plugins','followsImage','ownerManaged','reason','dsh','gate','fence','modelPins','healthy'].sort())
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

test('pending model pins are reported while the healthy fence stays green', async t => {
  const f = fixture(t), dsh = await listener(t)
  const data = join(f.root, 'data')
  mkdirSync(join(data, 'bots'), { recursive: true })
  writeFileSync(join(data, 'bots', 'pending-model-pins.json'), JSON.stringify({ version: 1, pins: [
    { id: 'b-aaaaaaaaaa', name: 'Purpose', model: 'gpt-6-astra' },
    { id: 'b-bbbbbbbbbb', name: 'Dogfooder', model: 'gpt-6.1-terra' },
    { id: 'b-cccccccccc', name: 'Fixer', model: 'gpt-6.1-sol' },
  ] }))
  const r = await report(f, dsh.port, { AUTOMAGIK_HOME: data })
  assert.equal(r.modelPins.state, 'pending')
  assert.equal(r.modelPins.count, 3)
  assert.equal(r.healthy, true)
  assert.ok(!JSON.stringify(r).includes(data))
})
