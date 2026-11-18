import { createElement as h, useEffect, useState } from 'react'
import { call } from './api.js'
import { characterSvg, COLORS, Egg, Hero, SHAPES, swatchOf, useCompanion } from './companion-art.js'
import { Stage, useFinish, useGate, useGlitch } from './stage.js'
import { t } from './i18n.js'

// Step omni-companion (order -300): the person creates their own companion, which becomes
// their Main Bot. Describe it (an image model draws it, with ChatGPT or an OpenAI key
// connected) or pick one of Omni's characters; then name it. Its copy, the ideas included,
// follows the DSH language (i18n.js); the name ideas are names, in any language.
export const IDEAS = ['a sleepy cyan fox with a lantern tail', 'a tiny robot made of moonlight', 'a round jellyfish that wears headphones']
const NAMES = ['Pirlim', 'Nova', 'Mochi', 'Echo', 'Biscuit']
const NAME_RULE = /^[\p{L}\p{N}][\p{L}\p{N} ._-]{0,39}$/u
// A Bot's avatar holds at most 160 KB, so the drawing is shrunk to a small square for it.
const AVATAR_SIZE = 256
const MAX_AVATAR = 160_000

// The drawing as a square avatar, cropped to cover; nothing when the browser cannot shrink it.
async function avatarOf(src) {
  try {
    const picture = new Image()
    picture.src = src
    await picture.decode()
    const canvas = document.createElement('canvas')
    canvas.width = AVATAR_SIZE
    canvas.height = AVATAR_SIZE
    const side = Math.min(picture.naturalWidth, picture.naturalHeight)
    canvas.getContext('2d').drawImage(picture, (picture.naturalWidth - side) / 2, (picture.naturalHeight - side) / 2, side, side, 0, 0, AVATAR_SIZE, AVATAR_SIZE)
    const small = [canvas.toDataURL('image/webp', 0.86), canvas.toDataURL('image/png')].find(url => /^data:image\/(webp|png);/.test(url) && url.length <= MAX_AVATAR)
    return small
  } catch {
    return undefined
  }
}

