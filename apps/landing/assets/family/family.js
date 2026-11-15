/* The family drawer. Mounts on [data-family-drawer]; the buttons that open it are every [data-family-open] on the page.
   No globals, no libraries, no outside request. With the script on, the button NEVER goes anywhere: its address is taken off it at mount
   (it stays in the HTML only for a page without script), so nothing else on a page that follows links can carry the visitor away.
   The button is three lines, one in each of the family's colours; they do not move.
   Opens from the left and pushes the page aside (the stylesheet moves [data-family-page]); Escape, the Close button, a press outside or a
   second press on the button closes it and gives the focus back. While it is open the page does not scroll and Tab stays inside it.
   The page is set back by a veil on the layer over it, with a hole where the menu button stands, so the button stays at full strength.
   While it is open the page ([data-family-page]) is also out of reach: inert, and hidden from assistive technology, so a screen reader's
   reading cursor cannot wander into it. It comes back the moment the drawer closes, before the focus returns to the button. The button
   sits inside that page, so while the drawer is open a press on it is taken by the clear layer over the page, which closes the drawer.
   Pressing another product (a row, or one of the two app buttons at the top): its world opens from the thing pressed and covers the
   window, then the browser goes to that product's page (set data-family-stay on the drawer to stay, as the look page does).
   Pressing the product you are in just closes the drawer.
   Pressing one of the page's own sections (the list under the product you are in) closes the drawer at once and goes there.
   Reduced motion: nothing slides; things are simply there. */
