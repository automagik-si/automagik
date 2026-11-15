// The server-lane job (.github/workflows/server-image.yml) holds the server-lane concurrency
// group for this entire read/compare/write.
// Only a confirmed 404 bootstraps the rolling release; an unreadable existing pointer stops it.
import { spawnSync } from 'node:child_process'
import { appendFileSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseRecord, RECORD_ASSET } from './image-record.mjs'

const ghCommand = (args) => spawnSync('gh', args, { encoding: 'utf8' })
const parts = (version) => {
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) {
    throw new Error(`server-lane needs a stable version: ${version}`)
  }
  return version.split('.').map(BigInt)
}

export function postServerLane({ repo, content, image, file }, gh = ghCommand) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo ?? '')) throw new Error('a repository is required')
  const candidate = parseRecord(readFileSync(file, 'utf8'))
  if (candidate.version !== content || candidate.image !== image) throw new Error('record does not match the pushed content and image')
  const command = (args) => {
    const result = gh(args)
    if (result.error || result.status !== 0) throw new Error(`gh ${args[0]} failed; server-lane was not advanced`)
    return result.stdout
  }
  const release = (tag) => {
    const result = gh(['api', '--include', `repos/${repo}/releases/tags/${tag}`])
    const status = /^HTTP\/\S+\s+(\d+)/.exec(result.stdout ?? '')?.[1]
    if (!result.error && status === '404') return null
    if (result.error || result.status !== 0 || status !== '200') throw new Error(`cannot read release ${tag}; refusing to advance server-lane`)
    return JSON.parse(result.stdout.split(/\r?\n\r?\n/).slice(1).join('\n\n'))
  }
  // The workflow skips prereleases; recheck the content release before any lane mutation too.
  const source = release(`v${content}`)
  if (source?.prerelease === true) return 'prerelease: server-lane stays put'
  if (source?.prerelease !== false || source?.draft !== false) throw new Error('content is not a published stable release')
  const next = parts(candidate.version)
  const lane = release('server-lane')
  if (lane) {
    if (lane.prerelease !== true || lane.draft !== false) throw new Error('server-lane must be a published prerelease; never edit it by hand')
    const asset = lane.assets?.find((asset) => asset.name === RECORD_ASSET)
    if (!Number.isSafeInteger(asset?.id) || asset.id <= 0) throw new Error('server-lane has no readable record; refusing to overwrite it')
    const posted = parseRecord(command(['api', `repos/${repo}/releases/assets/${asset.id}`, '-H', 'Accept: application/octet-stream']))
    if (posted.image !== image) throw new Error('server-lane names another image')
    const current = parts(posted.version)
    for (let i = 0; i < next.length; i += 1) {
      if (next[i] < current[i]) return `older content ${content}: server-lane stays at ${posted.version}`
      if (next[i] > current[i]) break
    }
  } else {
    command(['release', 'create', 'server-lane', '--repo', repo, '--target', 'dev',
      '--prerelease', '--latest=false', '--title', 'Automagik server lane',
      '--notes', 'server-image.json names the newest stable server image. Verify its build provenance before pulling by digest; see server/README.md.'])
  }
  command(['release', 'upload', 'server-lane', file, '--clobber', '--repo', repo])
  return `server-lane records ${candidate.ref} (v${content})`
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = postServerLane({ repo: process.env.GITHUB_REPOSITORY, content: process.env.CONTENT,
      image: process.env.GHCR, file: process.argv[2] })
    console.log(result)
    if (process.env.GITHUB_STEP_SUMMARY) {
      appendFileSync(process.env.GITHUB_STEP_SUMMARY, `\n${result}\n\n[Stable server record](${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/releases/download/server-lane/server-image.json)\n`)
    }
  } catch (error) {
    console.error(`[server-lane] FAILED: ${error.message}`)
    process.exitCode = 1
  }
}
