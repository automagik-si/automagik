import { createElement as h, Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { CHARACTER_COLORS, hasShape, MAIN_LOOK, PICKER_SHAPES, SOLVER_SHAPES, shapeOf } from './characters.js'
import { paintCss } from './inks.js'
import { BotMark, catalogueLookOf, GENIE_PET, lookOf, petOf, servedPet, UNFOLD_PET, useBaked } from './mark.js'
import { PetSprite } from './pet.js'
import { bakeBlobs, canBake } from './pet-bake.js'
import { CloseIcon } from './icons.js'
import { t } from './i18n.js'
import { importPhotos, loadLibrary } from './avatar-library.js'
import { checkViewer, requestViewer, viewerChanged, viewerRefused, viewerResponse } from './viewer.js'
import { isSolverLooks, solverDefaultShape } from './solver-looks.js'

// -------------------------------------------------------------------------
// The character select: where a Bot's look is chosen, as a fighting game's select screen. The
// stage on the left plays the highlighted character big, under a spotlight, with its name; the
// roster on the right lists the twelve Solver characters for Solvers. Other Bots can choose
// photos, Automagik characters, local pets and pets from codex-pets.net. The market is asked
// only once its section is opened. Arrow keys move the cursor, Enter picks, Escape leaves.
// The pick plays a jump before the select closes.

const SORTS = [['popular', 'Most liked'], ['new', 'Newest'], ['views', 'Most viewed'], ['random', 'Surprise me']]
const sourceLine = { builtin: 'Automagik', team: 'Kept by this team', codex: 'From Codex' }
const capitalize = word => word[0].toUpperCase() + word.slice(1)
const slug = text => String(text ?? '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'bot'
const PICK_MS = 900

const shapeEntry = shape => ({ key: `shape:${shape}`, kind: 'shape', shape, name: shapeOf(shape).label, line: 'Automagik character' })

/**
 * The roster's Automagik section: Genie, Omni, the logo pet, Unfold, Wisp, then the characters
 * any Bot may pick (the Solvers have their own section: solversFor).
 * Unfold is there only where the host lists its pet (Unfold's own instance).
 */
export function automagikRoster({ unfold = false } = {}) {
  return [
    { key: 'pet:builtin:genie-clay', kind: 'pet', pet: { ...GENIE_PET, name: 'Genie' }, name: 'Genie', line: 'Automagik' },
    { key: 'omni', kind: 'omni', name: 'Omni', line: 'Automagik' },
    { key: 'pet:builtin:automagik', kind: 'pet', pet: { source: 'builtin', id: 'automagik', name: 'Automagik', version: 2, sleep: true }, name: 'Automagik', line: 'Automagik' },
    ...(unfold ? [{ key: 'pet:builtin:unfold', kind: 'pet', pet: { ...UNFOLD_PET, name: 'Unfold' }, name: 'Unfold', line: 'Automagik' }] : []),
    { key: 'pet:builtin:wisp', kind: 'pet', pet: { source: 'builtin', id: 'wisp', name: 'Wisp', version: 2, sleep: false }, name: 'Wisp', line: 'Automagik' },
    ...PICKER_SHAPES.filter(shape => shape !== 'octopus').map(shapeEntry),
  ]
}

/** The roster's Solvers section: the twelve, in the catalogue's order. */
export const solverRoster = () => SOLVER_SHAPES.map(shapeEntry)
/** The Solvers a Bot's chooser offers: all of them to a Solver Bot, none to any other. */
export const solversFor = bot => (isSolverLooks(bot) ? solverRoster() : [])

/**
 * The tile an Arrow Down (`down` 1) or Arrow Up (-1) reaches from tile `at`, given every tile's
 * { top, left } in roster order: in the nearest row beyond, whatever section it is in, the tile
 * nearest this one's column. A section's last row may be short and the next section starts a
 * row, so counting tiles would drift. -1 when there is no row beyond.
 */
export function tileBeyond(boxes, at, down) {
  const here = boxes[at]
  if (!here) return -1
  const beyond = boxes.map((box, index) => ({ box, index })).filter(({ box }) => (box.top - here.top) * down > 1)
  if (beyond.length === 0) return -1
  const rowTop = beyond.reduce((best, { box }) => ((box.top - best) * down < 0 ? box.top : best), beyond[0].box.top)
  const row = beyond.filter(({ box }) => Math.abs(box.top - rowTop) <= 1)
  return row.reduce((best, entry) => (Math.abs(entry.box.left - here.left) < Math.abs(best.box.left - here.left) ? entry : best), row[0]).index
}

/** Which roster entry a Bot wears now, by its key. */
export function currentKey(bot, look) {
  if (look.image) return 'photo'
  if (look.pet) return `pet:${look.pet.source}:${look.pet.id}`
  if (bot?.kind === 'genie') return 'pet:builtin:genie-clay'
  if (bot?.kind === 'unfold') return 'pet:builtin:unfold'
  if (look.shape === 'octopus' && look.color === 'deepseek') return 'omni'
  return `shape:${look.shape}`
}

async function put(url, blob, active) {
  checkViewer(active)
  const viewer = active?.viewer?.id
  const headers = { 'content-type': 'image/webp', ...(viewer ? { 'x-automagik-viewer': viewer } : {}) }
  const response = await fetch(url, { method: 'PUT', body: blob, headers })
  checkViewer(active)
  const refusal = active && !response.ok ? await viewerResponse(active, response) : undefined
  const answer = refusal ? refusal.answer : await response.json().catch(() => ({}))
  const changed = refusal?.changed ?? (active && viewerChanged(answer))
  if (!refusal) {
    checkViewer(active)
    if (changed) viewerRefused(active, 'bot/viewer-changed')
  }
  if (!response.ok || changed) {
    const message = changed ? answer.error?.message ?? answer.error : answer?.error
    const error = new Error(message ?? t('Codex\'s pets folder could not be written'))
    if (changed) error.code = 'bot/viewer-changed'
    throw error
  }
  return answer
}
/** Writes the Bot's look to ~/.codex/pets as a Codex pet: its own pet's sheet, else its character baked. */
export async function toCodex(bot, look) {
  const active = requestViewer('pet-codex')
  const id = `automagik-${slug(bot.name)}`
  const query = part => `api/omni-ui/pet-codex?${new URLSearchParams({ id, name: bot.name, description: bot.role ?? '', ...(part ? { part } : {}) })}`
  const wants = petOf(bot, look, { live: true, size: 64 })
  let sheet
  let sleep
  if (wants?.served) {
    const served = servedPet(wants.served)
    sheet = await (await fetch(served.sheet)).blob()
    sleep = served.sleep ? await (await fetch(served.sleep)).blob() : undefined
  } else if (wants?.bake) {
    ({ sheet, sleep } = await bakeBlobs(wants.bake, 1))
  } else {
    throw new Error(t('A photo is not a pet: pick a character or a pet first.'))
  }
  await put(query(), sheet, active)
  if (sleep) await put(query('sleep'), sleep, active)
  return id
}

// A roster entry's small portrait: still, as every portrait on a select screen is until chosen.
function Portrait({ item, color }) {
  if (item.image) return h('img', { className: 'bt-cs-poster', src: item.image, alt: '', draggable: false })
  if (item.kind === 'market') return item.pet.poster ? h('img', { className: 'bt-cs-poster', src: item.pet.poster, alt: '', loading: 'lazy', referrerPolicy: 'no-referrer', draggable: false }) : h('span', { className: 'bt-cs-poster' })
  if (item.kind === 'pet') return h(PetSprite, { pet: servedPet(item.pet), size: 58 })
  if (item.kind === 'omni') return h(BotMark, { look: MAIN_LOOK, size: 54 })
  return h(BotMark, { look: { shape: item.shape, color }, size: 50 })
}

// The stage's fighter: the entry playing `state`, big. A character is baked in the picked color
// (shown drawn until its atlas is ready); a pet from codex-pets.net plays from its own sheet.
function Fighter({ item, color, state, onOnce }) {
  const bake = item?.kind === 'shape' ? { shape: item.shape, color } : item?.kind === 'omni' ? { clay: 'omni' } : null
  const baked = useBaked(bake)
  const size = 256
  if (!item) return null
  if (item.image) return h('img', { className: 'bt-cs-photo', src: item.image, alt: '' })
  const pet = item.kind === 'pet' ? servedPet(item.pet)
    : item.kind === 'market' ? (item.pet.sheet ? { sheet: item.pet.sheet, version: item.pet.version } : null)
      : baked
  if (pet) return h(PetSprite, { key: item.key, pet, size, state, live: true, gaze: true, onOnce })
  if (item.kind === 'market') return h('img', { className: 'bt-cs-photo', src: item.pet.poster, alt: '' })
  return h(BotMark, { look: item.kind === 'omni' ? MAIN_LOOK : { shape: item.shape, color }, size: 200, live: true, gaze: true, state: state === 'done' ? 'done' : 'idle' })
}

function useMarket(actions, open) {
  const [query, setQuery] = useState('')
  const [sort, setSort] = useState('popular')
  const [market, setMarket] = useState({ pets: [], page: 0, pages: 1, state: 'idle' })
  const asked = useRef(0)
  const load = (page, reset) => {
    const ask = ++asked.current
    setMarket(state => ({ ...state, state: 'loading', ...(reset ? { pets: [] } : {}) }))
    actions.petsBrowse(query, page, sort).then((next) => {
      if (ask !== asked.current) return
      setMarket(state => ({ pets: reset ? next.pets : [...state.pets, ...next.pets], page: next.page, pages: next.pages, state: 'ready' }))
    }, () => { if (ask === asked.current) setMarket(state => ({ ...state, state: 'offline' })) })
  }
  useEffect(() => {
    if (!open) return undefined
    const timer = setTimeout(() => load(1, true), query ? 350 : 0)
    return () => clearTimeout(timer)
  }, [open, query, sort])
  return { query, setQuery, sort, setSort, market, more: () => load(market.page + 1, false) }
}

export function CharacterSelect({ bot, actions, run, onClose, avatarImage }) {
  const solver = isSolverLooks(bot)
  const look = lookOf(bot)
  const stored = catalogueLookOf(bot)
  const [swatch, setSwatch] = useState(null)
  const color = swatch ?? look.color
  const [local, setLocal] = useState([])
  const [unfold, setUnfold] = useState(false)
  const [browse, setBrowse] = useState(false)
  const market = useMarket(actions, browse && !solver)
  const [focus, setFocus] = useState(null)
  const [chosen, setChosen] = useState(null)
  const [stage, setStage] = useState('idle')
  const [picking, setPicking] = useState(false)
  const [note, setNote] = useState('')
  // The photos imported once (the avatar library), any of which a Bot can wear.
  const [library, setLibrary] = useState([])
  const fileRef = useRef(null)
  const gridRef = useRef(null)
  const colorsRef = useRef(null)
  const ordinaryChooser = useRef(null)
  // An upload belongs to this opening for this ordinary Bot. Keep the avatar fresh
  // without carrying an upload across unmounts, Bot changes or identity changes.
  useLayoutEffect(() => {
    if (solver) return undefined
    ordinaryChooser.current = {}
    return () => { ordinaryChooser.current = null }
  }, [bot.id, solver])
  useLayoutEffect(() => {
    if (ordinaryChooser.current) ordinaryChooser.current.avatar = bot.avatar
  })
  useEffect(() => {
    if (solver) return
    void actions.pets().then((list) => {
      setLocal(list.filter(pet => pet.source !== 'builtin'))
      setUnfold(list.some(pet => pet.source === 'builtin' && pet.id === 'unfold'))
    }, () => setLocal([]))
  }, [solver])
  const loadPhotos = () => loadLibrary(actions).then(page => setLibrary(page.items), () => setLibrary([]))
  useEffect(() => { if (!solver) void loadPhotos() }, [solver])

  const ours = useMemo(() => automagikRoster({ unfold }), [unfold])
  const solvers = solver ? solverRoster() : []
  const yours = local.map(pet => ({ key: `pet:${pet.source}:${pet.id}`, kind: 'pet', pet, name: pet.name, line: sourceLine[pet.source] ?? pet.source }))
  const theirs = market.market.pets.map(pet => ({ key: `market:${pet.id}`, kind: 'market', pet, name: pet.name, line: pet.by ? t('by {name}', { name: pet.by }) : 'codex-pets.net' }))
  const photo = look.image ? [{ key: 'photo', kind: 'photo', image: look.image, name: t('Photo'), line: t('Uploaded') }] : []
  const photos = library.filter(entry => entry.image !== look.image).map(entry => ({ key: `library:${entry.id}`, kind: 'library', image: entry.image, name: entry.name || t('Photo'), line: t('Your photos') }))
  const all = solver ? solvers : [...photo, ...photos, ...ours, ...yours, ...theirs]
  const pressed = currentKey(bot, stored)
  const worn = currentKey(bot, look)
  // An eligible worn character can still preview without a tile, such as a recolored octopus.
  const wornShape = worn === `shape:${look.shape}` && hasShape(look.shape)
    && SOLVER_SHAPES.includes(look.shape) === solver ? shapeEntry(look.shape) : null
  const defaultKey = solver ? `shape:${solverDefaultShape(bot.id)}` : currentKey(bot, catalogueLookOf({ ...bot, avatar: undefined }))
  const item = all.find(entry => entry.key === focus) ?? all.find(entry => entry.key === worn) ?? wornShape
    ?? all.find(entry => entry.key === defaultKey) ?? ours[0]
  const focused = item.key
  const selected = chosen?.solver === solver ? all.find(entry => entry.key === chosen.key) : undefined
  if (chosen !== null && !selected) setChosen(null)

  // A new highlight greets: the fighter waves once, then stands.
  const move = (key) => { if (key !== focused) { setFocus(key); setStage('poked') } }
  const choose = (key) => {
    setFocus(key)
    if (key !== focused) setStage('poked')
    setChosen({ key, solver })
  }
  const pick = (entry) => {
    if (picking || !entry) return
    choose(entry.key)
    setPicking(true)
    setStage('done')
    const save = entry.kind === 'shape' ? actions.updateBot(bot.id, { avatar: { shape: entry.shape }, color })
      : entry.kind === 'omni' ? actions.updateBot(bot.id, { avatar: { shape: 'octopus' }, color: 'deepseek' })
        : entry.kind === 'pet' ? actions.petUse(bot.id, entry.pet.source, entry.pet.id)
          : entry.kind === 'market' ? actions.petUse(bot.id, 'market', entry.pet.id)
            : entry.kind === 'library' ? actions.updateBot(bot.id, { avatar: { ...(bot.avatar ?? {}), image: entry.image } })
              : Promise.resolve()
    const wait = new Promise(resolve => setTimeout(resolve, PICK_MS))
    void run(Promise.all([save, wait]).then(() => onClose(), (error) => { setPicking(false); setStage('idle'); throw error }))
  }
  const commit = () => {
    if (picking) return
    if (selected) { pick(selected); return }
    if (item.kind !== 'shape' || color === look.color) { onClose(); return }
    setPicking(true)
    void run(actions.updateBot(bot.id, { color }).then(() => onClose(), (error) => { setPicking(false); throw error }))
  }
  // One photo is worn at once, as before; every photo also goes into the library, so a
  // later character does not lose it, and several at once only fill the library.
  const upload = async (files) => {
    const chooser = ordinaryChooser.current
    if (!chooser || files.length === 0) return
    const read = await Promise.all(files.map(file => avatarImage(file).then(image => ({ name: file.name, image }), failure => ({ name: file.name, failure }))))
    const unread = read.filter(photo => photo.failure)
    const result = await importPhotos(read.filter(photo => !photo.failure), actions)
    if (ordinaryChooser.current !== chooser) return
    const failed = [...unread.map(photo => photo.name), ...result.failed.map(photo => photo.name)]
    if (files.length === 1 && unread.length === 0) {
      await actions.updateBot(bot.id, { avatar: { ...chooser.avatar, image: read[0].image } })
      if (ordinaryChooser.current === chooser) onClose()
      return
    }
    await loadPhotos()
    setNote([
      result.imported.length > 0 ? t('{count} photos added to Yours.', { count: result.imported.length }) : '',
      failed.length > 0 ? t('Not added: {names}', { names: failed.join(', ') }) : '',
    ].filter(Boolean).join(' '))
  }

  // The cursor moves through the tiles in their grid: across a row, and a row up or down.
  const onKeyDown = (event) => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose(); return }
    // Ordinary rosters start with pets. Go directly back to the colors so those
    // tiles do not take over the stage and remove the swatches along the way.
    if (!solver && event.key === 'Tab' && event.shiftKey && event.target?.dataset?.key === focused) {
      const lastSwatch = colorsRef.current?.lastElementChild
      if (lastSwatch) { event.preventDefault(); lastSwatch.focus(); return }
    }
    if (event.key === 'Enter' || event.key === ' ') {
      const entry = all.find(item => item.key === event.target?.dataset?.key)
      if (event.key === 'Enter') {
        event.preventDefault()
        if (entry) pick(entry)
        else commit()
      } else if (entry) {
        event.preventDefault()
        choose(entry.key)
      }
      return
    }
    if (event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement) return
    const tiles = [...(gridRef.current?.querySelectorAll('.bt-cs-tile') ?? [])]
    const at = tiles.findIndex(tile => tile.dataset.key === focused)
    const across = { ArrowRight: 1, ArrowLeft: -1 }[event.key]
    const down = { ArrowDown: 1, ArrowUp: -1 }[event.key]
    if ((across === undefined && down === undefined) || at < 0) return
    event.preventDefault()
    const next = across !== undefined
      ? tiles[Math.max(0, Math.min(tiles.length - 1, at + across))]
      // Layout offsets, not the drawn box: the tile under the cursor is drawn lifted.
      : tiles[tileBeyond(tiles.map(tile => ({ top: tile.offsetTop, left: tile.offsetLeft })), at, down)]
    if (next && next !== tiles[at]) { choose(next.dataset.key); next.focus() }
  }
  useLayoutEffect(() => { gridRef.current?.querySelector(`[data-key="${CSS.escape(focused)}"]`)?.focus({ preventScroll: false }) }, [])

  const tile = entry => h('button', {
    key: entry.key, type: 'button', className: 'bt-cs-tile', 'data-key': entry.key,
    'aria-pressed': entry.key === pressed, 'data-focus': entry.key === focused || undefined,
    title: entry.name, onClick: () => { if (entry.key === focused) pick(entry); else choose(entry.key) },
    // Tabbing to a tile moves the cursor there; a click's own focus does not, or its click would pick.
    onFocus: (event) => { if (event.currentTarget.matches(':focus-visible')) move(entry.key) },
    onDoubleClick: () => pick(entry),
  },
  h('span', { className: 'bt-cs-face' }, h(Portrait, { item: entry, color })),
  h('span', { className: 'bt-cs-tile-name' }, entry.name),
  entry.key === focused ? h('span', { className: 'bt-cs-p1', 'aria-hidden': true }, 'P1') : null)
  const section = (label, entries, extra) => h('section', { className: 'bt-cs-sec' },
    h('h3', { className: 'bt-cs-label' }, label, extra ?? null),
    entries.length > 0 ? h('div', { className: 'bt-cs-grid' }, entries.map(tile)) : null)

  const showsColor = item?.kind === 'shape'
  return createPortal(h('div', { className: 'bt-cs-layer', onKeyDown },
    h('div', { className: 'bt-scrim', onMouseDown: onClose }),
    h('div', { className: 'bt-cs', role: 'dialog', 'aria-modal': true, 'aria-label': t('Choose {name}\'s character', { name: bot.name }) },
      h('div', { className: 'bt-cs-stage', 'data-picking': picking || undefined },
        h('div', { className: 'bt-cs-spot', 'aria-hidden': true }),
        h('div', { className: 'bt-cs-floor', 'aria-hidden': true }),
        h('div', { className: 'bt-cs-fighter' }, h(Fighter, { item, color, state: stage, onOnce: () => { if (!picking) setStage('idle') } })),
        h('div', { className: 'bt-cs-plate' },
          h('div', { className: 'bt-cs-name' }, item?.name ?? ''),
          h('div', { className: 'bt-cs-line' }, t(item?.line ?? ''))),
        showsColor ? h('div', { ref: colorsRef, className: 'bt-cs-colors', role: 'group', 'aria-label': t('Character color') }, CHARACTER_COLORS.map(ink => h('button', {
          key: ink, type: 'button', className: 'bt-cs-color', 'aria-label': t(capitalize(ink)), title: t(capitalize(ink)), 'aria-pressed': color === ink,
          onClick: () => setSwatch(ink),
        }, h('span', { style: { background: paintCss(ink) } })))) : null,
        h('button', { type: 'button', className: 'bt-cs-go', disabled: picking, onClick: commit }, picking ? t('Chosen!') : t('Choose')),
        h('div', { className: 'bt-cs-links' },
          solver ? null : h('button', { type: 'button', className: 'bt-cs-link', onClick: () => fileRef.current?.click() }, t('Add photos')),
          canBake() ? h('button', { type: 'button', className: 'bt-cs-link', onClick: () => { setNote('…'); toCodex(bot, look).then(id => setNote(t('In Codex as {id}. Pick it in Codex\'s pet menu.', { id })), error => setNote(error?.message ?? String(error))) } }, t('Use in Codex')) : null,
          h('button', { type: 'button', className: 'bt-cs-link', onClick: () => run(actions.updateBot(bot.id, solver
            ? { avatar: { shape: solverDefaultShape(bot.id) } }
            : { avatar: null, color: null }).then(() => onClose())) }, t('Default look'))),
        note ? h('p', { className: 'bt-cs-note', role: 'status' }, note) : null,
        solver ? null : h('input', { ref: fileRef, type: 'file', multiple: true, accept: 'image/png,image/jpeg,image/webp,image/gif', hidden: true, onChange: (event) => { const files = [...(event.target.files ?? [])]; event.target.value = ''; void run(upload(files)) } })),
      h('div', { className: 'bt-cs-roster' },
        h('div', { className: 'bt-cs-head' },
          h('div', null,
            h('h2', { className: 'bt-cs-title' }, t('Choose a character')),
            h('p', { className: 'bt-cs-sub' }, t('For {name}. Arrow keys move, Enter picks.', { name: bot.name }))),
          h('button', { type: 'button', className: 'bt-icon-btn', 'aria-label': t('Close'), onClick: onClose }, h(CloseIcon))),
        h('div', { ref: gridRef, className: 'bt-cs-scroll' },
          !solver && photo.length + photos.length > 0 ? section(t('Yours'), [...photo, ...photos]) : null,
          solver ? section(t('Solvers'), solvers) : section('Automagik', ours),
          !solver && yours.length > 0 ? section(t('Your pets'), yours) : null,
          solver ? null : h('section', { className: 'bt-cs-sec' },
            h('h3', { className: 'bt-cs-label' }, 'codex-pets.net',
              browse ? h('select', { className: 'bt-input bt-cs-sort', value: market.sort, 'aria-label': t('Order'), onChange: event => market.setSort(event.target.value) },
                SORTS.map(([id, label]) => h('option', { key: id, value: id }, t(label)))) : null),
            !browse
              ? h('button', { type: 'button', className: 'bt-cs-browse', onClick: () => setBrowse(true) },
                  h('span', { className: 'bt-cs-browse-title' }, t('Browse codex-pets.net')),
                  h('span', { className: 'bt-cs-browse-line' }, t('Thousands of pets shared by the Codex community, in the same format. Opening it asks codex-pets.net; a pet you pick is kept on this computer.')))
              : h(Fragment, null,
                  h('input', { className: 'bt-input bt-cs-search', type: 'search', value: market.query, placeholder: t('Search pets'), 'aria-label': t('Search pets'), onChange: event => market.setQuery(event.target.value) }),
                  market.market.state === 'offline' && theirs.length === 0 ? h('p', { className: 'bt-cs-note' }, t('codex-pets.net could not be reached.'))
                    : h('div', { className: 'bt-cs-grid' }, theirs.map(tile)),
                  market.market.state === 'ready' && theirs.length === 0 ? h('p', { className: 'bt-cs-note' }, t('No pets match.')) : null,
                  market.market.state === 'ready' && market.market.page < market.market.pages ? h('button', { type: 'button', className: 'bt-soft bt-soft-sm bt-cs-more', onClick: market.more }, t('More pets')) : null)))))), document.body)
}

