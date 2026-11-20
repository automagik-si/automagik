import { runSupervisor } from '../../src/host/supervisor/main.js'

const options = JSON.parse(process.env.SUPERVISOR_DRIVER)
const tarballs = new Map(options.tarballs)
const fetch = async url => {
  if (tarballs.has(url)) return new Response(Buffer.from(tarballs.get(url), 'base64'))
  if (url === (process.env.SUPERVISOR_EXPECT_REGISTRY ?? 'https://registry.example.invalid/npm/') + '-/ping') return new Response('{}')
  throw new Error('Unexpected fixture request')
}

process.exitCode = await runSupervisor({ ...options, fetch, healthTimeout: 3500 })
