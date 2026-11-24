// automagik-pets bakes into a temporary home only: every test passes --home (or
// AUTOMAGIK_BOTS_HOME) and runs the CLI with HOME pointed at a temporary folder too, so the real
// ~/.automagik is never read or written.
import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { cp, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import sharp from 'sharp'
import { createPets, sheetVersion, webpSize } from '../../bots-dsh/src/host/pets.js'
import { ROWS, SLEEP } from '../../bots-dsh/src/client/pet-poses.js'
import { CHARACTERS } from '../../bots-dsh/src/client/characters.js'
import { CHARACTER_IDS, COLOUR_IDS, allLookIds, cellPlan, lookParts, mixSrgb, parseLookId, resolveInks } from '../src/art.js'
import { VERSION, bakePet, botsHomeOf, isCompletePet, moveIntoPlace, renderCell, sweepStale } from '../src/bake.js'

const BIN = fileURLToPath(new URL('../bin/automagik-pets.js', import.meta.url))
const run = promisify(execFile)
const temps = []
async function tempHome() {
  const dir = await mkdtemp(join(tmpdir(), 'automagik-pets-'))
  temps.push(dir)
  return dir
}
after(() => Promise.all(temps.map(dir => rm(dir, { recursive: true, force: true }))))

// The CLI in a child process with a temporary HOME and none of Automagik's variables.
async function cli(args, env = {}, cwd = undefined) {
  const home = await tempHome()
  const clean = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('AUTOMAGIK_')))
  try {
    const { stdout, stderr } = await run(process.execPath, [BIN, ...args], { cwd, env: { ...clean, HOME: home, ...env } })
    return { code: 0, stdout, stderr }
  } catch (error) {
    return { code: error.code, stdout: error.stdout, stderr: error.stderr }
  }
}
const lastLine = text => JSON.parse(text.trim().split('\n').at(-1))
const FRAME_COUNT = Object.values(ROWS).reduce((sum, { ms }) => sum + ms.length, 0) + 1 + 16 + SLEEP.ms.length

