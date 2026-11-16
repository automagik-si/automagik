// Browser fixture for the header's Chat / Terminal switch: the real FaceSwitch inside the real
// header row and styles, so a real mouse click either lands on the switch or falls through the
// header to the shell, exactly as in the app. Made-up names.
import { createElement as h } from 'react'
import { createRoot } from 'react-dom/client'
import { FaceSwitch } from '../../src/client/left-bar-faces.js'
import { LEFT_BAR_CSS } from '../../src/client/left-bar-css.js'
import { SHELL_CSS } from '../../src/client/styles.js'

window.__picked = null
window.mountSwitch = () => {
  const style = document.createElement('style')
  style.textContent = SHELL_CSS + LEFT_BAR_CSS
  document.head.append(style)
  createRoot(document.getElementById('root')).render(
    h('div', { className: 'bt-head' }, h(FaceSwitch, { face: 'chat', onFace: face => { window.__picked = face } })),
  )
}
