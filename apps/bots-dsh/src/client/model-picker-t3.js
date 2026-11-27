/*! Ported from T3 Code (https://github.com/pingdotgg/t3code) at 0b6b173244314899ff1a26524e56994adce88c8d,
 * apps/web/src/components/chat/{modelPickerKeys.ts,ModelPickerContent.tsx,ComposerModelEffort.tsx}.
 * @license MIT. Copyright (c) 2026 T3 Tools Inc. Full text in apps/bots-dsh/NOTICE. */
// The model picker's pure logic, ported from T3 Code's composer picker so the composer's
// picker behaves as T3's does: one key per model row across providers, the provider rail's
// Up/Down order (favorites first, wrapping), the effort column's Up/Down and type-to-find, and
// the ⌘1…⌘9 jumps to the first nine rows. Ported to plain JavaScript; the rendering is
// Automagik's own (model-menu.js DockedPicker), in its brand tokens.

const MODEL_KEY_PREFIX = 'model:'

/** One row's key: the provider's length first, so a provider id with ':' never splits wrong. */
export function modelPickerModelKey(instanceId, slug) {
  return `${MODEL_KEY_PREFIX}${instanceId.length}:${instanceId}${slug}`
}

export function parseModelPickerModelKey(key) {
  if (typeof key !== 'string' || !key.startsWith(MODEL_KEY_PREFIX)) return null
  const encoded = key.slice(MODEL_KEY_PREFIX.length)
  const separatorIndex = encoded.indexOf(':')
  if (separatorIndex === -1) return null
  const instanceIdLengthText = encoded.slice(0, separatorIndex)
  if (!/^\d+$/.test(instanceIdLengthText)) return null
  const instanceIdLength = Number(instanceIdLengthText)
  const value = encoded.slice(separatorIndex + 1)
  if (!Number.isSafeInteger(instanceIdLength) || instanceIdLength > value.length) return null
  return { instanceId: value.slice(0, instanceIdLength), slug: value.slice(instanceIdLength) }
}

export const FAVORITES = 'favorites'

/**
 * The rail tab Up (-1) or Down (1) moves to: favorites, then every tab that can be picked,
 * wrapping at both ends. A selection not in the list starts from the first (Down) or last (Up).
 * @param {{ tabs: Array<{ id: string, disabled?: boolean }>, selected: string, direction: 1 | -1 }} input
 */
export function adjacentModelPickerProvider({ tabs, selected, direction }) {
  const providers = [FAVORITES, ...tabs.filter(tab => !tab.disabled).map(tab => tab.id)]
  const index = providers.indexOf(selected)
  return providers[index < 0
    ? (direction === 1 ? 0 : providers.length - 1)
    : (index + direction + providers.length) % providers.length]
}

/** The nth row (0-based) a ⌘1…⌘9 (Ctrl elsewhere) press jumps to, else -1. */
export function modelJumpIndex(event, mac) {
  if (event.altKey || event.shiftKey || (mac ? !event.metaKey || event.ctrlKey : !event.ctrlKey || event.metaKey)) return -1
  return /^[1-9]$/.test(event.key) ? Number(event.key) - 1 : -1
}

/** The label a row shows for its jump: ⌘1 on a Mac, Ctrl+1 elsewhere. */
export const modelJumpLabel = (index, mac) => (index < 9 ? `${mac ? '⌘' : 'Ctrl+'}${index + 1}` : null)

export const isMacPlatform = () => /Mac|iPhone|iPad|iPod/.test(globalThis.navigator?.platform ?? '')

/**
 * Up and Down move between the effort column's rows; a typed letter moves to the next row whose
 * label starts with it. True when it moved the focus.
 * @param {KeyboardEvent} event
 * @param {HTMLElement} column
 */
export function moveBetweenRows(event, column) {
  const arrow = event.key === 'ArrowDown' || event.key === 'ArrowUp'
  if (!arrow && (event.key.length !== 1 || event.key.trim() === '' || event.ctrlKey || event.altKey || event.metaKey || event.isComposing)) return false
  if (!column?.contains(event.target)) return false
  const rows = Array.from(column.querySelectorAll('[data-effort-row]:not(:disabled)'))
  const index = rows.findIndex(row => row === column.ownerDocument.activeElement)
  const next = arrow
    ? rows[Math.min(rows.length - 1, Math.max(0, index + (event.key === 'ArrowDown' ? 1 : -1)))]
    : [...rows.slice(index + 1), ...rows.slice(0, index + 1)].find(row =>
        row.dataset.effortLevel?.toLowerCase().startsWith(event.key.toLowerCase()))
  if (!next) return false
  event.preventDefault()
  event.stopPropagation()
  next.focus()
  next.scrollIntoView?.({ block: 'nearest' })
  return true
}

/**
 * The search box's filter: every word of the query is found in the model's name, ref or
 * provider name, ignoring case.
 */
export function matchesModelSearch(query, fields) {
  const words = String(query ?? '').toLowerCase().split(/\s+/).filter(Boolean)
  if (words.length === 0) return true
  const haystack = fields.filter(Boolean).join(' ').toLowerCase()
  return words.every(word => haystack.includes(word))
}
