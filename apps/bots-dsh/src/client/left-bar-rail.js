import { createElement as h } from 'react'
import { StatusMark, statusOr, word } from './left-bar-status.js'

// -------------------------------------------------------------------------
// The project rail of the new left bar (direction C): one tile per project, each project its
// own instance, then the "+". The open project wears a ring. A project that needs you wears
// the "needs you" mark on its corner; the open one does not, since its list says it.
//
// A project: { id, name, icon, iconSize, status }. `icon` is a picture's address, or
// { light, dark } for a mark with an ink and a cream drawing (docs/brand: ink on a light ground,
// cream on a dark one); `iconSize` is its width in px where the mark is not drawn for the
// tile's own box (--lb-tile-icon). A project with no icon wears its first letter.

export const projectLetter = name => ([...String(name ?? '').trim()][0] ?? '?').toUpperCase()

/** The mark on a project's corner, or null: only "needs you", and never on the open project. */
export const projectBadge = (project, currentId) => (project.id !== currentId && statusOr(project.status) === 'needs' ? 'needs' : null)

const paired = project => typeof project.icon?.light === 'string' && typeof project.icon?.dark === 'string'
const pictured = project => typeof project.icon === 'string' || paired(project)
function icon(project) {
  const sized = Number.isFinite(project.iconSize) && project.iconSize > 0 ? { style: { width: project.iconSize, height: project.iconSize } } : null
  const picture = (src, className) => h('img', { key: className ?? 'icon', className, src, alt: '', draggable: false, ...sized })
  if (typeof project.icon === 'string') return picture(project.icon)
  if (paired(project)) return [picture(project.icon.light, 'lb-on-light'), picture(project.icon.dark, 'lb-on-dark')]
  return projectLetter(project.name)
}
const Plus = () => h('svg', { width: 18, height: 18, viewBox: '0 0 20 20', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', 'aria-hidden': true }, h('path', { d: 'M10 4.5v11M4.5 10h11' }))

/** The rail. `onOpen(project)` hears a press on a tile, `onAdd()` one on the "+". */
export function ProjectRail({ projects = [], currentId, onOpen, onAdd, label }) {
  return h('nav', { className: 'lb-rail', 'aria-label': label ?? word('projects') },
    projects.map((project) => {
      const badge = projectBadge(project, currentId)
      return h('button', {
        key: project.id, type: 'button', className: ['lb-tile', pictured(project) ? '' : 'lb-tile-letter', badge ? 'lb-tile-badged' : ''].filter(Boolean).join(' '), 'data-id': project.id,
        'aria-current': project.id === currentId ? 'true' : undefined,
        'aria-label': badge ? `${project.name}, ${word(badge)}` : project.name, title: project.name,
        onClick: onOpen ? () => onOpen(project) : undefined,
      }, h('span', { className: 'lb-tile-face' }, icon(project)), badge ? h('span', { className: 'lb-pip' }, h(StatusMark, { status: badge, named: false })) : null)
    }),
    h('button', { type: 'button', className: 'lb-tile lb-tile-add', 'aria-label': word('add'), title: word('add'), onClick: onAdd }, h('span', { className: 'lb-tile-face' }, h(Plus))))
}