describe('looks', () => {
  test('33 characters in 19 inks, 627 look ids, each [a-z0-9-]', () => {
    assert.equal(CHARACTER_IDS.length, 33)
    // The twelve Solvers close the catalogue.
    assert.deepEqual(CHARACTER_IDS.slice(21), ['puff', 'sprout', 'cap', 'bell', 'cloud', 'spike', 'floppy', 'antenna', 'cactus', 'bulb', 'chick', 'frog'])
    assert.equal(COLOUR_IDS.length, 19)
    const ids = allLookIds()
    assert.equal(new Set(ids).size, 627)
    for (const id of ids) {
      assert.match(id, /^[a-z0-9-]+$/)
      assert.deepEqual(parseLookId(id) && `${parseLookId(id).character}-${parseLookId(id).colour}`, id)
    }
  })

  test('a bad id names no look', () => {
    for (const id of ['', 'kitty', 'kitty-', '-blue', 'kitty-Blue', 'Kitty-blue', 'kitty-blue-x', 'nope-blue', 'kitty-nope', 'kitty-kimi', 'kitty-#2a92fe', '../kitty-blue', 'kitty_blue', undefined, 7]) {
      assert.equal(parseLookId(id), undefined, String(id))
    }
  })

  test('every look resolves to plain colors: no ink variable or color-mix is left', () => {
    for (const id of allLookIds()) {
      const parts = lookParts(parseLookId(id))
      for (const svg of [parts.body, ...Object.values(parts.faces)]) {
        assert.doesNotMatch(svg, /var\(|color-mix\(/, id)
      }
    }
  })

  test('color-mix in srgb mixes the encoded channels, three-digit hex included', () => {
    assert.equal(resolveInks('var(--bt-ink-blue)'), '#2A92FE')
    assert.equal(resolveInks('var(--bt-ink-blue)', 'dark'), '#0E74E0')
    assert.equal(mixSrgb('#2A92FE', 58, '#fff'), '#83C0FE')
    assert.equal(resolveInks('color-mix(in srgb, var(--bt-ink-blue) 72%, #000)'), mixSrgb('#2A92FE', 72, '#000000'))
    assert.equal(mixSrgb('#2A92FE', 72, '#000'), '#1E69B7')
  })
})

describe('bake', () => {
  test('bakes a v2 pet folder into the given home', async () => {
    const home = await tempHome()
    const { dir } = await bakePet('kitty-blue', { home })
    assert.equal(dir, join(home, 'pets', 'kitty-blue'))
    const manifest = JSON.parse(await readFile(join(dir, 'pet.json'), 'utf8'))
    assert.equal(manifest.id, 'kitty-blue')
    assert.equal(manifest.displayName, 'Kitty (blue)')
    assert.equal(manifest.spriteVersionNumber, 2)
    assert.equal(manifest.spritesheetPath, 'spritesheet.webp')
    assert.deepEqual(manifest.look, { character: 'kitty', colour: 'blue' })
    assert.deepEqual(manifest.bake, { tool: 'automagik-pets', version: VERSION, theme: 'light' })

    const sheet = await readFile(join(dir, 'spritesheet.webp'))
    assert.equal(sheetVersion(sheet), 2)
    assert.deepEqual(webpSize(sheet), [1536, 2288])
    assert.deepEqual(webpSize(await readFile(join(dir, 'sleep.webp'))), [1152, 208])

    // Every row, with its frame count, ms and files; the files are exactly the frames folder.
    for (const [name, { row, ms }] of Object.entries(ROWS)) {
      const entry = manifest.rows[name]
      assert.equal(entry.frames, ms.length, name)
      assert.deepEqual(entry.ms, ms, name)
      assert.deepEqual(entry.cells, ms.map((_, frame) => [row, frame]), name)
      assert.deepEqual(entry.files, ms.map((_, frame) => `frames/${name}-${frame}.png`), name)
    }
    assert.deepEqual(manifest.rows.sleep, { image: 'sleep.webp', frames: 6, ms: [...SLEEP.ms], cells: [0, 1, 2, 3, 4, 5].map(n => [0, n]), files: [0, 1, 2, 3, 4, 5].map(n => `frames/sleep-${n}.png`) })
    assert.equal(manifest.rows.look.frames, 16)
    assert.equal(manifest.rows.look.ms, null)
    assert.deepEqual(manifest.rows.look.cells.slice(7, 9), [[9, 7], [10, 0]])
    assert.deepEqual(manifest.rows.neutral.cells, [[0, 6]])
    const listed = Object.values(manifest.rows).flatMap(entry => entry.files).sort()
    assert.equal(listed.length, FRAME_COUNT)
    assert.deepEqual((await readdir(join(dir, 'frames'))).map(name => `frames/${name}`).sort(), listed)
    assert.deepEqual((await readdir(dir)).sort(), ['frames', 'pet.json', 'sleep.webp', 'spritesheet.webp'])
  })

  test('a Solver\'s headless pet is drawn from its fur: the body and the lock layer', () => {
    const { body } = lookParts({ character: 'cap', colour: 'red' })
    assert.ok(body.includes(CHARACTERS.cap.body))
    const lock = CHARACTERS.cap.paints.at(-1)
    assert.deepEqual(lock.slice(1), ['#000', 0.15])
    assert.ok(body.includes(lock[0]))
  })

  test('a Solver bakes into the same v2 pet folder as any other character', async () => {
    const home = await tempHome()
    const { dir } = await bakePet('cap-red', { home })
    assert.equal(dir, join(home, 'pets', 'cap-red'))
    const manifest = JSON.parse(await readFile(join(dir, 'pet.json'), 'utf8'))
    assert.equal(manifest.displayName, 'Cap (red)')
    assert.deepEqual(manifest.look, { character: 'cap', colour: 'red' })
    assert.equal(manifest.spriteVersionNumber, 2)
    assert.deepEqual(webpSize(await readFile(join(dir, 'spritesheet.webp'))), [1536, 2288])
    assert.deepEqual(webpSize(await readFile(join(dir, 'sleep.webp'))), [1152, 208])
    assert.equal((await readdir(join(dir, 'frames'))).length, FRAME_COUNT)
    assert.ok(await isCompletePet(dir, 'cap-red'))
  })

  test('each frame PNG is its atlas cell, pixel for pixel', async () => {
    const home = await tempHome()
    const { dir } = await bakePet('octopus-deepseek', { home })
    const atlas = sharp(await readFile(join(dir, 'spritesheet.webp')))
    for (const cell of cellPlan().filter(entry => ['idle-3', 'neutral-0', 'look-12', 'jumping-2'].includes(entry.name))) {
      const png = await readFile(join(dir, 'frames', `${cell.name}.png`))
      const meta = await sharp(png).metadata()
      assert.deepEqual([meta.width, meta.height], [192, 208], cell.name)
      const frame = await sharp(png).ensureAlpha().raw().toBuffer()
      const fromAtlas = await atlas.clone().extract({ left: cell.column * 192, top: cell.row * 208, width: 192, height: 208 }).ensureAlpha().raw().toBuffer()
      assert.ok(frame.equals(fromAtlas), cell.name)
      assert.ok(frame.some((value, index) => index % 4 === 3 && value === 255), `${cell.name} draws the character`)
    }
  })

  test('a second bake replaces the folder whole and leaves nothing beside it', async () => {
    const home = await tempHome()
    const { dir } = await bakePet('star-rose', { home })
    await writeFile(join(dir, 'left-over.txt'), 'from the first bake')
    await bakePet('star-rose', { home })
    await assert.rejects(stat(join(dir, 'left-over.txt')), { code: 'ENOENT' })
    assert.deepEqual(await readdir(join(home, 'pets')), ['star-rose'])
  })

  test('a bake that fails keeps the pet already there and removes its temporary folder', async () => {
    const home = await tempHome()
    const { dir } = await bakePet('moon-green', { home })
    const before = await readFile(join(dir, 'spritesheet.webp'))
    let calls = 0
    const render = async (svg) => {
      calls += 1
      if (calls === 40) throw new Error('the renderer broke')
      return renderCell(svg)
    }
    await assert.rejects(bakePet('moon-green', { home, render }), /the renderer broke/)
    assert.ok((await readFile(join(dir, 'spritesheet.webp'))).equals(before))
    assert.deepEqual(await readdir(join(home, 'pets')), ['moon-green'])
  })

  test('a bad id fails before anything is written', async () => {
    const home = await tempHome()
    await assert.rejects(bakePet('nope-blue', { home }), /not a look id/)
    await assert.rejects(stat(join(home, 'pets')), { code: 'ENOENT' })
  })

  test('the bots home: --home, else as the Bot team resolves it', () => {
    assert.equal(botsHomeOf('/x/home', { AUTOMAGIK_BOTS_HOME: '/y' }), '/x/home')
    assert.equal(botsHomeOf(undefined, { AUTOMAGIK_BOTS_HOME: '/y/bots' }), '/y/bots')
    assert.equal(botsHomeOf(undefined, { AUTOMAGIK_BOTS_HOME: ' ', AUTOMAGIK_HOME: '/z' }), '/z/bots')
    assert.equal(botsHomeOf('  ', { AUTOMAGIK_HOME: '/z' }), '/z/bots')
  })
})

describe('the Bot team reads the baked pet', () => {
  test('createPets({home}).list() lists it from the team source as version 2', async () => {
    const home = await tempHome()
    await bakePet('whale-blue', { home })
    // A crashed bake's temporary folder stays invisible: its name starts with a dot.
    await mkdir(join(home, 'pets', '.whale-red.123.ab.tmp', 'frames'), { recursive: true })
    const pets = JSON.parse(JSON.stringify(await createPets({ home, codexHome: join(home, 'no-codex') }).list()))
    const team = pets.filter(pet => pet.source === 'team')
    assert.deepEqual(team, [{ id: 'whale-blue', name: 'Whale (blue)', description: "Automagik's Whale in blue, baked by automagik-pets.", source: 'team', version: 2, sleep: true }])
  })
})

describe('the command line', () => {
  test('bake --json ends with {"ok":true,"dir"} and exits 0', async () => {
    const home = await tempHome()
    const result = await cli(['bake', 'gem-violet', '--home', home, '--json'])
    assert.equal(result.code, 0, result.stderr)
    assert.deepEqual(lastLine(result.stdout), { ok: true, dir: join(home, 'pets', 'gem-violet') })
    assert.equal(result.stdout.trim().split('\n').length, 1)
    await stat(join(home, 'pets', 'gem-violet', 'pet.json'))
  })

  test('without --home it bakes into $AUTOMAGIK_BOTS_HOME', async () => {
    const home = await tempHome()
    const result = await cli(['bake', 'acorn-brown', '--json'], { AUTOMAGIK_BOTS_HOME: home })
    assert.equal(result.code, 0, result.stderr)
    assert.deepEqual(lastLine(result.stdout), { ok: true, dir: join(home, 'pets', 'acorn-brown') })
  })

  test('a bad id ends with {"ok":false,"error"} and exits non-zero', async () => {
    const home = await tempHome()
    for (const id of ['nope-blue', 'kitty-Blue', '../escape']) {
      const result = await cli(['bake', id, '--home', home, '--json'])
      assert.notEqual(result.code, 0, id)
      const line = lastLine(result.stdout)
      assert.equal(line.ok, false, id)
      assert.match(line.error, /not a look id/, id)
    }
    await assert.rejects(stat(join(home, 'pets')), { code: 'ENOENT' })
  })

  test('a wrong command line answers in the same shape and exits 2', async () => {
    for (const args of [['bake'], ['paint', 'kitty-blue'], ['bake', 'kitty-blue', '--colour']]) {
      const result = await cli([...args, '--json'])
      assert.equal(result.code, 2, args.join(' '))
      assert.equal(lastLine(result.stdout).ok, false)
    }
  })

  test('--version prints the one version', async () => {
    const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
    assert.equal((await cli(['--version'])).stdout.trim(), pkg.version)
    assert.deepEqual(lastLine((await cli(['--version', '--json'])).stdout), { ok: true, version: pkg.version })
  })
})

// The same pixels for the same SVG, rendered once: concurrent bakes then reach their moves together.
const cache = new Map()
const cachedRender = (svg) => {
  if (!cache.has(svg)) cache.set(svg, renderCell(svg))
  return cache.get(svg)
}

// Two bakes of one look at once (DSH and Herdr both bake on demand): each one either lands its
// folder or finds a complete pet already in place, and nothing is left beside it.
describe('concurrent bakes of the same look', () => {

  test('moves racing to replace one pet all succeed and leave one complete folder', async () => {
    const home = await tempHome()
    const { dir } = await bakePet('hex-cyan', { home, render: cachedRender })
    const pets = join(home, 'pets')
    const tags = Array.from({ length: 12 }, (_, index) => `${process.pid}.${index.toString(16).padStart(8, '0')}`)
    const staging = tag => join(pets, `.hex-cyan.${tag}.tmp`)
    await Promise.all(tags.map(tag => cp(dir, staging(tag), { recursive: true })))
    // One interleave, pinned rather than left to scheduling: every move looks at the pet before
    // any moves it, the first moves it aside, and the other eleven try while it is away. Their
    // failures wait until the first lands its folder, so they find a complete pet and stand down.
    // No timer and no random delay: an idle and a loaded runner take the same order.
    const winner = tags[0]
    let looked = 0
    let allLooked
    const sawPet = new Promise(done => { allLooked = done })
    let winnerMoved
    const movedAside = new Promise(done => { winnerMoved = done })
    let losersTried = 0
    let allLosersTried
    const everyLoserTried = new Promise(done => { allLosersTried = done })
    let winnerLanded
    const landed = new Promise(done => { winnerLanded = done })
    const tagOf = path => tags.find(tag => path.includes(`.${tag}.`))
    const pinnedRename = async (from, to) => {
      const tag = tagOf(from === dir ? to : from)
      if (from === dir) {
        looked += 1
        if (looked === tags.length) allLooked()
        await sawPet
        if (tag === winner) {
          await rename(from, to)
          winnerMoved()
          return
        }
        await movedAside
        try {
          await rename(from, to)
        } catch (error) {
          losersTried += 1
          if (losersTried === tags.length - 1) allLosersTried()
          await landed
          throw error
        }
        throw new Error(`move ${tag} moved the pet aside after the winner landed`)
      }
      if (tag !== winner) throw new Error(`move ${tag} did not look at the pet first`)
      await everyLoserTried
      await rename(from, to)
      winnerLanded()
    }
    const moves = tags.map(tag => moveIntoPlace(staging(tag), dir, tag, { rename: pinnedRename }))
    const results = await Promise.all(moves)
    assert.ok(results.some(result => result.raced), 'the moves raced')
    assert.ok(await isCompletePet(dir, 'hex-cyan'))
    assert.deepEqual(await readdir(pets), ['hex-cyan'])
  })

  test('bakes of one look at once in one process all succeed', async () => {
    const home = await tempHome()
    const results = await Promise.all(Array.from({ length: 12 }, () => bakePet('zed-red', { home, render: cachedRender })))
    for (const result of results) assert.equal(result.dir, join(home, 'pets', 'zed-red'))
    assert.ok(await isCompletePet(join(home, 'pets', 'zed-red'), 'zed-red'))
    assert.deepEqual(await readdir(join(home, 'pets')), ['zed-red'])
  })

  test('the command line run four times at once: every run answers ok and exits 0', async () => {
    const home = await tempHome()
    await bakePet('plus-sky', { home, render: cachedRender })
    const results = await Promise.all(Array.from({ length: 4 }, () => cli(['bake', 'plus-sky', '--home', home, '--json'])))
    for (const result of results) {
      assert.equal(result.code, 0, result.stdout + result.stderr)
      assert.deepEqual(lastLine(result.stdout), { ok: true, dir: join(home, 'pets', 'plus-sky') })
    }
    assert.ok(await isCompletePet(join(home, 'pets', 'plus-sky'), 'plus-sky'))
    assert.deepEqual(await readdir(join(home, 'pets')), ['plus-sky'])
  })

  test('a pet that cannot be put back is reported with the folder left behind', async () => {
    const home = await tempHome()
    const { dir } = await bakePet('cushion-gray', { home, render: cachedRender })
    const pets = join(home, 'pets')
    const tag = `${process.pid}.0000abcd`
    const staging = join(pets, `.cushion-gray.${tag}.tmp`)
    await cp(dir, staging, { recursive: true })
    let calls = 0
    const failing = async (from, to) => {
      calls += 1
      if (calls === 1) return rename(from, to)
      throw Object.assign(new Error(calls === 2 ? 'cross-device move' : 'permission denied'), { code: calls === 2 ? 'EXDEV' : 'EACCES' })
    }
    const old = join(pets, `.cushion-gray.${tag}.old`)
    await assert.rejects(moveIntoPlace(staging, dir, tag, { rename: failing }), (error) => {
      assert.match(error.message, /cross-device move/)
      assert.match(error.message, /could not be put back \(permission denied\)/)
      assert.ok(error.message.includes(old), error.message)
      return true
    })
    assert.ok(await isCompletePet(old, 'cushion-gray'), 'the old pet is kept where the error says')
  })
})

describe('folders a killed bake left behind', () => {
  // A pid that no process has: a child that has already exited.
  async function deadPid() {
    const child = spawn(process.execPath, ['-e', ''])
    await new Promise(done => child.on('exit', done))
    return child.pid
  }

  test('the next bake sweeps those of gone processes and old ones, and keeps a live bake\'s', async () => {
    const home = await tempHome()
    const pets = join(home, 'pets')
    const dead = await deadPid()
    const folders = {
      deadTmp: `.saucer-blue.${dead}.0000dead.tmp`,
      deadOld: `.saucer-blue.${dead}.0000beef.old`,
      oldLive: `.saucer-blue.${process.pid}.00000001.tmp`,
      freshLive: `.saucer-blue.${process.pid}.00000002.tmp`,
      otherLook: `.saucer-red.${dead}.0000dead.tmp`,
    }
    for (const name of Object.values(folders)) {
      await mkdir(join(pets, name, 'frames'), { recursive: true })
      await writeFile(join(pets, name, 'frames', 'idle-0.png'), 'partial')
    }
    const hourAgo = new Date(Date.now() - 60 * 60_000)
    await utimes(join(pets, folders.oldLive), hourAgo, hourAgo)
    await bakePet('saucer-blue', { home, render: cachedRender })
    assert.deepEqual((await readdir(pets)).sort(), [folders.freshLive, folders.otherLook, 'saucer-blue'].sort())
  })

  test('sweepStale on a home with no pets folder sweeps nothing', async () => {
    assert.deepEqual(await sweepStale(join(await tempHome(), 'pets'), 'kitty-blue'), [])
  })
})

describe('--home takes a folder, never the next option', () => {
  test("'bake kitty-blue --home --json' exits 2 with a JSON error and writes nothing", async () => {
    const cwd = await tempHome()
    const result = await cli(['bake', 'kitty-blue', '--home', '--json'], {}, cwd)
    assert.equal(result.code, 2)
    const line = lastLine(result.stdout)
    assert.equal(line.ok, false)
    assert.match(line.error, /--home needs a folder, not --json/)
    assert.deepEqual(await readdir(cwd), [])
  })

  test('a --home= value starting with - and a --home with nothing after it are refused too', async () => {
    const cwd = await tempHome()
    for (const args of [['bake', 'kitty-blue', '--json', '--home=-x'], ['bake', 'kitty-blue', '--json', '--home'], ['bake', 'kitty-blue', '--json', '--home=']]) {
      const result = await cli(args, {}, cwd)
      assert.equal(result.code, 2, args.join(' '))
      assert.match(lastLine(result.stdout).error, /--home needs a folder/, args.join(' '))
    }
    assert.deepEqual(await readdir(cwd), [])
  })
})
