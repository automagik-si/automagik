import fs from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { runSupervisor } from '../../src/host/supervisor/main.js'

const options = JSON.parse(process.env.SUPERVISOR_DRIVER)
const tarballs = new Map(options.tarballs)
const fetch = async url => {
  if (tarballs.has(url)) return new Response(Buffer.from(tarballs.get(url), 'base64'))
  if (url === (process.env.SUPERVISOR_EXPECT_REGISTRY ?? 'https://registry.example.invalid/npm/') + '-/ping') return new Response('{}')
  throw new Error('Unexpected fixture request')
}

const failVerdict = process.env.SUPERVISOR_VERDICT_FAILURE
if (failVerdict) {
  globalThis.fetch = async url => {
    if (url !== 'http://127.0.0.1:3080/') throw new Error('Unexpected health endpoint')
    const pid = Number(fs.readFileSync(join(process.env.SUPERVISOR_FIXTURE, 'dsh-child-pid'), 'utf8'))
    process.kill(pid, 0)
    return new Response('ready')
  }
  const rename = fs.renameSync
  fs.renameSync = (source, destination) => {
    if (basename(destination) === 'state.json') {
      const state = JSON.parse(fs.readFileSync(source))
      if (state.phase === failVerdict) {
        fs.writeFileSync(join(dirname(destination), 'request.json'), JSON.stringify({
          version: 1, bootId: state.bootId, requestId: 'during-verdict-failure', requestedAt: new Date().toISOString(),
        }))
        throw Object.assign(new Error('fixture verdict write failed'), { code: 'EIO' })
      }
    }
    return rename(source, destination)
  }
}

process.exitCode = await runSupervisor({ ...options, fetch, healthTimeout: 3500 })