export function CompanionStep(props) {
  const state = useGate(props)
  const finish = useFinish(props)
  const [glitching, glitch] = useGlitch()
  const [, setLook] = useCompanion()
  const [caps, setCaps] = useState(null)
  const [mode, setMode] = useState('pick')
  const [shape, setShape] = useState(null)
  const [color, setColor] = useState('cyan')
  const [description, setDescription] = useState('')
  const [image, setImage] = useState(null)
  const [drawing, setDrawing] = useState(false)
  const [name, setName] = useState('')
  const [problem, setProblem] = useState(null)
  const [saving, setSaving] = useState(false)
  const [hatching, setHatching] = useState(false)

  useEffect(() => {
    call('companion').then((reply) => {
      setCaps(reply)
      if (reply?.generate) setMode('describe')
    }).catch(() => setCaps({ generate: null }))
  }, [])
  useEffect(() => { if (state) glitch() }, [state, glitch])
  if (!state) return null

  const generating = caps?.generate
  const look = image ? { src: image, name } : shape ? { shape, color, name } : null
  const nameOk = NAME_RULE.test(name.trim())
  const ready = look !== null && nameOk && !saving

  const draw = async () => {
    setProblem(null)
    setDrawing(true)
    try {
      const reply = await call('companion-generate', { description })
      setImage(reply.image)
      glitch()
    } catch (error) {
      setProblem(error.message)
    } finally {
      setDrawing(false)
    }
  }

  const hatch = async () => {
    if (!ready) return
    setSaving(true)
    setProblem(null)
    try {
      const avatar = image ? await avatarOf(image) : undefined
      await call('companion-save', { name: name.trim(), ...(image ? { image, ...(avatar ? { avatar } : {}) } : { shape, color }) })
      setLook({ ...(image ? { src: image } : { shape, color }), name: name.trim() })
      setHatching(true)
      setTimeout(() => finish(), 1100)
    } catch (error) {
      setProblem(error.message)
      setSaving(false)
    }
  }

  const speech = look ? (nameOk ? t('I\'m {name}! Ready when you are.', { name: name.trim() }) : t('Oh, that\'s me! What\'s my name?')) : t('Hi! I\'m going to be yours. What should I look like?')
  const hero = look ? h(Hero, { look, hatching }) : h(Egg)

  return h(Stage, { title: t('Create your companion'), speech, at: 'omni-companion', glitching, hero },
    h('p', { className: 'oai-lede' }, t('Your companion runs your team: it talks with you, hands work to the others and keeps an eye on everything. Make it yours.')),
    h('div', { className: 'oai-seg', role: 'tablist', 'aria-label': t('How to make it') },
      h('button', { type: 'button', role: 'tab', 'aria-selected': mode === 'describe', onClick: () => setMode('describe') }, t('Describe it')),
      h('button', { type: 'button', role: 'tab', 'aria-selected': mode === 'pick', onClick: () => setMode('pick') }, t('Pick one'))),
    mode === 'describe'
      ? h('div', { className: 'oai-describe' },
          h('label', { htmlFor: 'oai-desc' }, t('What does it look like?')),
          h('textarea', { id: 'oai-desc', rows: 2, value: description, placeholder: t(IDEAS[0]), onChange: event => setDescription(event.target.value), disabled: drawing }),
          h('div', { className: 'oai-chips' }, IDEAS.map(idea => h('button', { key: idea, type: 'button', className: 'oai-chip', onClick: () => setDescription(t(idea)) }, t(idea)))),
          generating
            ? h('div', { className: 'oai-row' },
                h('button', { type: 'button', className: 'oai-primary', disabled: drawing || description.trim().length < 3 || !generating.ready, onClick: draw }, drawing ? t('Drawing…') : image ? t('Draw again') : t('Bring it to life')),
                h('span', { className: 'oai-muted' }, generating.kind === 'codex' ? t('Drawn with Codex on your ChatGPT plan') : generating.kind === 'chatgpt' ? t('Drawn with your ChatGPT plan (gpt-image-2)') : t('Drawn with your OpenAI key (gpt-image-1)')))
            : h('p', { className: 'oai-note' }, t('Drawing a companion needs Codex signed in. Sign in to Codex in the AI step, then come back from Settings. For now, pick one.')),
          drawing ? h('div', { className: 'oai-drawing', 'aria-hidden': 'true' }) : null)
      : h('div', { className: 'oai-pick' },
          h('div', { className: 'oai-shapes', role: 'radiogroup', 'aria-label': t('Character') },
            SHAPES.map(id => h('button', {
              key: id, type: 'button', role: 'radio', 'aria-checked': shape === id && !image, 'aria-label': id, className: 'oai-shape',
              onClick: () => { setImage(null); setShape(id) },
              dangerouslySetInnerHTML: { __html: characterSvg(id, color, 54) },
            }))),
          h('div', { className: 'oai-swatches', role: 'radiogroup', 'aria-label': t('Color') },
            COLORS.map(id => h('button', { key: id, type: 'button', role: 'radio', 'aria-checked': color === id, 'aria-label': id, className: 'oai-swatch', style: { background: swatchOf(id) }, onClick: () => setColor(id) })))),
    h('div', { className: 'oai-name' },
      h('label', { htmlFor: 'oai-name' }, t('Its name')),
      h('div', { className: 'oai-row' },
        h('input', { id: 'oai-name', value: name, maxLength: 40, placeholder: NAMES[0], autoComplete: 'off', onChange: event => setName(event.target.value), onKeyDown: event => { if (event.key === 'Enter') void hatch() } }),
        h('div', { className: 'oai-chips' }, NAMES.map(option => h('button', { key: option, type: 'button', className: 'oai-chip', onClick: () => setName(option) }, option))))),
    problem ? h('p', { className: 'oai-error', role: 'alert' }, problem) : null,
    h('div', { className: 'oai-actions' },
      h('button', { type: 'button', className: 'oai-primary oai-big', disabled: !ready, onClick: hatch }, saving ? t('Hatching…') : nameOk ? t('Hatch {name}', { name: name.trim() }) : t('Hatch'))))
}