export const CHARACTER_SELECT_CSS = `
.bt-cs-layer{position:fixed;inset:var(--dsh-frame-chrome-top,0px) 0 0;z-index:62;display:flex;align-items:center;justify-content:center;font-family:var(--bt-font)}
.bt-cs{position:relative;display:grid;grid-template-columns:380px minmax(0,1fr);width:min(1080px,96vw);height:min(680px,92vh);border-radius:22px;overflow:hidden;background:var(--bt-main);color:var(--bt-ink);box-shadow:0 30px 80px -20px rgba(0,0,0,.55),0 0 0 1px var(--bt-line);animation:bt-cs-in .32s cubic-bezier(.2,.9,.3,1.2)}
.bt-cs-stage{position:relative;display:flex;flex-direction:column;align-items:center;gap:10px;padding:26px 24px 20px;overflow:hidden;color:var(--bt-arena-ink);background:radial-gradient(120% 70% at 50% 0%,var(--bt-arena-2),var(--bt-arena) 70%);isolation:isolate}
.bt-cs-stage:before{content:"";position:absolute;inset:0;z-index:-1;background:repeating-linear-gradient(0deg,color-mix(in srgb,var(--bt-arena-ink) 4%,transparent) 0 1px,transparent 1px 4px);pointer-events:none}
.bt-cs-spot{position:absolute;left:50%;top:-30%;width:150%;height:110%;transform:translateX(-50%);z-index:-1;background:radial-gradient(closest-side,color-mix(in srgb,var(--bt-magic-violet) 42%,transparent),transparent);filter:blur(6px);animation:bt-cs-spot 6s ease-in-out infinite alternate}
.bt-cs-floor{position:absolute;left:50%;top:356px;width:260px;height:46px;transform:translateX(-50%);z-index:-1;border-radius:50%;background:radial-gradient(closest-side,color-mix(in srgb,var(--bt-magic-cyan) 55%,transparent),color-mix(in srgb,var(--bt-magic-pink) 25%,transparent) 60%,transparent);filter:blur(2px)}
.bt-cs-fighter{display:flex;align-items:flex-end;justify-content:center;height:280px;margin-top:44px;filter:drop-shadow(0 16px 18px rgba(0,0,0,.45))}
.bt-cs-photo{width:200px;height:200px;object-fit:cover;border-radius:50%;box-shadow:0 0 0 4px color-mix(in srgb,var(--bt-arena-ink) 20%,transparent)}
.bt-cs-stage[data-picking]:after{content:"";position:absolute;inset:0;background:var(--bt-arena-ink);animation:bt-cs-flash .5s ease-out forwards;pointer-events:none}
.bt-cs-plate{text-align:center;margin-top:6px}
.bt-cs-name{font:italic var(--bt-weight-title,900) 34px/38px var(--bt-head-font,var(--bt-font));letter-spacing:.02em;text-transform:uppercase;background:linear-gradient(90deg,var(--bt-magic-cyan),var(--bt-magic-violet),var(--bt-magic-pink));-webkit-background-clip:text;background-clip:text;color:transparent;filter:drop-shadow(0 2px 0 rgba(0,0,0,.35))}
.bt-cs-line{font:600 12px/16px var(--bt-font);letter-spacing:.12em;text-transform:uppercase;color:color-mix(in srgb,var(--bt-arena-ink) 62%,transparent)}
.bt-cs-colors{display:flex;flex-wrap:wrap;justify-content:center;gap:6px;max-width:300px}
.bt-cs-color{width:22px;height:22px;padding:2px;border:0;border-radius:50%;background:transparent;cursor:pointer}
.bt-cs-color span{display:block;width:100%;height:100%;border-radius:50%;box-shadow:inset 0 0 0 1px rgba(0,0,0,.2)}
.bt-cs-color[aria-pressed=true]{box-shadow:0 0 0 2px var(--bt-arena-ink)}
.bt-cs-go{margin-top:auto;min-width:200px;padding:12px 28px;border:0;border-radius:999px;background:linear-gradient(90deg,var(--bt-magic-cyan),var(--bt-magic-violet),var(--bt-magic-pink));color:var(--bt-arena-ink);font:italic var(--bt-weight-strong,800) 18px/22px var(--bt-head-font,var(--bt-font));letter-spacing:.06em;text-transform:uppercase;cursor:pointer;box-shadow:0 8px 24px -8px var(--bt-magic-pink);transition:transform .12s ease,filter .12s ease}
.bt-cs-go:hover:not(:disabled){transform:translateY(-1px) scale(1.02);filter:brightness(1.08)}
.bt-cs-go:disabled{opacity:.6;cursor:default}
.bt-cs-links{display:flex;flex-wrap:wrap;justify-content:center;gap:4px 14px}
.bt-cs-link{border:0;background:none;padding:2px;color:color-mix(in srgb,var(--bt-arena-ink) 70%,transparent);font:500 12px/16px var(--bt-font);cursor:pointer;text-decoration:underline;text-underline-offset:3px}
.bt-cs-link:hover{color:var(--bt-arena-ink)}
.bt-cs-stage .bt-cs-note{color:color-mix(in srgb,var(--bt-arena-ink) 70%,transparent);text-align:center}
.bt-cs-roster{display:flex;flex-direction:column;min-height:0}
.bt-cs-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;padding:22px 22px 10px}
.bt-cs-title{margin:0;font:var(--bt-weight-title,800) 22px/28px var(--bt-head-font,var(--bt-font))}
.bt-cs-sub{margin:2px 0 0;font-size:12px;line-height:16px;color:var(--bt-ink-2)}
.bt-cs-scroll{flex:1;min-height:0;overflow-y:auto;padding:4px 22px 22px;display:flex;flex-direction:column;gap:16px}
.bt-cs-sec{display:flex;flex-direction:column;gap:10px}
.bt-cs-label{display:flex;align-items:center;justify-content:space-between;gap:8px;margin:0;font:700 12px/16px var(--bt-font);letter-spacing:.1em;text-transform:uppercase;color:var(--bt-ink-2)}
.bt-cs-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(86px,1fr));gap:10px}
.bt-cs-tile{position:relative;display:flex;flex-direction:column;align-items:center;justify-content:flex-end;gap:4px;aspect-ratio:1/1.08;padding:6px 4px 8px;border:0;border-radius:16px;background:var(--bt-sidebar);box-shadow:inset 0 0 0 1px var(--bt-line);color:var(--bt-ink);cursor:pointer;min-width:0;transition:transform .12s ease,box-shadow .12s ease,background .12s ease;outline:none}
.bt-cs-tile:hover{background:var(--bt-card)}
.bt-cs-face{flex:1;display:flex;align-items:center;justify-content:center;min-height:0}
.bt-cs-poster{display:block;width:58px;height:58px;object-fit:contain}
.bt-cs-tile-name{max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font:600 11px/14px var(--bt-font)}
.bt-cs-tile[aria-pressed=true]{box-shadow:inset 0 0 0 2px color-mix(in srgb,var(--bt-magic-cyan) 70%,transparent)}
.bt-cs-tile[data-focus]{transform:translateY(-2px) scale(1.05);background:var(--bt-card);box-shadow:0 0 0 2px var(--bt-magic-pink),0 8px 22px -6px color-mix(in srgb,var(--bt-magic-pink) 60%,transparent);animation:bt-cs-cursor 1.1s ease-in-out infinite}
.bt-cs-p1{position:absolute;top:-8px;left:-6px;padding:1px 6px;border-radius:999px;background:var(--bt-magic-pink);color:var(--bt-arena-ink);font:italic 900 10px/14px var(--bt-font);letter-spacing:.04em}
.bt-cs-browse{display:flex;flex-direction:column;align-items:flex-start;gap:4px;width:100%;padding:14px 16px;border:1px dashed var(--bt-line-2);border-radius:16px;background:transparent;color:var(--bt-ink);text-align:left;cursor:pointer}
.bt-cs-browse:hover{background:var(--bt-sidebar)}
.bt-cs-browse-title{font:700 14px/20px var(--bt-font)}
.bt-cs-browse-line{font:400 12px/16px var(--bt-font);color:var(--bt-ink-2)}
.bt-cs-search{width:100%;min-height:34px;padding:6px 12px}
.bt-cs-sort{max-width:160px;text-transform:none;letter-spacing:0}
.bt-cs-more{align-self:center}
.bt-cs-note{margin:0;font-size:12px;line-height:16px;color:var(--bt-ink-2)}
@keyframes bt-cs-in{from{opacity:0;transform:scale(.96) translateY(8px)}to{opacity:1;transform:none}}
@keyframes bt-cs-spot{from{transform:translateX(-54%)}to{transform:translateX(-46%)}}
@keyframes bt-cs-cursor{50%{box-shadow:0 0 0 2px var(--bt-magic-cyan),0 8px 22px -6px color-mix(in srgb,var(--bt-magic-cyan) 60%,transparent)}}
@keyframes bt-cs-flash{from{opacity:.55}to{opacity:0}}
@media (max-width:760px){.bt-cs{grid-template-columns:1fr;grid-template-rows:auto minmax(0,1fr);height:94vh}.bt-cs-stage{padding:14px}.bt-cs-fighter{height:150px;margin-top:0}.bt-cs-floor{top:150px}}
@media (prefers-reduced-motion:reduce){.bt-cs,.bt-cs-spot,.bt-cs-tile[data-focus]{animation:none}.bt-cs-stage[data-picking]:after{display:none}}
body[data-bt-motion=quiet] :is(.bt-cs-spot,.bt-cs-tile[data-focus]){animation:none}
`
