#!/usr/bin/env node
// Install Omni through the welcome, then update the image on that volume with no network.
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { compareRelease, PLUGINS } from './profile-state.mjs'
const run = promisify(execFile), root = dirname(dirname(fileURLToPath(import.meta.url)))
const candidate = process.argv[2] || 'automagik-server:local', prefix = `automagik-follow-${process.pid}`
const volume = `${prefix}-data`, container = `${prefix}-workspace`, companion = `${prefix}:companion`
const docker = async args => run('docker', args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
const check = (value, message) => { if (!value) throw new Error(message) }
const pause = () => new Promise(resolve => setTimeout(resolve, 250))
async function imageVersion(image) {
  const r = await docker(['run','--rm','--network','none','--entrypoint','/nodejs/bin/node',image,'-e', 'process.stdout.write(JSON.parse(require("fs").readFileSync("/opt/automagik/versions.json","utf8")).automagik)'])
  return r.stdout.trim()
}
async function start(image, online = false) {
  await docker(['run','--detach',...online ? [] : ['--network','none'],'--name',container,'--volume',`${volume}:/data`,'--health-interval','2s','--health-start-period','0s',image])
  const deadline = Date.now() + 240_000
  while (Date.now() < deadline) {
    check((await docker(['inspect',container,'--format','{{.State.Status}}'])).stdout.trim() === 'running', 'update workspace stopped')
    let output
    try { output = await docker(['exec',container,'/nodejs/bin/node','/opt/automagik/healthcheck.mjs','--json']) }
    catch (error) { output = error }
    try {
      const report = JSON.parse(output.stdout)
      if (report.healthy) return report
      if (['update-rolled-back','newer-than-image'].includes(report.reason)) throw new Error(`update did not converge: ${report.reason}`)
    } catch (error) { if (error.message.startsWith('update did not converge:')) throw error }
    await pause()
  }
  throw new Error('update report did not become healthy')
}
async function stop() { await docker(['rm','--force',container]).catch(() => {}) }
async function welcomePlugins(install = false) {
  const result = await docker(['exec', container, '/nodejs/bin/node', '--input-type=module', '-e', `
    import fs from 'node:fs';
    const launch = fs.readFileSync('/data/dsh/launch-url', 'utf8').trim();
    const auth = await fetch(launch, { redirect: 'manual' });
    const cookie = auth.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
    async function call(endpoint) {
      const response = await fetch(new URL('/api/omni-ai', launch), { method: 'POST',
        headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ endpoint, payload: null }) });
      const result = await response.json();
      if (!result.ok) throw new Error('Welcome endpoint failed: ' + endpoint);
      return result.value;
    }
    if (${install}) await call('omni-plugins-install');
    const deadline = Date.now() + 180000;
    for (;;) {
      const result = await call('omni-plugins');
      if (result.ready) { console.log(JSON.stringify(result.plugins.map(({ name, version, installed, enabled }) => ({ name, version, installed, enabled })))); break; }
      if (result.install?.phase === 'failed' || Date.now() > deadline) throw new Error('Welcome plugin installation failed');
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  `])
  return JSON.parse(result.stdout)
}
try {
  const candidateVersion = await imageVersion(candidate)
  const candidateIsNewer = compareRelease(candidateVersion,'3.136.4') > 0
  const companionVersion = candidateIsNewer ? '3.136.4' : '3.136.5'
  const revision = (await docker(['image','inspect',candidate,'--format','{{index .Config.Labels "org.opencontainers.image.revision"}}'])).stdout.trim()
  await run(process.execPath, [join(root,'server/build.mjs'),'--tag',companion,'--version',companionVersion,'--image-version',companionVersion,'--revision',revision], { cwd:root,maxBuffer:32*1024*1024 })
  const older = candidateIsNewer ? companion : candidate, newer = candidateIsNewer ? candidate : companion
  const oldVersion = await imageVersion(older), newVersion = await imageVersion(newer)
  check(compareRelease(newVersion,oldVersion)>0,'smoke requires two distinct ordered releases')
  await docker(['volume','create',volume])
  const initial = await start(older, true)
  check(initial.followsImage && PLUGINS.every(name=>initial.plugins[name]===oldVersion),'old image did not seed its actual release')
  const added = (await welcomePlugins(true)).filter(row => !PLUGINS.includes(row.name))
  check(added.length === 2 && added.every(row => row.installed && row.enabled), 'welcome did not install Omni')
  // The marker stays as the older image wrote it: the welcome's change alone must not opt out.
  await docker(['exec',container,'/nodejs/bin/node','-e','require("fs").writeFileSync("/data/dsh/profiles/automagik-web/follow-smoke-owner-setting","preserve")'])
  await stop()
  const upgraded = await start(newer)
  check(upgraded.followsImage && PLUGINS.every(name=>upgraded.plugins[name]===newVersion),'plugins did not follow the new image')
  check(JSON.stringify((await welcomePlugins()).filter(row => !PLUGINS.includes(row.name))) === JSON.stringify(added), 'Omni changed during image upgrade')
  await docker(['exec',container,'/nodejs/bin/node','-e','const fs=require("fs"),p="/data/dsh/profiles/automagik-web/";if(fs.readFileSync(p+"follow-smoke-owner-setting","utf8")!=="preserve")process.exit(1);const dirs=fs.readdirSync("/data/dsh/backups");if(!dirs.length)process.exit(1);for(const n of ["package.json","pnpm-lock.yaml"]){if(!dirs.some(d=>fs.existsSync("/data/dsh/backups/"+d+"/automagik-web/"+n)))process.exit(1)}'])
  const logs = await docker(['logs',container])
  check(`${logs.stdout}${logs.stderr}`.includes('image follow: updated; matching-image'),'startup did not report the real update')
  await stop()
  const restarted = await start(newer)
  check(restarted.followsImage && PLUGINS.every(name=>restarted.plugins[name]===newVersion),'updated profile did not survive restart')
  check(JSON.stringify((await welcomePlugins()).filter(row => !PLUGINS.includes(row.name))) === JSON.stringify(added), 'Omni did not survive restart')
  console.log(`FOLLOW SMOKE OK old=${oldVersion} new=${newVersion} plugins=3 omni=${JSON.stringify(added)} upgrade_network=none backup=yes restart=yes`)
} catch(error) {
  console.error(`FOLLOW SMOKE FAILED: ${error.message}`)
  process.exitCode=1
} finally {
  await stop()
  await docker(['volume','rm','--force',volume]).catch(()=>{})
  await docker(['image','rm',companion]).catch(()=>{})
}