(function(){
'use strict';
var dr = document.querySelector('[data-family-drawer]'); if (!dr) return;
var root = document.documentElement, scrim = document.querySelector('[data-family-scrim]'), world = document.querySelector('[data-family-world]');
var openers = [].slice.call(document.querySelectorAll('[data-family-open]')), last = null, timer = 0, stay = dr.hasAttribute('data-family-stay');
var page = document.querySelector('[data-family-page]');
function away(on){ if (!page) return; page.inert = on; if (on) page.setAttribute('aria-hidden', 'true'); else page.removeAttribute('aria-hidden'); }      /* inert where the browser knows it; aria-hidden says the same to an older one */
var calm = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
/* the arch in the current product's tile: if the page carries the logo's motion (ArcaMotion) and the visitor has not asked for less, its stones fall and land as the drawer opens */
var archCv = dr.querySelector('[data-family-arch]'), arch = null, archT = 0;
function setArch(){ if (!archCv || calm || !window.ArcaMotion) return; clearTimeout(archT);
  archT = setTimeout(function(){ try { archCv.parentNode.classList.add('is-live');
    if (!arch) arch = window.ArcaMotion.mount(archCv, { scene: 'transition', fit: 'tight', bg: null, shake: 0, auto: false }); else if (arch.setColors) arch.setColors(null, getComputedStyle(archCv).color);
    arch.setScene('transition'); arch.play(); } catch (e) { archCv.parentNode.classList.remove('is-live'); } }, 380); }
function theme(from){ var t = from && from.closest('[data-theme]'), v = t ? t.getAttribute('data-theme') : null;      /* the drawer wears the world it is opened in */
  [dr, scrim, world].forEach(function(e){ if (!e) return; if (v) e.setAttribute('data-theme', v); else e.removeAttribute('data-theme'); }); }
function isOpen(){ return root.classList.contains('is-family-open'); }
/* the drawer's pictures are not among the page's own requests: each carries its address in data-src (or data-srcset) and gets it when its
   layer is shown, and only if the picture itself is shown (the ones for the other ground stay without an address until that ground is used).
   (A browser's own lazy loading was not enough: WebKitGTK fetched a hidden picture chosen by a <source>.) Call it once the layer is in the page. */
function shown(x){ return x.getClientRects().length > 0; }
function fill(box){ if (!box) return;
  [].forEach.call(box.querySelectorAll('[data-srcset]'), function(s){ if (!shown(s.parentNode)) return; s.setAttribute('srcset', s.getAttribute('data-srcset')); s.removeAttribute('data-srcset'); });
  [].forEach.call(box.querySelectorAll('img[data-src]'), function(i){ if (!shown(i)) return; i.setAttribute('src', i.getAttribute('data-src')); i.removeAttribute('data-src'); }); }
function stops(){ return [].filter.call(dr.querySelectorAll('a[href], button, [tabindex="0"]'), function(x){ return x.offsetParent !== null; }); }
/* the hole in the veil, where the button stands once the page is pushed aside: the button's place at rest plus the drawer's width
   (the page's wrapper is taken to start at the window's left edge) */
function hole(){ if (!scrim || !last) return; var r = last.getBoundingClientRect(), at = page ? page.getBoundingClientRect().left : 0;
  scrim.style.setProperty('--fam-bx', Math.round(r.left - at + dr.getBoundingClientRect().width + r.width / 2) + 'px'); scrim.style.setProperty('--fam-by', Math.round(r.top + r.height / 2) + 'px'); }
function open(from){ clearTimeout(timer); last = from || openers[0] || null; theme(last); dr.hidden = false; if (scrim) scrim.hidden = false; fill(dr);
  hole(); dr.getBoundingClientRect(); root.classList.add('is-family-open'); root.style.overflow = 'hidden';
  openers.forEach(function(o){ o.setAttribute('aria-expanded', 'true'); }); dr.focus({ preventScroll: true }); away(true); setArch(); }
function close(keep){ if (!isOpen()) return; root.classList.remove('is-family-open'); away(false);
  openers.forEach(function(o){ o.setAttribute('aria-expanded', 'false'); });
  timer = setTimeout(function(){ dr.hidden = true; if (scrim) scrim.hidden = true; root.style.overflow = ''; }, calm ? 0 : 480);
  if (!keep && last) last.focus({ preventScroll: true }); }
openers.forEach(function(o){
  /* with the script on this is a button and nothing else: no address is left on it to follow */
  if (o.hasAttribute('href')){ o.setAttribute('data-href', o.getAttribute('href')); o.removeAttribute('href'); }
  o.setAttribute('role', 'button'); o.setAttribute('tabindex', '0'); o.setAttribute('aria-expanded', 'false'); o.setAttribute('aria-controls', dr.id);
  function press(e){ e.preventDefault(); e.stopPropagation(); if (isOpen()) close(); else open(o); }
  /* a press with a pointer does not leave the keyboard's focus ring on the button; any key brings it back */
  o.addEventListener('click', function(e){ o.classList.toggle('is-pointer', e.detail > 0); press(e); });
  o.addEventListener('keydown', function(e){ o.classList.remove('is-pointer'); if (e.key === ' ' || e.key === 'Enter') press(e); });
  o.addEventListener('blur', function(){ if (!isOpen()) o.classList.remove('is-pointer'); });
});
/* on a page that keeps the visitor here (the look page), nothing in the drawer is an address to follow */
if (stay) [].forEach.call(dr.querySelectorAll('[data-family-product]'), function(it){
  it.setAttribute('data-href', it.getAttribute('href')); it.removeAttribute('href'); it.setAttribute('role', 'link'); it.setAttribute('tabindex', '0'); });
dr.addEventListener('keydown', function(e){ var it = e.target.closest && e.target.closest('[data-family-product]');
  if (it && !it.hasAttribute('href') && (e.key === 'Enter' || e.key === ' ')){ e.preventDefault(); it.click(); } });
if (scrim) scrim.addEventListener('click', function(){ close(); });
/* the window changes size while the drawer is open (a phone is turned): the page takes its new place AT ONCE, with no slide, and the
   hole goes with it. If the page slid there, the hole would stand ahead of the button until the slide ended. */
var snapT = 0;
window.addEventListener('resize', function(){ if (!isOpen()) return; root.classList.add('is-family-snap'); hole(); clearTimeout(snapT);
  snapT = setTimeout(function(){ root.classList.remove('is-family-snap'); hole(); }, 160); });
dr.addEventListener('click', function(e){
  if (e.target.closest('[data-family-close]')){ close(); return; }
  var sec = e.target.closest('[data-family-links] a');
  if (sec && (sec.getAttribute('href') || '').charAt(0) === '#'){      /* a section is a place on this page: the drawer steps aside AT ONCE, with no slide, and only then the page goes there (a jump made while the page is still sliding back lands short) */
    e.preventDefault(); var id = sec.getAttribute('href').slice(1), to = document.getElementById(id);
    root.classList.add('is-family-snap'); close(true); clearTimeout(timer); dr.hidden = true; if (scrim) scrim.hidden = true; root.style.overflow = '';
    requestAnimationFrame(function(){ requestAnimationFrame(function(){ root.classList.remove('is-family-snap');
      if (window.location.hash === '#' + id){ if (to) to.scrollIntoView(); } else window.location.hash = id;
      if (to){ if (!to.hasAttribute('tabindex')) to.setAttribute('tabindex', '-1'); to.focus({ preventScroll: true }); } }); });
    return; }
  var it = e.target.closest('[data-family-product]'); if (!it) return;
  if (it.classList.contains('is-here')){ e.preventDefault(); close(); return; }
  if (!world || e.metaKey || e.ctrlKey || e.shiftKey) return;                    /* a new tab is the visitor's own choice */
  e.preventDefault();
  var r = (it.querySelector('.fam-tile') || it).getBoundingClientRect(), href = it.getAttribute('href') || it.getAttribute('data-href');
  world.style.setProperty('--fam-x', Math.round(r.left + r.width / 2) + 'px'); world.style.setProperty('--fam-y', Math.round(r.top + r.height / 2) + 'px');
  var n = world.querySelector('[data-family-world-name]'), l = world.querySelector('[data-family-world-line]');
  if (n) n.textContent = it.getAttribute('data-family-product'); if (l) l.textContent = it.getAttribute('data-family-line') || '';
  world.hidden = false; fill(world); world.getBoundingClientRect(); world.classList.add('is-in');
  setTimeout(function(){ close(true); if (!stay) window.location.href = href; else { away(true); var b = world.querySelector('[data-family-back]'); if (b) b.focus({ preventScroll: true }); } }, calm ? 0 : 700); });
if (world) world.addEventListener('click', function(e){ if (!e.target.closest('[data-family-back]')) return;
  var o = openers[0]; if (o){ var r = o.getBoundingClientRect(); world.style.setProperty('--fam-x', Math.round(r.left + r.width / 2) + 'px'); world.style.setProperty('--fam-y', Math.round(r.top + r.height / 2) + 'px'); }
  world.classList.remove('is-in'); setTimeout(function(){ world.hidden = true; away(false); if (o) o.focus({ preventScroll: true }); }, calm ? 0 : 700); });
document.addEventListener('keydown', function(e){
  if (e.key === 'Escape'){ if (world && !world.hidden && world.classList.contains('is-in')){ var b = world.querySelector('[data-family-back]'); if (b) b.click(); } else close(); return; }
  if (!(e.key === 'Tab' || e.keyCode === 9) || !isOpen()) return;
  var f = stops(), first = f[0], end = f[f.length - 1], at = document.activeElement, out = !at || at === dr || !dr.contains(at);      /* out: the focus is on the drawer itself or has left it */
  if (!first) return;
  if (e.shiftKey && (at === first || out)){ e.preventDefault(); end.focus(); } else if (!e.shiftKey && (at === end || out)){ e.preventDefault(); first.focus(); } });
/* a second hold on the focus, for a browser whose Shift+Tab does not reach the lines above (WebKitGTK rested one stop on nothing): when the
   keyboard takes the focus out of the drawer to nowhere, it goes on to the other end at once (off the first stop: the last; off the last: the first) */
var keyed = false;
document.addEventListener('keydown', function(){ keyed = true; }, true);
document.addEventListener('pointerdown', function(){ keyed = false; }, true);
dr.addEventListener('focusout', function(e){ if (!keyed || !isOpen() || (e.relatedTarget && dr.contains(e.relatedTarget))) return; var from = e.target;
  setTimeout(function(){ var at = document.activeElement; if (!isOpen() || (at && at !== document.body && at !== root)) return;
    var f = stops(); if (!f.length) return; (from === f[0] ? f[f.length - 1] : from === f[f.length - 1] ? f[0] : dr.contains(from) && from.offsetParent !== null ? from : f[0]).focus(); }, 0); });
})();
