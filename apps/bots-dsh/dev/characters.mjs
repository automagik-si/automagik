// Source of DS Bot's characters. Each one is a small 3D model made of
// signed-distance primitives (spheres, ellipsoids, round cones, a torus, extrusions, and
// the first mascots' design outlines inflated into soft slabs), seen from one fixed
// three-quarter view and traced into flat layers in a 100-unit box: the body, decals,
// a shade on the side away from the light, and a highlight facing it. The eyes are
// capsules laid on the model's front surface and projected the same way, so the near
// eye is wider than the far one and both lean with the surface. The twelve Solvers are
// traced with fur (buildFur): clumps of cones on the model's rim joined to its SDF before
// tracing, plus a black .15 lock layer as their last decal.
//
//   node dev/characters.mjs                   prints the CHARACTERS block for src/client/characters.js:
//                                             every entry but `octopus`, Omni's hand-drawn mark
//   node dev/characters.mjs --preview a.html  also writes a preview gallery
import { writeFileSync } from 'node:fs'
import { BLOSSOM_PETALS, MOON_BODY, SQUIRCLE_BODY, STAR_BODY, WAVE_BODY } from './mascot-outlines.mjs'

// ---------------------------------------------------------------------------
// Vectors and the view.
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const len = a => Math.hypot(a[0], a[1], a[2])
const norm = (a) => { const l = len(a); return [a[0] / l, a[1] / l, a[2] / l] }
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
const rad = deg => (deg * Math.PI) / 180
const mul = (m, p) => [dot(m[0], p), dot(m[1], p), dot(m[2], p)]
const mm = (a, b) => a.map(row => [0, 1, 2].map(j => row[0] * b[0][j] + row[1] * b[1][j] + row[2] * b[2][j]))
const tr = m => [0, 1, 2].map(i => [m[0][i], m[1][i], m[2][i]])
const rx = (d) => { const c = Math.cos(rad(d)), s = Math.sin(rad(d)); return [[1, 0, 0], [0, c, -s], [0, s, c]] }
const ry = (d) => { const c = Math.cos(rad(d)), s = Math.sin(rad(d)); return [[c, 0, s], [0, 1, 0], [-s, 0, c]] }
const rz = (d) => { const c = Math.cos(rad(d)), s = Math.sin(rad(d)); return [[c, -s, 0], [s, c, 0], [0, 0, 1]] }

// Object space: x right, y up, z toward the viewer. The model turns its face to the
// viewer's right, tips its top toward the viewer, and leans back a little.
const VIEW = { yaw: 34, pitch: 16, roll: 10 }
const toWorld = mm(rz(VIEW.roll), mm(rx(VIEW.pitch), ry(VIEW.yaw)))
const toObject = tr(toWorld)

// ---------------------------------------------------------------------------
// Signed-distance primitives (Inigo Quilez's formulas).
const sphere = (c, r) => p => len(sub(p, c)) - r
function ellipsoid(c, radii, turn) {
  const m = turn ? tr(rz(turn)) : null
  return (p) => {
    let q = sub(p, c)
    if (m) q = mul(m, q)
    const k0 = len([q[0] / radii[0], q[1] / radii[1], q[2] / radii[2]])
    const k1 = len([q[0] / radii[0] ** 2, q[1] / radii[1] ** 2, q[2] / radii[2] ** 2])
    return k1 === 0 ? -Math.min(...radii) : (k0 * (k0 - 1)) / k1
  }
}
function roundBox(c, half, r) {
  return (p) => {
    const q = sub(p, c).map((v, i) => Math.abs(v) - (half[i] - r))
    return len(q.map(v => Math.max(v, 0))) + Math.min(Math.max(...q), 0) - r
  }
}
function capsule(a, b, r) {
  const ba = sub(b, a)
  return (p) => {
    const pa = sub(p, a)
    const h = Math.max(0, Math.min(1, dot(pa, ba) / dot(ba, ba)))
    return len(sub(pa, ba.map(v => v * h))) - r
  }
}
function roundCone(a, b, r1, r2) {
  const ba = sub(b, a)
  const l2 = dot(ba, ba)
  const rr = r1 - r2
  const a2 = l2 - rr * rr
  const il2 = 1 / l2
  return (p) => {
    const pa = sub(p, a)
    const y = dot(pa, ba)
    const z = y - l2
    const xv = sub(pa.map(v => v * l2), ba.map(v => v * y))
    const x2 = dot(xv, xv)
    const y2 = y * y * l2
    const z2 = z * z * l2
    const k = Math.sign(rr) * rr * rr * x2
    if (Math.sign(z) * a2 * z2 > k) return Math.sqrt(x2 + z2) * il2 - r2
    if (Math.sign(y) * a2 * y2 < k) return Math.sqrt(x2 + y2) * il2 - r1
    return (Math.sqrt(x2 * a2 * il2) + y * rr) * il2 - r1
  }
}
// A ring standing in the xy plane, facing the viewer.
const torus = (c, R, r) => (p) => { const q = sub(p, c); return Math.hypot(Math.hypot(q[0], q[1]) - R, q[2]) - r }
// A 2D profile in the xy plane, pushed `depth` back and forth, its edges rounded by `round`.
const extrude = (profile, depth, round) => (p) => {
  const d = profile(p[0], p[1])
  const w = Math.abs(p[2]) - depth
  return Math.min(Math.max(d, w), 0) + Math.hypot(Math.max(d, 0), Math.max(w, 0)) - round
}
const box2 = (cx, cy, hx, hy) => (x, y) => {
  const qx = Math.abs(x - cx) - hx
  const qy = Math.abs(y - cy) - hy
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0)
}
const smin = (k, ...parts) => p => parts.map(f => f(p)).reduce((a, b) => {
  const h = Math.max(k - Math.abs(a - b), 0) / k
  return Math.min(a, b) - h * h * k / 4
})
const clipBelow = (f, y) => p => Math.max(f(p), y - p[1])
// The smooth intersection: smin's twin, for a soft cut.
const smax = (k, a, b) => p => -smin(k, q => -a(q), q => -b(q))(p)

// ---------------------------------------------------------------------------
// 2D outlines from SVG paths. A path is flattened to polygons, and its signed distance
// (negative inside, even-odd per path, union across paths) is baked on a grid once.
function flatten(d) {
  const tokens = d.match(/[a-zA-Z]|-?(?:\d*\.\d+|\d+\.?)(?:e[-+]?\d+)?/g)
  const loops = []
  let loop = []
  let i = 0
  let cmd = 'M'
  let [x, y] = [0, 0]
  let [sx, sy] = [0, 0]
  let control = null
  const num = () => parseFloat(tokens[i++])
  const close = () => { if (loop.length > 2) loops.push(loop); loop = [] }
  const curve = (points, steps = 12) => {
    for (let s = 1; s <= steps; s += 1) {
      const t = s / steps
      const m = 1 - t
      const p = points.length === 3
        ? [m * m * points[0][0] + 2 * m * t * points[1][0] + t * t * points[2][0], m * m * points[0][1] + 2 * m * t * points[1][1] + t * t * points[2][1]]
        : [0, 1].map(k => m * m * m * points[0][k] + 3 * m * m * t * points[1][k] + 3 * m * t * t * points[2][k] + t * t * t * points[3][k])
      loop.push(p)
    }
  }
  const arc = (rx, ry, phi, large, sweep, x2, y2) => {
    const c = Math.cos(rad(phi))
    const s = Math.sin(rad(phi))
    const dx = (x - x2) / 2
    const dy = (y - y2) / 2
    const x1p = c * dx + s * dy
    const y1p = -s * dx + c * dy
    const lambda = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry)
    if (lambda > 1) { rx *= Math.sqrt(lambda); ry *= Math.sqrt(lambda) }
    const sign = large === sweep ? -1 : 1
    const k = sign * Math.sqrt(Math.max(0, (rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p) / (rx * rx * y1p * y1p + ry * ry * x1p * x1p)))
    const cxp = (k * rx * y1p) / ry
    const cyp = (-k * ry * x1p) / rx
    const cx = c * cxp - s * cyp + (x + x2) / 2
    const cy = s * cxp + c * cyp + (y + y2) / 2
    const angle = (ux, uy, vx, vy) => Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy)
    const t1 = angle(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry)
    let dt = angle((x1p - cxp) / rx, (y1p - cyp) / ry, (-x1p - cxp) / rx, (-y1p - cyp) / ry)
    if (!sweep && dt > 0) dt -= 2 * Math.PI
    if (sweep && dt < 0) dt += 2 * Math.PI
    const steps = Math.max(4, Math.ceil(Math.abs(dt) / 0.12))
    for (let n = 1; n <= steps; n += 1) {
      const t = t1 + (dt * n) / steps
      loop.push([cx + rx * Math.cos(t) * c - ry * Math.sin(t) * s, cy + rx * Math.cos(t) * s + ry * Math.sin(t) * c])
    }
  }
  while (i < tokens.length) {
    if (/[a-zA-Z]/.test(tokens[i])) cmd = tokens[i++]
    const rel = cmd === cmd.toLowerCase()
    const ox = rel ? x : 0
    const oy = rel ? y : 0
    switch (cmd.toUpperCase()) {
      case 'M': close(); x = ox + num(); y = oy + num(); [sx, sy] = [x, y]; loop.push([x, y]); cmd = rel ? 'l' : 'L'; control = null; break
      case 'L': x = ox + num(); y = oy + num(); loop.push([x, y]); control = null; break
      case 'H': x = ox + num(); loop.push([x, y]); control = null; break
      case 'V': y = oy + num(); loop.push([x, y]); control = null; break
      case 'C': { const p1 = [ox + num(), oy + num()]; const p2 = [ox + num(), oy + num()]; const p = [ox + num(), oy + num()]; curve([[x, y], p1, p2, p]); [x, y] = p; control = p2; break }
      case 'S': { const p1 = control ? [2 * x - control[0], 2 * y - control[1]] : [x, y]; const p2 = [ox + num(), oy + num()]; const p = [ox + num(), oy + num()]; curve([[x, y], p1, p2, p]); [x, y] = p; control = p2; break }
      case 'Q': { const p1 = [ox + num(), oy + num()]; const p = [ox + num(), oy + num()]; curve([[x, y], p1, p]); [x, y] = p; control = null; break }
      case 'A': { const [rx, ry, phi, large, sweep] = [num(), num(), num(), num(), num()]; const x2 = ox + num(); const y2 = oy + num(); arc(Math.abs(rx), Math.abs(ry), phi, !!large, !!sweep, x2, y2); [x, y] = [x2, y2]; control = null; break }
      case 'Z': close(); [x, y] = [sx, sy]; control = null; break
      default: throw new Error(`Unsupported path command ${cmd}`)
    }
  }
  close()
  return loops
}

function polygonDistance(loops, x, y) {
  let best = Infinity
  let inside = false
  for (const loop of loops) {
    for (let a = 0, b = loop.length - 1; a < loop.length; b = a, a += 1) {
      const [x1, y1] = loop[b]
      const [x2, y2] = loop[a]
      const dx = x2 - x1
      const dy = y2 - y1
      const h = Math.max(0, Math.min(1, ((x - x1) * dx + (y - y1) * dy) / (dx * dx + dy * dy || 1)))
      best = Math.min(best, Math.hypot(x - x1 - dx * h, y - y1 - dy * h))
      if ((y1 > y) !== (y2 > y) && x < x1 + ((y - y1) * dx) / dy) inside = !inside
    }
  }
  return inside ? -best : best
}

// An outline as a 2D distance in object units. `map` takes object (x, y) to the path's
// own coordinates and `unit` is how many path units make one object unit; `grow`
// fattens the outline (in path units), which also rounds its corners.
function outline(paths, { map, unit, grow = 0 }) {
  const shapes = paths.map(flatten)
  const R = 1.6
  const G = 260
  const grid = new Float64Array((G + 1) * (G + 1))
  for (let i = 0; i <= G; i += 1) {
    for (let j = 0; j <= G; j += 1) {
      const [px, py] = map(-R + (2 * R * j) / G, R - (2 * R * i) / G)
      grid[i * (G + 1) + j] = (Math.min(...shapes.map(loops => polygonDistance(loops, px, py))) - grow) / unit
    }
  }
  return (x, y) => {
    const fj = Math.max(0, Math.min(G - 1e-9, ((x + R) / (2 * R)) * G))
    const fi = Math.max(0, Math.min(G - 1e-9, ((R - y) / (2 * R)) * G))
    const [i, j] = [Math.floor(fi), Math.floor(fj)]
    const [ti, tj] = [fi - i, fj - j]
    const at = (a, b) => grid[a * (G + 1) + b]
    const inner = (at(i, j) * (1 - tj) + at(i, j + 1) * tj) * (1 - ti) + (at(i + 1, j) * (1 - tj) + at(i + 1, j + 1) * tj) * ti
    // Outside the baked square the distance only grows.
    return inner + Math.max(0, Math.abs(x) - R, Math.abs(y) - R)
  }
}
// A 512-unit design box seen as object space: its center at the origin, `per` design
// units to one object unit, y up.
const box512 = (cx, cy, per = 190) => ({ map: (x, y) => [cx + x * per, cy - y * per], unit: per })

// A soft slab: the outline pushed back and forth `depth`, its rim rounded by `round`.
const puffy = (profile, depth, round) => extrude((x, y) => profile(x, y) + round, depth, round)
// A 2D distance seen on the front of a model as a decal.
const segment2 = (ax, ay, bx, by) => (x, y) => {
  const dx = bx - ax
  const dy = by - ay
  const h = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy)))
  return Math.hypot(x - ax - dx * h, y - ay - dy * h)
}
const polyline2 = (points, width) => (x, y) => Math.min(...points.slice(1).map((p, k) => segment2(...points[k], ...p)(x, y))) - width
const circle2 = (cx, cy, r) => (x, y) => Math.hypot(x - cx, y - cy) - r

// ---------------------------------------------------------------------------
// The models. `eyes` are [x, y] spots on the front, found by a ray along -z; `eye`
// scales the capsule (1 = 10 by 23 units at a face-on spot).
// `paints` are decals on the model's front: a region (negative inside) of the hit
// point, drawn in a fixed color over the body color.
const decal = (region2, fill, opacity = 1) => ({ region: p => region2(p[0], p[1]), fill, opacity })
// The wave's heart, drawn freehand in a 100-unit box (y down), a little lopsided on purpose.
const WAVE_HEART = 'M50 78C38 70 22 59 20 45C18.5 35 25 27 34 27C41 27 46.5 31.5 50 37.5C53.5 31 59.5 26.5 66.5 27C75.5 27.5 81.5 35.5 80 45.5C78 59.5 62 70.5 50 78Z'

// The first mascots: their original outlines, inflated into soft 3D bodies.
const MASCOTS = {
  whale: {
    label: 'Whale',
    sdf: smin(0.14,
      ellipsoid([0.12, -0.06, 0], [0.8, 0.68, 0.66]),
      roundCone([-0.42, -0.34, 0], [-1.0, 0.16, 0], 0.18, 0.065),
      ellipsoid([-0.96, 0.5, 0], [0.13, 0.36, 0.09], 14),
      ellipsoid([-1.28, 0.22, 0], [0.13, 0.34, 0.09], 74)),
    eyes: [[-0.06, 0.12], [0.34, 0.12]],
    paints: [{ region: p => Math.max(sphere([0.42, -0.98, 0.52], 0.72)(p), -0.04 - p[2]), fill: '#fff', opacity: 1 }],
  },
  moon: {
    label: 'Moon',
    sdf: puffy(outline([MOON_BODY], box512(244, 288)), 0.1, 0.24),
    eyes: [[-0.2, 0.04], [0.22, 0.04]],
    paints: [decal((x, y) => Math.max(circle2(0.232, 0.674, 0.147)(x, y), -circle2(0.3, 0.747, 0.127)(x, y)), '#1783FF')],
  },
  zed: {
    label: 'Bull',
    sdf: smin(0.1,
      ellipsoid([0, -0.12, 0], [0.74, 0.68, 0.62]),
      roundCone([0.4, 0.3, 0], [0.78, 0.5, 0], 0.18, 0.12),
      roundCone([0.78, 0.5, 0], [0.86, 0.86, 0], 0.12, 0.05),
      roundCone([-0.4, 0.3, 0], [-0.78, 0.5, 0], 0.18, 0.12),
      roundCone([-0.78, 0.5, 0], [-0.86, 0.86, 0], 0.12, 0.05),
      ellipsoid([0.76, 0.02, -0.08], [0.26, 0.12, 0.1], -14),
      ellipsoid([-0.76, 0.02, -0.08], [0.26, 0.12, 0.1], 14)),
    eyes: [[-0.22, -0.1], [0.22, -0.1]],
    paints: [decal(polyline2([[-0.1, 0.44], [0.1, 0.44], [-0.09, 0.3], [0.11, 0.3]], 0.034), '#fff')],
  },
  wave: {
    label: 'Wave',
    sdf: puffy(outline([WAVE_BODY], box512(256, 262)), 0.1, 0.24),
    eyes: [[-0.2, 0.34], [0.2, 0.34]],
    // A hand-drawn heart, low on the body.
    paints: [decal(outline([WAVE_HEART], { map: (x, y) => [50 + x * 120, 50 - (y + 0.22) * 120], unit: 120 }), '#fff', 0.4)],
  },
  star: {
    label: 'Star',
    sdf: puffy(outline([STAR_BODY], { ...box512(256, 262), grow: 22 }), 0.1, 0.2),
    eyes: [[-0.17, -0.02], [0.17, -0.02]],
    eye: 0.85,
  },
  squircle: {
    label: 'Squircle',
    sdf: puffy(outline([SQUIRCLE_BODY], box512(256, 256)), 0.12, 0.26),
    eyes: [[-0.2, 0.06], [0.2, 0.06]],
  },
  hex: {
    label: 'Blossom',
    sdf: puffy(outline(BLOSSOM_PETALS, { map: (x, y) => [9.86 + x * 9.6, 10 - y * 9.6], unit: 9.6, grow: 0.6 }), 0.08, 0.12),
    eyes: [[-0.16, -0.04], [0.18, -0.04]],
    eye: 0.8,
  },
}

// The geometric characters.
const GEOMETRIC = {
  gumdrop: {
    sdf: roundCone([0, -0.55, 0], [0, 0.55, 0], 0.82, 0.42),
    eyes: [[-0.2, 0.18], [0.2, 0.18]],
  },
  peanut: {
    sdf: smin(0.35, sphere([0, 0.42, 0], 0.6), sphere([0, -0.5, 0], 0.72)),
    eyes: [[-0.2, 0.5], [0.2, 0.5]],
    eye: 0.9,
  },
  saucer: {
    sdf: smin(0.12, ellipsoid([0, -0.25, 0], [1.05, 0.3, 1.05]), sphere([0, 0, 0], 0.56)),
    eyes: [[-0.18, 0.18], [0.18, 0.18]],
    eye: 0.8,
  },
  bunny: {
    sdf: smin(0.14, sphere([0, -0.3, 0], 0.68), ellipsoid([-0.26, 0.62, -0.05], [0.16, 0.48, 0.12], 10), ellipsoid([0.26, 0.62, -0.05], [0.16, 0.48, 0.12], -10)),
    eyes: [[-0.2, -0.22], [0.2, -0.22]],
    eye: 0.85,
  },
  kitty: {
    sdf: smin(0.12, ellipsoid([0, -0.12, 0], [0.86, 0.74, 0.72]), roundCone([-0.42, 0.4, 0], [-0.58, 0.92, 0], 0.26, 0.05), roundCone([0.42, 0.4, 0], [0.58, 0.92, 0], 0.26, 0.05)),
    eyes: [[-0.24, -0.05], [0.24, -0.05]],
  },
  beacon: {
    sdf: smin(0.05, roundBox([0, -0.22, 0], [0.82, 0.62, 0.56], 0.26), capsule([0, 0.3, 0], [0, 0.82, 0], 0.07), sphere([0, 0.9, 0], 0.16)),
    eyes: [[-0.26, -0.2], [0.26, -0.2]],
  },
  plus: {
    sdf: extrude((x, y) => Math.min(box2(0, 0, 0.82, 0.24)(x, y), box2(0, 0, 0.24, 0.82)(x, y)), 0.22, 0.14),
    eyes: [[-0.14, 0.02], [0.14, 0.02]],
    eye: 0.72,
  },
  magnet: {
    sdf: extrude((x, y) => Math.max(y < 0 ? Math.abs(Math.hypot(x, y) - 0.56) - 0.24 : Math.abs(Math.abs(x) - 0.56) - 0.24, y - 0.72), 0.22, 0.1),
    eyes: [[-0.17, -0.56], [0.17, -0.56]],
    eye: 0.72,
  },
  acorn: {
    sdf: smin(0.04, ellipsoid([0, -0.22, 0], [0.72, 0.78, 0.72]), clipBelow(ellipsoid([0, 0.3, 0], [0.88, 0.5, 0.88]), 0.16), capsule([0, 0.72, 0], [0.08, 0.98, 0], 0.08)),
    eyes: [[-0.22, -0.12], [0.22, -0.12]],
  },
  pebbles: {
    sdf: smin(0.22, roundBox([0, -0.48, 0], [0.9, 0.38, 0.62], 0.34), roundBox([0.05, 0.36, 0], [0.62, 0.4, 0.5], 0.3)),
    eyes: [[-0.16, 0.38], [0.24, 0.38]],
    eye: 0.82,
  },
  cushion: {
    sdf: roundBox([0, 0, 0], [0.92, 0.78, 0.38], 0.36),
    eyes: [[-0.26, -0.02], [0.22, -0.02]],
  },
  ring: {
    sdf: torus([0, 0, 0], 0.64, 0.3),
    eyes: [[-0.2, -0.64], [0.2, -0.64]],
    eye: 0.62,
  },
  gem: {
    sdf: extrude((x, y) => polygonDistance([[[-0.52, 0.56], [0.52, 0.56], [0.94, 0.12], [0, -0.86], [-0.94, 0.12]]], x, y), 0.24, 0.1),
    eyes: [[-0.2, 0.2], [0.2, 0.2]],
    eye: 0.8,
  },
}

// The Solvers: twelve characters told apart by their outlines, with the same two stubby
// feet and the same big, low-set eyes. Each model is built facing +z and then turned back
// by SOLVER_TURN, so its face looks at the viewer more than the view's yaw alone lets a
// model do.
const SOLVER_TURN = 22
const toSolver = ry(SOLVER_TURN)
const fromSolver = tr(toSolver)
// A shape or a region of a model's own space, as object space sees it.
const turned = f => p => f(mul(toSolver, p))
// A model's front surface at its own (x, y).
function frontOf(sdf, x, y) {
  let z = 2.5
  for (let i = 0; i < 400; i += 1) {
    const d = sdf([x, y, z])
    if (d < 1e-4) break
    z -= Math.max(d, 1e-4)
  }
  return [x, y, z]
}
// A body of revolution round the y axis: its profile [radius, y] from the top to the
// bottom, both ends on the axis, its corners cut `cuts` times and rounded by `round`.
const cut = points => [points[0], ...points.slice(0, -1).flatMap((a, k) => [0.25, 0.75].map(t => [a[0] + (points[k + 1][0] - a[0]) * t, a[1] + (points[k + 1][1] - a[1]) * t])), points.at(-1)]
function lathe(profile, round = 0, cuts = 2) {
  const half = Array.from({ length: cuts }).reduce(cut, profile)
  const loop = [...half, ...half.slice(1, -1).reverse().map(([r, y]) => [-r, y])]
  return p => polygonDistance([loop], Math.hypot(p[0], p[2]), p[1]) - round
}
// The feet every Solver stands on, under its body at (±x, y, z).
const FOOT = [0.23, 0.15, 0.3]
const feetAt = (x, y, z) => [ellipsoid([-x, y, z], FOOT), ellipsoid([x, y, z], FOOT)]
// One Solver: `eyes` is [x, y] of the right eye on the model's front (the left mirrors
// it) and `eyeHeight` the capsule's height in model units, so the eyes keep their size
// against the body whatever the model's size in the box. A marking's region is written
// in the model's own space and goes round the whole body (`all`).
function solver(label, { body, feet, eyes: [ex, ey], eyeHeight, paints }) {
  const model = smin(0.05, body, ...feetAt(...feet))
  return {
    label,
    sdf: turned(model),
    eyes: [-ex, ex].map(x => mul(fromSolver, frontOf(model, x, ey)).slice(0, 2)),
    eyeHeight,
    ...(paints ? { paints: paints.map(([region, fill, opacity]) => ({ region: turned(region), fill, opacity, all: true })) } : {}),
  }
}
const spots = list => p => Math.min(...list.map(([c, r]) => len(sub(p, c)) - r))

// Puff: a round body with a soft cloud edge and two round ears.
const PUFF_RADII = [1, 0.8, 0.85]
// The rim: the body's outline as the view sees it, walked in equal steps, so its bumps
// are even. `at` runs 0 to 1 round the outline: 0 at its left, 0.25 at its bottom,
// 0.5 at its right, 0.75 at its top.
const PUFF_RIM_AT = (() => {
  const away = norm(mul(toSolver, mul(toObject, [0, 0, 1])).map((v, i) => v / PUFF_RADII[i]))
  const e1 = norm(cross(away, [0, 1, 0]))
  const e2 = cross(away, e1)
  const point = t => PUFF_RADII.map((r, i) => r * (e1[i] * Math.cos(t) + e2[i] * Math.sin(t)))
  const STEPS = 720
  const lengths = [0]
  for (let k = 1; k <= STEPS; k += 1) lengths.push(lengths[k - 1] + len(sub(point((2 * Math.PI * k) / STEPS), point((2 * Math.PI * (k - 1)) / STEPS))))
  return (at, out, r) => {
    const target = (at - Math.floor(at)) * lengths[STEPS]
    return sphere(point((2 * Math.PI * lengths.findIndex(l => l >= target)) / STEPS).map(v => v * out), r)
  }
})()
const PUFF_BODY = smin(0.1,
  smax(0.12, smin(0.16,
    ellipsoid([0, 0, 0], PUFF_RADII),
    // Sixteen small, shallow bumps, and a tiny curl of two at the top.
    ...Array.from({ length: 16 }, (_, k) => PUFF_RIM_AT((k + 0.5) / 16, 0.93, 0.13)),
    PUFF_RIM_AT(0.742, 1.01, 0.1), PUFF_RIM_AT(0.715, 0.99, 0.075)), p => -0.66 - p[1]),
  sphere([-0.56, 0.72, -0.04], 0.27), sphere([0.56, 0.72, -0.04], 0.27))

// Cap: a mushroom. Its dome's skin at (x, y), for the spots.
const CAP_DOME = [[0, 0.12, 0], [1.08, 0.78, 0.92]]
const onCap = (x, y) => [x, y, CAP_DOME[1][2] * Math.sqrt(Math.max(0, 1 - (x / CAP_DOME[1][0]) ** 2 - ((y - CAP_DOME[0][1]) / CAP_DOME[1][1]) ** 2))]
// Chick: the beak points forward and down, so the view sees a small point under the eyes.
const CHICK_BEAK = roundCone([0, -0.16, 0.62], [0, -0.42, 0.98], 0.15, 0.04)
// Bulb: its screw base, from the globe down: each notch's top and bottom, then where the ridge under it ends.
// The view looks down on the ridges, whose rims close a low notch: a notch is taller than its ridge so it stays open in the outline.
const BULB_NOTCHES = [[-0.275, -0.405, -0.46], [-0.46, -0.59, -0.645], [-0.645, -0.775, -0.84]]
// Spike: eight soft cones in a ring, none pointing straight down at the feet.
const SPIKES = Array.from({ length: 8 }, (_, k) => rad(22.5 + 45 * k)).map(a => roundCone([0.5 * Math.cos(a), 0.5 * Math.sin(a), 0], [1.06 * Math.cos(a), 1.06 * Math.sin(a), 0], 0.26, 0.12))

const SOLVERS = {
  puff: solver('Puff', { body: PUFF_BODY, feet: [0.36, -0.72, 0.5], eyes: [0.37, 0.2], eyeHeight: 0.84 }),
  sprout: solver('Sprout', {
    body: smin(0.07,
      ellipsoid([0, -0.3, 0], [0.82, 0.68, 0.76]),
      capsule([0, 0.3, 0], [0, 0.52, 0], 0.1),
      ellipsoid([-0.42, 0.82, 0], [0.25, 0.54, 0.12], 52),
      ellipsoid([0.42, 0.82, 0], [0.25, 0.54, 0.12], -52)),
    feet: [0.34, -0.98, 0.42], eyes: [0.33, -0.3], eyeHeight: 0.8,
  }),
  cap: solver('Cap', {
    body: smin(0.06,
      smax(0.1, ellipsoid(...CAP_DOME), p => 0.16 - p[1]),
      ellipsoid([0, -0.42, 0], [0.5, 0.62, 0.48])),
    feet: [0.25, -1, 0.3], eyes: [0.21, -0.44], eyeHeight: 0.54,
    paints: [[p => Math.max(spots([[onCap(-0.52, 0.5), 0.17], [onCap(0.12, 0.62), 0.2], [onCap(0.66, 0.44), 0.14], [onCap(-0.14, 0.3), 0.1], [onCap(-0.86, 0.3), 0.1], [onCap(0.42, 0.26), 0.08]])(p), 0.2 - p[1]), '#fff', 0.5]],
  }),
  bell: solver('Bell', {
    body: smin(0.05,
      lathe([[0, 0.6], [0.34, 0.6], [0.52, 0.4], [0.55, 0.12], [0.6, -0.18], [0.76, -0.44], [1.02, -0.6], [1.04, -0.72], [0.88, -0.76], [0, -0.76]], 0.03),
      sphere([0, 0.76, 0], 0.17)),
    feet: [0.34, -0.88, 0.82], eyes: [0.27, -0.2], eyeHeight: 0.74,
  }),
  cloud: solver('Cloud', {
    body: smax(0.08, smin(0.05,
      sphere([0, 0.16, 0], 0.5), sphere([-0.74, -0.1, 0], 0.38), sphere([0.74, -0.1, 0], 0.38),
      roundBox([0, -0.36, 0], [1.04, 0.2, 0.48], 0.2)), p => -0.54 - p[1]),
    feet: [0.4, -0.58, 0.36], eyes: [0.26, -0.06], eyeHeight: 0.6,
  }),
  spike: solver('Spike', {
    body: smin(0.08, sphere([0, 0, 0], 0.7), ...SPIKES),
    feet: [0.28, -0.74, 0.46], eyes: [0.27, 0], eyeHeight: 0.66,
  }),
  floppy: solver('Floppy', {
    body: smin(0.08,
      ellipsoid([0, 0.04, 0], [0.5, 0.9, 0.6]),
      // Each ear leaves the side of the head under its dome, then hangs straight down to the feet.
      ...[-1, 1].flatMap(side => [
        capsule([side * 0.38, 0.3, 0], [side * 0.7, 0.22, 0], 0.13),
        roundCone([side * 0.7, 0.22, 0], [side * 0.79, -0.72, 0], 0.13, 0.15),
      ])),
    feet: [0.22, -0.9, 0.38], eyes: [0.23, -0.1], eyeHeight: 0.72,
  }),
  antenna: solver('Antenna', {
    body: smin(0.07,
      ellipsoid([0, -0.38, 0], [0.8, 0.7, 0.76]),
      capsule([0, 0.25, 0], [0.05, 0.7, 0], 0.13), capsule([0.05, 0.7, 0], [0.18, 0.98, 0], 0.13),
      sphere([0.2, 1.06, 0], 0.25)),
    feet: [0.34, -1.1, 0.44], eyes: [0.33, -0.42], eyeHeight: 0.8,
  }),
  cactus: solver('Cactus', {
    body: smin(0.08,
      capsule([0, -0.45, 0], [0, 0.5, 0], 0.5),
      capsule([-0.4, -0.12, 0], [-0.84, -0.12, 0], 0.18), capsule([-0.84, -0.12, 0], [-0.84, 0.3, 0], 0.18),
      capsule([0.4, 0.12, 0], [0.82, 0.12, 0], 0.18), capsule([0.82, 0.12, 0], [0.82, 0.62, 0], 0.18)),
    feet: [0.24, -0.98, 0.3], eyes: [0.21, -0.32], eyeHeight: 0.68,
  }),
  bulb: solver('Bulb', {
    // A globe on a screw base: a short straight cylinder under it with three ridges and a
    // notch above each, cut square and deep (no corner is cut) to show in the outline at 24 px.
    body: lathe([
      ...Array.from({ length: 39 }, (_, k) => rad(k * 4)).map(a => [0.71 * Math.sin(a), 0.37 + 0.71 * Math.cos(a)]),
      ...BULB_NOTCHES.flatMap(([top, bottom, end]) => [[0.14, top], [0.14, bottom], [0.32, bottom], [0.32, end]]),
      [0, -0.84]], 0.012, 0),
    feet: [0.2, -1, 0.26], eyes: [0.28, 0.5], eyeHeight: 0.64,
    paints: [[p => Math.max(Math.min(...BULB_NOTCHES.map(([top, bottom]) => Math.abs(p[1] - (top + bottom) / 2) - (top - bottom) / 2 - 0.005)), Math.hypot(p[0], p[2]) - 0.4), '#000', 0.22]],
  }),
  chick: solver('Chick', {
    body: smin(0.06,
      smin(0.45, sphere([0, -0.24, 0], 0.74), sphere([0, 0.34, 0], 0.5)),
      CHICK_BEAK,
      ellipsoid([-0.8, -0.28, 0.04], [0.22, 0.3, 0.2], -28), ellipsoid([0.8, -0.28, 0.04], [0.22, 0.3, 0.2], 28),
      roundCone([0, 0.74, 0], [0, 1.2, 0], 0.13, 0.1), roundCone([-0.05, 0.74, 0], [-0.46, 1.02, 0], 0.13, 0.1), roundCone([0.05, 0.74, 0], [0.46, 1.02, 0], 0.13, 0.1)),
    feet: [0.3, -1, 0.4], eyes: [0.31, -0.02], eyeHeight: 0.78,
    paints: [[p => CHICK_BEAK(p) - 0.03, '#000', 0.2]],
  }),
  frog: solver('Frog', {
    body: smin(0.1,
      ellipsoid([0, -0.3, 0], [1.04, 0.5, 0.8]),
      sphere([-0.5, 0.24, 0.1], 0.43), sphere([0.5, 0.24, 0.1], 0.43)),
    feet: [0.5, -0.8, 0.44], eyes: [0.5, 0.26], eyeHeight: 0.58,
  }),
}

// Picker order: the mascots lead, the star second; the Solvers close the table.
const ORDER = ['whale', 'star', 'moon', 'wave', 'squircle', 'zed', 'hex']
const MODELS = { ...Object.fromEntries(ORDER.map(id => [id, MASCOTS[id]])), ...GEOMETRIC, ...SOLVERS }

function contours(field) {
  const at = (i, j) => field[i * (N + 1) + j]
  const point = (i, j, di, dj) => {
    const a = at(i, j)
    const b = at(i + di, j + dj)
    const k = a / (a - b)
    return [-EXTENT + (j + dj * k) * STEP, EXTENT - (i + di * k) * STEP]
  }
  const segments = []
  const edge = {
    top: (i, j) => [`h${i},${j}`, () => point(i, j, 0, 1)],
    bottom: (i, j) => [`h${i + 1},${j}`, () => point(i + 1, j, 0, 1)],
    left: (i, j) => [`v${i},${j}`, () => point(i, j, 1, 0)],
    right: (i, j) => [`v${i},${j + 1}`, () => point(i, j + 1, 1, 0)],
  }
  const PAIRS = {
    1: [['left', 'bottom']], 2: [['bottom', 'right']], 3: [['left', 'right']], 4: [['top', 'right']],
    5: [['left', 'top'], ['bottom', 'right']], 6: [['top', 'bottom']], 7: [['left', 'top']], 8: [['left', 'top']],
    9: [['top', 'bottom']], 10: [['left', 'bottom'], ['top', 'right']], 11: [['top', 'right']], 12: [['left', 'right']],
    13: [['bottom', 'right']], 14: [['left', 'bottom']],
  }
  for (let i = 0; i < N; i += 1) {
    for (let j = 0; j < N; j += 1) {
      const code = (at(i, j) < 0 ? 8 : 0) | (at(i, j + 1) < 0 ? 4 : 0) | (at(i + 1, j + 1) < 0 ? 2 : 0) | (at(i + 1, j) < 0 ? 1 : 0)
      for (const [a, b] of PAIRS[code] ?? []) segments.push([edge[a](i, j), edge[b](i, j)])
    }
  }
  const byEdge = new Map()
  segments.forEach(([a, b], index) => {
    for (const [key] of [a, b]) byEdge.set(key, [...(byEdge.get(key) ?? []), index])
  })
  const used = new Set()
  const loops = []
  for (let start = 0; start < segments.length; start += 1) {
    if (used.has(start)) continue
    const loop = []
    let index = start
    let [[fromKey, fromPoint], [toKey]] = segments[start]
    loop.push(fromPoint())
    for (;;) {
      used.add(index)
      const [a, b] = segments[index]
      const [nextKey, nextPoint] = a[0] === fromKey ? b : a
      loop.push(nextPoint())
      fromKey = nextKey
      const next = (byEdge.get(nextKey) ?? []).find(other => !used.has(other))
      if (next === undefined) break
      index = next
    }
    void toKey
    if (loop.length > 8) loops.push(loop)
  }
  return loops
}

function simplify(points, tolerance) {
  if (points.length < 3) return points
  const [a, b] = [points[0], points.at(-1)]
  let far = 0
  let index = 0
  for (let i = 1; i < points.length - 1; i += 1) {
    const p = points[i]
    const dx = b[0] - a[0]
    const dy = b[1] - a[1]
    const l = Math.hypot(dx, dy) || 1
    const d = Math.abs(dy * p[0] - dx * p[1] + b[0] * a[1] - b[1] * a[0]) / l
    if (d > far) { far = d; index = i }
  }
  if (far <= tolerance) return [a, b]
  return [...simplify(points.slice(0, index + 1), tolerance).slice(0, -1), ...simplify(points.slice(index), tolerance)]
}

// ---------------------------------------------------------------------------
// Tracing. Each grid ray keeps the smallest distance it meets: negative inside the
// silhouette, about the distance to it outside, so marching squares finds a smooth edge.
const N = 300
const EXTENT = 1.7
const STEP = (2 * EXTENT) / N

// Light from the upper left, a little in front. The side turned away from it is the
// shade; the patch facing it is the highlight, which is what shapes a black body.
const LIGHT = norm([-0.62, 0.68, 0.4])
const SHADE_AT = 0.06
const LIGHT_AT = 0.86

function gradient(sdf, p) {
  const e = 1e-3
  return norm([0, 1, 2].map((axis) => {
    const plus = [...p]
    const minus = [...p]
    plus[axis] += e
    minus[axis] -= e
    return sdf(plus) - sdf(minus)
  }))
}

// The ray's smallest distance and, when it hits, the hit point and normal (object space).
function rayMin(sdf, X, Y) {
  let t = 2.4
  let best = Infinity
  let hit = null
  for (let i = 0; i < 400 && t > -2.4; i += 1) {
    const p = mul(toObject, [X, Y, t])
    const d = sdf(p)
    if (d < best) best = d
    if (d < 1e-3 && hit === null) hit = { p, n: gradient(sdf, p) }
    t -= Math.max(Math.abs(d) * 0.8, 0.002)
  }
  return [best, hit]
}

function surfaceAt(sdf, x, y) {
  let z = 2.5
  for (let i = 0; i < 300; i += 1) {
    const d = sdf([x, y, z])
    if (d < 1e-4) break
    z -= Math.max(d, 1e-4)
  }
  const p = [x, y, z]
  return { p, n: gradient(sdf, p) }
}

const f = n => String(+n.toFixed(1))

// Models that share one body are cast once.
const CASTS = new WeakMap()
function cast(sdf) {
  let rays = CASTS.get(sdf)
  if (!rays) {
    rays = []
    for (let i = 0; i <= N; i += 1) for (let j = 0; j <= N; j += 1) rays.push(rayMin(sdf, -EXTENT + j * STEP, EXTENT - i * STEP))
    CASTS.set(sdf, rays)
  }
  return rays
}

// ===========================================================================
// FUR: how the twelve Solvers are traced (buildFur).
//
// Fur is geometry. Clumps of 2 to 4 pointed, bent round cones that share a base are
// planted on the model's rim (the surface the view sees edge-on) and joined to its SDF
// before tracing, so the traced outline is the fur's edge. A displacement along the normal
// alone cannot lean or curve a lock, so the lock field is these cones. The same clump
// shapes, flat on the view, cut the shade's inner edge (lit locks lying over the darker
// underside) and make the decals: layered clumps with a shadow under their tips, a brow
// and a cheek clump by each eye, and a few lock strokes.


// How much fur each part of a model wears, in the model's own space, as a share of the
// longest fur: 1 a large mass (tips of 7 to 9 units of the box), SMALL a small one (4 to 5), FEET the
// feet, 0 smooth. A point wears what its nearest part wears.
const SMALL = 0.57
const FEET = 0.33
const nearest = parts => (p) => {
  let best = Infinity
  let amount = 0
  for (const [shape, value] of parts) { const d = shape(p); if (d < best) { best = d; amount = value } }
  return amount
}
const wears = (feet, parts) => nearest([...feetAt(...feet).map(foot => [foot, FEET]), ...parts])
const FUR = {
  // The ears wear the shortest fur; round their roots and in the dip between them there is
  // none, so the two round bumps and the dip stay in the outline at 16 px.
  puff: (p) => {
    if (Math.min(...feetAt(0.36, -0.72, 0.5).map(foot => foot(p))) < 0.03) return FEET
    const ear = Math.min(len(sub(p, [-0.56, 0.72, -0.04])), len(sub(p, [0.56, 0.72, -0.04])))
    if (ear < 0.31) return 0.2
    if (ear < 0.68 || (Math.abs(p[0]) < 0.56 && p[1] > 0.5)) return 0
    // Shorter fur on the shoulders under the ears, so it does not fill the notch under each bump.
    return ear < 0.95 ? SMALL : 1
  },
  sprout: wears([0.34, -0.98, 0.42], [
    [ellipsoid([0, -0.3, 0], [0.82, 0.68, 0.76]), 1],
    [capsule([0, 0.3, 0], [0, 0.52, 0], 0.1), 0],
    [ellipsoid([-0.42, 0.82, 0], [0.25, 0.54, 0.12], 52), 0], [ellipsoid([0.42, 0.82, 0], [0.25, 0.54, 0.12], -52), 0]]),
  cap: wears([0.25, -1, 0.3], [
    [smax(0.1, ellipsoid(...CAP_DOME), p => 0.16 - p[1]), 1],
    [ellipsoid([0, -0.42, 0], [0.5, 0.62, 0.48]), 0]]),
  // Shorter fur on the upper body only: the knob, the flare and the hem's bottom edge stay clean.
  bell: (p) => {
    if (Math.min(...feetAt(0.34, -0.88, 0.82).map(foot => foot(p))) < 0.03) return FEET
    if (len(sub(p, [0, 0.76, 0])) < 0.24) return 0
    return p[1] > 0.02 ? 0.75 : p[1] > -0.16 ? 0.36 : 0
  },
  // A low body: its three bumps would drown in the longest fur.
  cloud: wears([0.4, -0.58, 0.36], [[() => -1, 0.8]]),
  // Fur on the ball and round each spike's root; from there out the spike is clean to its tip.
  spike: p => (Math.min(...feetAt(0.28, -0.74, 0.46).map(foot => foot(p))) < 0.03 ? FEET : len(p) < 0.9 ? SMALL : 0),
  // Fur on the head's dome, and the shortest on each ear's outer side and tip: none in the
  // gap between an ear and the head, so the ears keep a clean inner edge.
  floppy: (p) => {
    if (Math.min(...feetAt(0.22, -0.9, 0.38).map(foot => foot(p))) < 0.03) return FEET
    const side = p[0] < 0 ? -1 : 1
    const ear = Math.min(capsule([side * 0.38, 0.3, 0], [side * 0.7, 0.22, 0], 0.13)(p), roundCone([side * 0.7, 0.22, 0], [side * 0.79, -0.72, 0], 0.13, 0.15)(p))
    if (ear < ellipsoid([0, 0.04, 0], [0.5, 0.9, 0.6])(p)) {
      // The hanging part's own axis at this height: outside it is the outer side.
      const axis = 0.7 + 0.09 * Math.max(0, Math.min(1, (0.22 - p[1]) / 0.94))
      return Math.abs(p[0]) > axis + 0.03 || p[1] < -0.76 || p[1] > 0.32 ? 0.36 : 0
    }
    return p[1] > 0.42 ? 1 : 0
  },
  antenna: wears([0.34, -1.1, 0.44], [
    [ellipsoid([0, -0.38, 0], [0.8, 0.7, 0.76]), 1],
    [capsule([0, 0.25, 0], [0.05, 0.7, 0], 0.13), 0], [capsule([0.05, 0.7, 0], [0.18, 0.98, 0], 0.13), 0],
    [sphere([0.2, 1.06, 0], 0.25), 0]]),
  // Short fur on the trunk only, and none beside an arm's root: each arm stays a smooth, separate stub.
  cactus: (p) => {
    if (Math.min(...feetAt(0.24, -0.98, 0.3).map(foot => foot(p))) < 0.03) return FEET
    const arms = Math.min(
      capsule([-0.4, -0.12, 0], [-0.84, -0.12, 0], 0.18)(p), capsule([-0.84, -0.12, 0], [-0.84, 0.3, 0], 0.18)(p),
      capsule([0.4, 0.12, 0], [0.82, 0.12, 0], 0.18)(p), capsule([0.82, 0.12, 0], [0.82, 0.62, 0], 0.18)(p))
    return arms < 0.22 || arms < capsule([0, -0.45, 0], [0, 0.5, 0], 0.5)(p) ? 0 : SMALL
  },
  // The globe wears fur; the screw base under it stays smooth.
  bulb: wears([0.2, -1, 0.26], [[sphere([0, 0.37, 0], 0.71), 1], [capsule([0, -0.3, 0], [0, -0.84, 0], 0.3), 0]]),
  chick: wears([0.3, -1, 0.4], [
    [smin(0.45, sphere([0, -0.24, 0], 0.74), sphere([0, 0.34, 0], 0.5)), 1],
    [CHICK_BEAK, 0],
    [ellipsoid([-0.8, -0.28, 0.04], [0.22, 0.3, 0.2], -28), 0.4], [ellipsoid([0.8, -0.28, 0.04], [0.22, 0.3, 0.2], 28), 0.4],
    [roundCone([0, 0.74, 0], [0, 1.2, 0], 0.13, 0.1), 0], [roundCone([-0.05, 0.74, 0], [-0.46, 1.02, 0], 0.13, 0.1), 0], [roundCone([0.05, 0.74, 0], [0.46, 1.02, 0], 0.13, 0.1), 0]]),
  // The two domes wear shorter fur, so the dip between them stays.
  frog: wears([0.5, -0.8, 0.44], [
    [ellipsoid([0, -0.3, 0], [1.04, 0.5, 0.8]), 1],
    [sphere([-0.5, 0.24, 0.1], 0.43), SMALL], [sphere([0.5, 0.24, 0.1], 0.43), SMALL]]),
}

// What the decals and the shade's inner edge follow, where it is not the outline's fur: these
// four keep round 2's coat inside the body while their outline wears less (round 3).
const SKIN = {
  // The ears wear short fur, and round their roots and in the dip between them the fur is
  // the shortest, so the two ears still read as ears.
  puff: (p) => {
    if (Math.min(...feetAt(0.36, -0.72, 0.5).map(foot => foot(p))) < 0.03) return FEET
    const ear = Math.min(len(sub(p, [-0.56, 0.72, -0.04])), len(sub(p, [0.56, 0.72, -0.04])))
    if (ear < 0.31) return SMALL
    return ear < 0.5 || (Math.abs(p[0]) < 0.5 && p[1] > 0.55) ? 0.2 : 1
  },
  bell: wears([0.34, -0.88, 0.82], [
    [lathe([[0, 0.6], [0.34, 0.6], [0.52, 0.4], [0.55, 0.12], [0.6, -0.18], [0.76, -0.44], [1.02, -0.6], [1.04, -0.72], [0.88, -0.76], [0, -0.76]], 0.03), 1],
    [sphere([0, 0.76, 0], 0.17), 0]]),
  floppy: wears([0.22, -0.9, 0.38], [
    [ellipsoid([0, 0.04, 0], [0.5, 0.9, 0.6]), 1],
    ...[-1, 1].flatMap(side => [
      [capsule([side * 0.38, 0.3, 0], [side * 0.7, 0.22, 0], 0.13), 0.36],
      [roundCone([side * 0.7, 0.22, 0], [side * 0.79, -0.72, 0], 0.13, 0.15), 0.36]])]),
  cactus: wears([0.24, -0.98, 0.3], [
    [capsule([0, -0.45, 0], [0, 0.5, 0], 0.5), 1],
    [capsule([-0.4, -0.12, 0], [-0.84, -0.12, 0], 0.18), 0], [capsule([-0.84, -0.12, 0], [-0.84, 0.3, 0], 0.18), 0],
    [capsule([0.4, 0.12, 0], [0.82, 0.12, 0], 0.18), 0], [capsule([0.82, 0.12, 0], [0.82, 0.62, 0], 0.18), 0]]),
}

// Seeded, so a build is the same every time.
function seeded(text) {
  let seed = 2166136261
  for (const ch of text) seed = Math.imul(seed ^ ch.charCodeAt(0), 16777619)
  return () => {
    seed = (seed + 0x6D2B79F5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// ---------------------------------------------------------------------------
// The tunables, in units of the 100-unit box unless said otherwise. Round 2: few, big, combed.
const LOCK = {
  length: [7, 9], // a clump's longest tip on a large mass, along the lock; other masses take their share
  cap: 9, // never farther off the smooth surface (times the mass's share)
  radius: 0.33, // a tip's base radius, of its length: a wide leaf
  mid: [0.84, 0.52], // its radius a third and two thirds of the way, of the base's
  spacing: 1.7, // tips of a clump stand this many base radii apart, so their bases overlap into a scallop
  fan: 9, // degrees between a clump's tips
  bend: 22, // degrees a tip curves on, from its middle, the way it is combed
  gap: [0.04, 0.22], // between clumps, of the clump's width
  gapThin: [0.5, 1.1], // the same on feet and thin parts
  point: 0.005, // the tip's own radius, in model units
  blend: 0.03, // how softly locks join each other and the body, in model units
}
const SHADE = { length: [6, 8], gap: [0.1, 0.45] }
const LAYER = { opacity: 0.15, length: [8, 11], shadow: 2.4, count: [4, 6], apart: 0.34, inside: 0.15 }
const STROKE = { length: [6, 9], radius: 0.5, count: 3, apart: 0.3 }
const FACE = { brow: 0.4, cheek: 0.28, clear: 0.045 }

// ---------------------------------------------------------------------------
// A clump as cones in the view's own space (x right, y up, z to the viewer).
const turn2 = ([x, y], deg) => { const c = Math.cos(rad(deg)); const s = Math.sin(rad(deg)); return [x * c - y * s, x * s + y * c] }
const unit2 = ([x, y]) => { const l = Math.hypot(x, y) || 1; return [x / l, y / l] }
const smooth = (a, b, v) => { const t = Math.max(0, Math.min(1, (v - a) / (b - a))); return t * t * (3 - 2 * t) }
// A lock that leaves along `from` and is pulled by `pull`: its direction, and the degrees its
// tip curves on, the same way round.
function toward(from, pull) {
  const dir = unit2([from[0] + pull[0], from[1] + pull[1]])
  const cross = from[0] * dir[1] - from[1] * dir[0]
  return [dir, Math.sign(cross) * LOCK.bend * Math.min(1, Math.abs(cross) / 0.25)]
}
// The one flow, as if combed: on the top the locks lean back (the face looks right, so back is
// left), on the sides they sweep down, under the body they point down and in. `side` runs
// from -1 at the body's left to 1 at its right.
function comb(normal, side) {
  const top = smooth(0.2, 0.85, normal[1])
  const under = smooth(0.2, 0.85, -normal[1])
  return toward(normal, [top * -0.42 + under * -side * 0.4, (1 - top - under) * -0.5])
}
// `roots` are [point, direction, curve] for each tip, `length` the longest tip's. Nothing is
// random but a little of the side tips' length.
function clump(roots, length, rand, { z = 0, sink = 0.4 } = {}) {
  const count = roots.length
  const middle = (count - 1) / 2
  const tips = roots.map(([at, out, curve], k) => {
    const l = length * (Math.abs(k - middle) < 0.6 ? 1 : 0.7 + 0.14 * rand()) * (count === 2 && k === 1 ? 0.8 : 1)
    const r0 = LOCK.radius * l
    const first = turn2(out, LOCK.fan * (k - middle))
    const [second, third] = [turn2(first, curve * 0.5), turn2(first, curve)]
    const a = [at[0] - out[0] * r0 * sink, at[1] - out[1] * r0 * sink]
    const m = [a[0] + first[0] * l * 0.42, a[1] + first[1] * l * 0.42]
    const n = [m[0] + second[0] * l * 0.33, m[1] + second[1] * l * 0.33]
    const t = [n[0] + third[0] * l * 0.3, n[1] + third[1] * l * 0.3]
    return { a, m, n, t, r0, r1: r0 * LOCK.mid[0], r2: r0 * LOCK.mid[1], l }
  })
  return { tips, z }
}
const segments = tip => [[tip.a, tip.m, tip.r0, tip.r1], [tip.m, tip.n, tip.r1, tip.r2], [tip.n, tip.t, tip.r2, LOCK.point]]
const coneFns = (tip, z) => segments(tip).map(([from, to, r, r2]) => roundCone([...from, z], [...to, z], r, r2))
// A clump flat on the view: its distance at (x, y), and its box for skipping.
function flat(c, shift = [0, 0]) {
  const fns = c.tips.flatMap(tip => coneFns(tip, 0))
  const xs = c.tips.flatMap(tip => [tip.a[0] - tip.r0, tip.a[0] + tip.r0, tip.m[0] - tip.r0, tip.m[0] + tip.r0, tip.n[0] - tip.r0, tip.n[0] + tip.r0, tip.t[0]])
  const ys = c.tips.flatMap(tip => [tip.a[1] - tip.r0, tip.a[1] + tip.r0, tip.m[1] - tip.r0, tip.m[1] + tip.r0, tip.n[1] - tip.r0, tip.n[1] + tip.r0, tip.t[1]])
  const pad = 0.12
  const box = [Math.min(...xs) - pad + Math.min(0, shift[0]), Math.min(...ys) - pad + Math.min(0, shift[1]), Math.max(...xs) + pad + Math.max(0, shift[0]), Math.max(...ys) + pad + Math.max(0, shift[1])]
  const d = (x, y) => Math.min(...fns.map(fn => fn([x, y, 0])))
  return { d, box, shift }
}
const within = (box, x, y) => x >= box[0] && x <= box[2] && y >= box[1] && y <= box[3]

// ---------------------------------------------------------------------------
// The base model's rays, kept on disk: the fur's knobs change, the models do not.
// Per ray: the smallest distance, whether it hit, the hit point, and where the smallest was.
function rayMinAt(sdf, X, Y) {
  let t = 2.4
  let best = Infinity
  let bestT = 0
  let hit = null
  for (let i = 0; i < 400 && t > -2.4; i += 1) {
    const p = mul(toObject, [X, Y, t])
    const d = sdf(p)
    if (d < best) { best = d; bestT = t }
    if (d < 1e-3 && hit === null) hit = p
    t -= Math.max(Math.abs(d) * 0.8, 0.002)
  }
  return [best, hit, bestT]
}
const SIZE = (N + 1) * (N + 1)
function baseRays(id, sdf) {
  const rays = new Float64Array(SIZE * 5)
  for (let i = 0; i <= N; i += 1) {
    for (let j = 0; j <= N; j += 1) {
      const [best, hit] = rayMinAt(sdf, -EXTENT + j * STEP, EXTENT - i * STEP)
      rays.set([best, hit ? 1 : 0, ...(hit ?? [0, 0, 0])], (i * (N + 1) + j) * 5)
    }
  }
  return rays
}

// A closed loop walked in equal steps, with its outward normal at each step.
function walk(loop, ds = 0.008) {
  const ring = loop.slice(0, -1)
  const lengths = [0]
  for (let k = 1; k <= ring.length; k += 1) lengths.push(lengths[k - 1] + Math.hypot(ring[k % ring.length][0] - ring[k - 1][0], ring[k % ring.length][1] - ring[k - 1][1]))
  const total = lengths.at(-1)
  const count = Math.max(8, Math.round(total / ds))
  const points = []
  let k = 0
  for (let n = 0; n < count; n += 1) {
    const s = (n / count) * total
    while (lengths[k + 1] < s) k += 1
    const u = (s - lengths[k]) / (lengths[k + 1] - lengths[k] || 1)
    const [a, b] = [ring[k], ring[(k + 1) % ring.length]]
    points.push([a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u])
  }
  let area = 0
  for (let n = 0; n < count; n += 1) { const [a, b] = [points[n], points[(n + 1) % count]]; area += a[0] * b[1] - b[0] * a[1] }
  const reach = Math.max(2, Math.round(0.05 / (total / count)))
  const normals = points.map((_, n) => {
    const [a, b] = [points[(n - reach + count) % count], points[(n + reach) % count]]
    const tangent = unit2([b[0] - a[0], b[1] - a[1]])
    return area > 0 ? [tangent[1], -tangent[0]] : [-tangent[1], tangent[0]]
  })
  return { points, normals, total, step: total / count, area: area / 2, count }
}

// A loop the tracer found is a hole when it lies inside an odd number of the others (the
// tracer walks a loop either way round, so its direction says nothing).
const isHole = (loop, all) => all.filter(other => other !== loop && polygonDistance([other], loop[0][0], loop[0][1]) < 0).length % 2 === 1

function buildFur(id) {
  const model = SOLVERS[id]
  const base = model.sdf
  const wearsAt = turned(FUR[id])
  const skinAt = turned(SKIN[id] ?? FUR[id])
  const rand = seeded(`fur:${id}`)
  const between = ([a, b]) => a + (b - a) * rand()
  const rays = baseRays(id, base)
  const bestOf = k => rays[k * 5]
  const hitOf = k => (rays[k * 5 + 1] ? [rays[k * 5 + 2], rays[k * 5 + 3], rays[k * 5 + 4]] : null)
  const gridOf = (X, Y) => Math.max(0, Math.min(N, Math.round((EXTENT - Y) / STEP))) * (N + 1) + Math.max(0, Math.min(N, Math.round((X + EXTENT) / STEP)))

  // The smooth model's outline, and the scale it has in the box: the fur's lengths are
  // box units of the approved drawing.
  const baseField = Float64Array.from({ length: SIZE }, (_, k) => bestOf(k))
  const baseLoops = contours(baseField)
  const spanOf = (loops) => {
    const all = loops.flat()
    const xs = all.map(p => p[0])
    const ys = all.map(p => p[1])
    return [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)]
  }
  const baseSpan = spanOf(baseLoops)
  const baseScale = 92 / Math.max(baseSpan[1] - baseSpan[0], baseSpan[3] - baseSpan[2])
  const units = v => v / baseScale

  // The eyes on the view: center, the unit directions across and up, width and height.
  const eyes = model.eyes.map(([x, y], index) => {
    const { p, n } = surfaceAt(base, x, y)
    const u = norm(cross([0, 1, 0], n))
    const v = cross(n, u)
    const [wp, wu, wv] = [mul(toWorld, p), mul(toWorld, u), mul(toWorld, v)]
    const height = model.eyeHeight * Math.hypot(wv[0], wv[1])
    const width = (model.eyeHeight * 10 / 23) * Math.hypot(wu[0], wu[1])
    const across = unit2([wu[0], wu[1]])
    return { at: [wp[0], wp[1]], across, up: unit2([wv[0], wv[1]]), out: index === 0 ? [-across[0], -across[1]] : across, width, height }
  })
  // The distance to the nearest eye and its blush under it.
  const eyeDistance = (x, y) => Math.min(...eyes.map((eye) => {
    const half = eye.height / 2 - eye.width / 2
    const top = [eye.at[0] + eye.up[0] * half, eye.at[1] + eye.up[1] * half]
    const low = [eye.at[0] - eye.up[0] * (half + eye.height * 0.1), eye.at[1] - eye.up[1] * (half + eye.height * 0.1)]
    return segment2(...top, ...low)(x, y) - eye.width * 0.62
  }))
  const face = [(eyes[0].at[0] + eyes[1].at[0]) / 2, (eyes[0].at[1] + eyes[1].at[1]) / 2]
  const eyeSpan = Math.hypot(eyes[1].at[0] - eyes[0].at[0], eyes[1].at[1] - eyes[0].at[1]) / 2

  // -------------------------------------------------------------------------
  // 1. The rim's clumps: real cones on the model.
  const rimPoint = ([X, Y]) => { const [, , t] = rayMinAt(base, X, Y); return [X, Y, t] }
  const amountAt = world => wearsAt(mul(toObject, world))
  const middleX = (baseSpan[0] + baseSpan[1]) / 2
  const sideOf = x => Math.max(-1, Math.min(1, (x - middleX) / ((baseSpan[1] - baseSpan[0]) * 0.3)))
  const rim = []
  for (const loop of baseLoops) {
    // A hole in the outline (between an ear and the head) keeps its shape.
    if (isHole(loop, baseLoops)) continue
    const ring = walk(loop)
    const at = s => ((Math.round(s / ring.step) % ring.count) + ring.count) % ring.count
    const wearing = s => amountAt(rimPoint(ring.points[at(s)]))
    let s = rand() * 0.08
    while (s < ring.total - 0.02) {
      const count = rand() < 0.42 ? 2 : 3
      const thin = wearing(s) < 0.5
      const pick = between(LOCK.length)
      const widthOf = amount => ((count - 1) * LOCK.spacing + 2) * LOCK.radius * units(amount * pick)
      // A clump stands whole on fur, and is as long as the least furred part it stands on.
      const first = wearing(s)
      if (first <= 0) { s += 0.02; continue }
      const amount = Math.min(first, wearing(s + widthOf(first) / 2), wearing(s + widthOf(first)))
      if (amount <= 0) { s += 0.02; continue }
      const length = units(amount * pick)
      const r0 = LOCK.radius * length
      const world = rimPoint(ring.points[at(s + widthOf(amount) / 2)])
      const roots = Array.from({ length: count }, (_, k) => {
        const n = at(s + r0 + k * LOCK.spacing * r0)
        return [ring.points[n], ...comb(ring.normals[n], sideOf(ring.points[n][0]))]
      })
      const c = clump(roots, length, rand, { z: world[2] })
      // No tip stands farther off the smooth surface than the cap.
      const cap = units(LOCK.cap * amount + 0.3)
      for (const tip of c.tips) {
        for (let pass = 0; pass < 3; pass += 1) {
          const off = base(mul(toObject, [...tip.t, c.z]))
          if (off <= cap) break
          const k = cap / off
          tip.m = [tip.a[0] + (tip.m[0] - tip.a[0]) * k, tip.a[1] + (tip.m[1] - tip.a[1]) * k]
          tip.n = [tip.a[0] + (tip.n[0] - tip.a[0]) * k, tip.a[1] + (tip.n[1] - tip.a[1]) * k]
          tip.t = [tip.a[0] + (tip.t[0] - tip.a[0]) * k, tip.a[1] + (tip.t[1] - tip.a[1]) * k]
        }
      }
      c.amount = amount
      rim.push(c)
      s += widthOf(amount) * (1 + between(thin ? LOCK.gapThin : LOCK.gap))
    }
  }
  // The clumps in object space, each with a ball round it for skipping.
  const solid = rim.map((c) => {
    const points = c.tips.flatMap(tip => [tip.a, tip.m, tip.n, tip.t])
    const center = [points.reduce((sum, p) => sum + p[0], 0) / points.length, points.reduce((sum, p) => sum + p[1], 0) / points.length, c.z]
    const reach = Math.max(...c.tips.flatMap(tip => [...[tip.a, tip.m, tip.n].map(p => Math.hypot(p[0] - center[0], p[1] - center[1]) + tip.r0), Math.hypot(tip.t[0] - center[0], tip.t[1] - center[1])])) + 0.01
    const cones = c.tips.flatMap(tip => segments(tip).map(([from, to, r, r2]) => roundCone(mul(toObject, [...from, c.z]), mul(toObject, [...to, c.z]), r, r2)))
    return { center: mul(toObject, center), view: center, reach, cones }
  })
  const K = LOCK.blend
  const furred = (p) => {
    let d = base(p)
    for (const c of solid) {
      if (Math.hypot(p[0] - c.center[0], p[1] - c.center[1], p[2] - c.center[2]) - c.reach > d + K) continue
      for (const cone of c.cones) {
        const e = cone(p)
        const h = Math.max(K - Math.abs(d - e), 0) / K
        d = Math.min(d, e) - h * h * K / 4
      }
    }
    return d
  }
  // Only the rays that pass a clump are cast again.
  const near = new Uint8Array(SIZE)
  for (const c of solid) {
    const pad = c.reach + 4 * STEP
    const [i0, i1] = [Math.floor((EXTENT - c.view[1] - pad) / STEP), Math.ceil((EXTENT - c.view[1] + pad) / STEP)]
    const [j0, j1] = [Math.floor((c.view[0] + EXTENT - pad) / STEP), Math.ceil((c.view[0] + EXTENT + pad) / STEP)]
    for (let i = Math.max(0, i0); i <= Math.min(N, i1); i += 1) for (let j = Math.max(0, j0); j <= Math.min(N, j1); j += 1) near[i * (N + 1) + j] = 1
  }
  const field = new Float64Array(SIZE)
  const hits = new Array(SIZE)
  for (let i = 0; i <= N; i += 1) {
    for (let j = 0; j <= N; j += 1) {
      const k = i * (N + 1) + j
      if (near[k]) { const [best, hit] = rayMinAt(furred, -EXTENT + j * STEP, EXTENT - i * STEP); field[k] = best; hits[k] = hit } else { field[k] = bestOf(k); hits[k] = hitOf(k) }
    }
  }

  // -------------------------------------------------------------------------
  // 2. The light, as the smooth model takes it: the fur changes edges, not the lighting.
  const lit = new Float64Array(SIZE).fill(NaN)
  const amounts = new Float64Array(SIZE)
  for (let k = 0; k < SIZE; k += 1) {
    if (!hits[k]) continue
    lit[k] = dot(mul(toWorld, gradient(base, hits[k])), LIGHT)
    amounts[k] = skinAt(hits[k])
  }
  // The shade's inner edge on the smooth model, where lit locks lie over the shade.
  const shadeBase = Float64Array.from({ length: SIZE }, (_, k) => (hitOf(k) ? Math.max(bestOf(k), (dot(mul(toWorld, gradient(base, hitOf(k))), LIGHT) - SHADE_AT) * 0.25) : Math.max(bestOf(k), STEP)))
  const shadeAt = (x, y) => shadeBase[gridOf(x, y)]
  const over = []
  for (const ring of contours(shadeBase).map(loop => walk(loop))) {
    const at = s => ((Math.round(s / ring.step) % ring.count) + ring.count) % ring.count
    let s = rand() * 0.08
    while (s < ring.total - 0.02) {
      const n = at(s)
      const [x, y] = ring.points[n]
      const k = gridOf(x, y)
      const amount = amounts[k]
      // Only the edge inside the body, on fur.
      if (!(bestOf(k) < -0.07) || amount <= 0) { s += 0.025; continue }
      const length = units(amount * between(SHADE.length))
      const count = rand() < 0.5 ? 2 : 3
      const r0 = LOCK.radius * length
      const width = ((count - 1) * LOCK.spacing + 2) * r0
      const roots = Array.from({ length: count }, (_, t) => {
        const m = at(s + r0 + t * LOCK.spacing * r0)
        const [px, py] = ring.points[m]
        const [nx, ny] = ring.normals[m]
        // Toward the shade, and down with the flow.
        const into = shadeAt(px + nx * 0.04, py + ny * 0.04) < shadeAt(px - nx * 0.04, py - ny * 0.04) ? [nx, ny] : [-nx, -ny]
        return [[px, py], ...toward(into, [0.1, -0.5])]
      })
      const last = roots.at(-1)[0]
      if (!(bestOf(gridOf(...last)) < -0.07) || amounts[gridOf(...last)] <= 0) { s += 0.025; continue }
      over.push(flat(clump(roots, length, rand, { sink: 1.1 })))
      s += width * (1 + between(SHADE.gap))
    }
  }

  // -------------------------------------------------------------------------
  // 3. The decals, flat on the view: a few big clumps lying over the body, each shown by the
  // darker band along its lower edge, a brow and a cheek clump by
  // each eye, and a few thin strokes.
  const order = Array.from({ length: SIZE }, (_, k) => k).filter(k => hitOf(k))
  for (let k = order.length - 1; k > 0; k -= 1) { const other = Math.floor(rand() * (k + 1)); [order[k], order[other]] = [order[other], order[k]] }
  const xy = k => [-EXTENT + (k % (N + 1)) * STEP, EXTENT - Math.floor(k / (N + 1)) * STEP]
  const cross2 = (a, b) => a[0] * b[1] - a[1] * b[0]
  // A clump of `count` tips centred on `center`, pointing along `out`, its tips curving on by `curve` degrees.
  // `edge` is the way its lower edge faces.
  const lying = (center, out, curve, length, count, edge = out) => {
    const side = [-out[1], out[0]]
    const r0 = LOCK.radius * length
    const start = [center[0] - out[0] * length * 0.45, center[1] - out[1] * length * 0.45]
    const roots = Array.from({ length: count }, (_, t) => { const off = (t - (count - 1) / 2) * LOCK.spacing * r0; return [[start[0] + side[0] * off, start[1] + side[1] * off], out, curve] })
    return { ...flat(clump(roots, length, rand, { sink: 0 })), center, edge: unit2(edge), length }
  }
  // Inside, the coat hangs: down and a little out, curving on to straight down.
  const hang = (x) => { const out = unit2([0.8 * sideOf(x), -0.7]); return [out, Math.sign(cross2(out, [0, -1])) * LOCK.bend * Math.min(1, Math.abs(out[0]) / 0.3)] }
  // The upper and the side masses: not under the eyes, not between them.
  const lowerFace = (x, y) => Math.abs(x - face[0]) < eyeSpan * 1.25 && y < face[1] + eyes[0].height * 0.2
  const layers = []
  const layerSites = []
  // A brow clump over each eye, sweeping out and up; a cheek clump at its outer corner, out and down.
  for (const eye of eyes) {
    const brow = model.eyeHeight * FACE.brow
    const browOut = unit2([eye.out[0] * 0.9 + eye.up[0] * 0.42, eye.out[1] * 0.9 + eye.up[1] * 0.42])
    const browLift = eye.height / 2 + FACE.clear + LOCK.radius * brow * 1.5 + units(LAYER.shadow) * 0.7
    const browAt = [eye.at[0] + eye.up[0] * browLift + eye.out[0] * eye.width * 0.1, eye.at[1] + eye.up[1] * browLift + eye.out[1] * eye.width * 0.1]
    layers.push(lying(browAt, browOut, Math.sign(cross2(browOut, eye.up)) * LOCK.bend * 0.6, brow, 2, [browOut[0] * 0.5 - eye.up[0], browOut[1] * 0.5 - eye.up[1]]))
    layerSites.push(browAt)
    const cheek = model.eyeHeight * FACE.cheek
    const cheekOut = unit2([eye.out[0] * 0.75 - eye.up[0] * 0.65, eye.out[1] * 0.75 - eye.up[1] * 0.65])
    const cheekAt = [eye.at[0] + eye.out[0] * (eye.width * 0.62 + FACE.clear + cheek * 0.4) - eye.up[0] * eye.height * 0.26, eye.at[1] + eye.out[1] * (eye.width * 0.62 + FACE.clear + cheek * 0.4) - eye.up[1] * eye.height * 0.26]
    layers.push(lying(cheekAt, cheekOut, Math.sign(cross2(cheekOut, [0, -1])) * LOCK.bend * 0.6, cheek, 2))
    layerSites.push(cheekAt)
  }
  const faceClumps = layers.length
  const wanted = Math.round(between(LAYER.count))
  for (const k of order) {
    if (layers.length - faceClumps >= wanted) break
    const [x, y] = xy(k)
    const length = units(between(LAYER.length))
    if (amounts[k] < 0.75 || bestOf(k) > -LAYER.inside || lowerFace(x, y)) continue
    if (eyeDistance(x, y) < length * 0.5 + FACE.clear) continue
    if (layerSites.some((site, n) => Math.hypot(site[0] - x, site[1] - y) < (n < faceClumps ? LAYER.apart * 0.75 : LAYER.apart))) continue
    layers.push(lying([x, y], ...hang(x), length, rand() < 0.5 ? 2 : 3))
    layerSites.push([x, y])
  }
  // A layer shows as the darker band along its lower edge, thinning away round its sides.
  const band = units(LAYER.shadow)
  const layerAt = (x, y) => {
    let best = STEP
    for (const layer of layers) {
      if (!within(layer.box, x, y)) continue
      const along = ((x - layer.center[0]) * layer.edge[0] + (y - layer.center[1]) * layer.edge[1]) / layer.length
      const d = layer.d(x, y)
      best = Math.min(best, Math.max(d - band * smooth(-0.2, 0.3, along), -d))
    }
    return best
  }
  const strokes = []
  const strokeSites = []
  for (const k of order) {
    if (strokes.length >= STROKE.count) break
    const [x, y] = xy(k)
    const length = units(between(STROKE.length))
    if (amounts[k] < 0.75 || bestOf(k) > -0.14 || lowerFace(x, y)) continue
    if (eyeDistance(x, y) < length * 0.7 + FACE.clear) continue
    if (strokeSites.some(site => Math.hypot(site[0] - x, site[1] - y) < STROKE.apart) || layerSites.some(site => Math.hypot(site[0] - x, site[1] - y) < LAYER.apart * 0.6)) continue
    const [out, curve] = hang(x)
    const c = clump([[[x - out[0] * length / 2, y - out[1] * length / 2], out, curve]], length, rand, { sink: 0 })
    for (const tip of c.tips) { tip.r0 = units(STROKE.radius); tip.r1 = tip.r0 * 0.8; tip.r2 = tip.r0 * 0.5 }
    strokes.push(flat(c))
    strokeSites.push([x, y])
  }
  const union = shapes => (x, y) => { let best = STEP; for (const shape of shapes) if (within(shape.box, x, y)) best = Math.min(best, shape.d(x, y)); return best }
  const strokeAt = union(strokes)
  const overAt = union(over)

  // -------------------------------------------------------------------------
  // 4. The layers, as characters.mjs's build makes them.
  const paints = model.paints ?? []
  const fields = { shade: new Float64Array(SIZE), light: new Float64Array(SIZE), paints: paints.map(() => new Float64Array(SIZE)), layer: new Float64Array(SIZE) }
  for (let k = 0; k < SIZE; k += 1) {
    const d = field[k]
    const off = Math.max(d, STEP)
    if (!hits[k]) {
      fields.shade[k] = off; fields.light[k] = off; fields.layer[k] = off
      fields.paints.forEach((layer) => { layer[k] = off })
      continue
    }
    const [x, y] = xy(k)
    const clear = FACE.clear * 0.6 - eyeDistance(x, y)
    fields.shade[k] = Math.max(d, (lit[k] - SHADE_AT) * 0.25, amounts[k] > 0 ? -overAt(x, y) : -STEP)
    fields.light[k] = Math.max(d, (LIGHT_AT - lit[k]) * 0.25)
    fields.layer[k] = amounts[k] > 0 ? Math.max(d, Math.min(layerAt(x, y), strokeAt(x, y)), clear) : off
    paints.forEach((paint, index) => { fields.paints[index][k] = Math.max(d, paint.region(hits[k])) })
  }
  const loops = contours(field)
  const [x0, x1, y0, y1] = spanOf(loops)
  const scale = 92 / Math.max(x1 - x0, y1 - y0)
  const cx = (x0 + x1) / 2
  const cy = (y0 + y1) / 2
  const place = ([X, Y]) => [50 + (X - cx) * scale, 50 - (Y - cy) * scale]
  const toPath = loopList => loopList.map((loop) => {
    const ring = loop.map(place)
    const far = ring.reduce((best, p, i) => (Math.hypot(p[0] - ring[0][0], p[1] - ring[0][1]) > Math.hypot(ring[best][0] - ring[0][0], ring[best][1] - ring[0][1]) ? i : best), 0)
    const points = [...simplify(ring.slice(0, far + 1), 0.25).slice(0, -1), ...simplify(ring.slice(far), 0.25)].slice(0, -1)
    const grid = points.map(([x, y]) => [Math.round(x * 10), Math.round(y * 10)])
    const steps = grid.slice(1).map(([x, y], k) => [x - grid[k][0], y - grid[k][1]]).filter(([dx, dy]) => dx || dy)
    const num = v => (v < 0 ? '-' : ' ') + String(Math.abs(v) / 10).replace(/^0\./, '.')
    return `M${f(grid[0][0] / 10)} ${f(grid[0][1] / 10)}l${steps.map(([dx, dy]) => `${num(dx)}${num(dy)}`).join('').trim()}z`
  }).join('')
  const areaOf = loop => loop.reduce((sum, p, n) => sum + p[0] * loop[(n + 1) % loop.length][1] - loop[(n + 1) % loop.length][0] * p[1], 0) / 2
  // A hole stays only where the smooth outline has one (between an ear and the head): fur
  // that closes a nook of the outline does not leave a new hole in the body.
  const baseHoles = baseLoops.filter(loop => isHole(loop, baseLoops))
  const kept = (loop) => {
    const area = Math.abs(areaOf(loop)) * scale * scale
    // A speck of fur off the body is not worth its bytes either.
    if (!isHole(loop, loops)) return area > 8
    const center = [loop.reduce((sum, p) => sum + p[0], 0) / loop.length, loop.reduce((sum, p) => sum + p[1], 0) / loop.length]
    return area > 2 && baseHoles.some(hole => polygonDistance([hole], center[0], center[1]) < 0)
  }
  const eyeSize = (model.eyeHeight * scale) / 23
  const eyeRows = model.eyes.map(([x, y]) => {
    const { p, n } = surfaceAt(base, x, y)
    const u = norm(cross([0, 1, 0], n))
    const v = cross(n, u)
    const [wp, wu, wv] = [mul(toWorld, p), mul(toWorld, u), mul(toWorld, v)]
    const [ex, ey] = place([wp[0], wp[1]])
    const vs = [wv[0], -wv[1]]
    const tilt = (Math.atan2(vs[0], -vs[1]) * 180) / Math.PI
    return [ex, ey, 10 * eyeSize * Math.hypot(wu[0], wu[1]), 23 * eyeSize * Math.hypot(...vs), tilt].map(value => +value.toFixed(1))
  })
  const tips = rim.flatMap(c => c.tips.map(tip => base(mul(toObject, [...tip.t, c.z])) * baseScale))
  const character = {
    label: model.label,
    body: toPath(loops.filter(kept)),
    paints: [
      ...paints.map((paint, index) => [toPath(contours(fields.paints[index])), paint.fill, paint.opacity]),
      [toPath(contours(fields.layer)), '#000', LAYER.opacity],
    ],
    shade: toPath(contours(fields.shade)),
    light: toPath(contours(fields.light)),
    eyes: eyeRows,
  }
  const report = {
    clumps: rim.length, large: rim.filter(c => c.amount >= 0.75).length, tips: tips.length, lockLongest: +(Math.max(...rim.flatMap(c => c.tips.map(tip => tip.l))) * baseScale).toFixed(2), longest: +Math.max(...tips).toFixed(2), mean: +(tips.reduce((a, b) => a + b, 0) / tips.length).toFixed(2),
    shadeClumps: over.length, layers: layers.length - faceClumps, faceClumps, strokes: strokes.length, scale: +scale.toFixed(2), baseScale: +baseScale.toFixed(2),
  }
  return { character, report }
}

function build(model) {
  const size = (N + 1) * (N + 1)
  const field = new Float64Array(size)
  const rays = cast(model.sdf)
  const paints = model.paints ?? []
  // Every layer lies inside the body: its field is the body's field where the layer
  // applies and outside everywhere else, so no layer spills past the silhouette.
  const layers = { shade: new Float64Array(size), light: new Float64Array(size), paints: paints.map(() => new Float64Array(size)) }
  for (let i = 0; i <= N; i += 1) {
    for (let j = 0; j <= N; j += 1) {
      const k = i * (N + 1) + j
      const [d, hit] = rays[k]
      field[k] = d
      const off = Math.max(d, STEP)
      if (hit === null) {
        layers.shade[k] = off
        layers.light[k] = off
        layers.paints.forEach((layer) => { layer[k] = off })
        continue
      }
      const lit = dot(mul(toWorld, hit.n), LIGHT)
      layers.shade[k] = Math.max(d, (lit - SHADE_AT) * 0.25)
      layers.light[k] = Math.max(d, (LIGHT_AT - lit) * 0.25)
      paints.forEach((paint, index) => {
        layers.paints[index][k] = paint.all || hit.n[2] > 0.1 ? Math.max(d, paint.region(hit.p)) : off
      })
    }
  }
  const loops = contours(field)
  const all = loops.flat()
  const xs = all.map(p => p[0])
  const ys = all.map(p => p[1])
  const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)]
  const scale = 92 / Math.max(x1 - x0, y1 - y0)
  const cx = (x0 + x1) / 2
  const cy = (y0 + y1) / 2
  const place = ([X, Y]) => [50 + (X - cx) * scale, 50 - (Y - cy) * scale]
  const toPath = loopList => loopList.map((loop) => {
    // A closed loop starts and ends on the same point, so split it at its far side
    // before simplifying; otherwise every point is "on" the zero-length chord.
    const ring = loop.map(place)
    const far = ring.reduce((best, p, i) => (Math.hypot(p[0] - ring[0][0], p[1] - ring[0][1]) > Math.hypot(ring[best][0] - ring[0][0], ring[best][1] - ring[0][1]) ? i : best), 0)
    const points = [...simplify(ring.slice(0, far + 1), 0.25).slice(0, -1), ...simplify(ring.slice(far), 0.25)].slice(0, -1)
    // Relative steps on a 0.1 grid keep the strings short; rounding the running point
    // rather than each step stops the error from adding up around the loop.
    const grid = points.map(([x, y]) => [Math.round(x * 10), Math.round(y * 10)])
    const steps = grid.slice(1).map(([x, y], k) => [x - grid[k][0], y - grid[k][1]]).filter(([dx, dy]) => dx || dy)
    const num = v => (v < 0 ? '-' : ' ') + String(Math.abs(v) / 10).replace(/^0\./, '.')
    return `M${f(grid[0][0] / 10)} ${f(grid[0][1] / 10)}l${steps.map(([dx, dy]) => `${num(dx)}${num(dy)}`).join('').trim()}z`
  }).join('')
  // `eyeHeight` sizes the eyes in the model's own units; `eye` in the box's.
  const eyeSize = model.eyeHeight ? (model.eyeHeight * scale) / 23 : model.eye ?? 1
  const eyes = model.eyes.map(([x, y]) => {
    const { p, n } = surfaceAt(model.sdf, x, y)
    const u = norm(cross([0, 1, 0], n))
    const v = cross(n, u)
    const [wp, wu, wv] = [mul(toWorld, p), mul(toWorld, u), mul(toWorld, v)]
    const [ex, ey] = place([wp[0], wp[1]])
    const vs = [wv[0], -wv[1]]
    const tilt = (Math.atan2(vs[0], -vs[1]) * 180) / Math.PI
    return [ex, ey, 10 * eyeSize * Math.hypot(wu[0], wu[1]), 23 * eyeSize * Math.hypot(...vs), tilt].map(value => +value.toFixed(1))
  })
  return {
    ...(model.label ? { label: model.label } : {}),
    body: toPath(loops),
    ...(paints.length ? { paints: paints.map((paint, index) => [toPath(contours(layers.paints[index])), paint.fill, paint.opacity]) } : {}),
    shade: toPath(contours(layers.shade)),
    light: toPath(contours(layers.light)),
    eyes,
  }
}

export const CHARACTERS = Object.fromEntries(Object.entries(MODELS).map(([id, model]) => [id, Object.hasOwn(SOLVERS, id) ? buildFur(id).character : build(model)]))

const block = Object.entries(CHARACTERS).map(([id, character]) => `  ${id}: ${JSON.stringify(character).replace(/"(\w+)":/g, '$1:').replaceAll('"', "'")},`).join('\n')
console.log(`export const CHARACTERS = {\n${block}\n}`)

const out = process.argv.indexOf('--preview')
if (out > 0) {
  const colors = ['#A27952', '#FF3E51', '#FF781C', '#FFAF38', '#00C972', '#1CC3B0', '#2A92FE', '#A97EFE', '#FF5EB1', '#959595']
  const INK = { whale: '#4D6BFE', moon: '#141416', zed: '#2D2D2D', wave: '#EC2F6B', star: '#0AA8D6', squircle: '#FF6900', hex: '#082DFF' }
  const INK_DARK = { moon: '#F1F2F4', zed: '#D6D6DA' }
  let serial = 0
  const mark = (c, color, size) => {
    serial += 1
    const holes = c.eyes.map(([ex, ey, w, h, tilt]) => `<g transform="translate(${ex} ${ey}) rotate(${tilt})"><rect x="${-w / 2}" y="${-h / 2}" width="${w}" height="${h}" rx="${w / 2}" fill="#000"/></g>`).join('')
    const paint = (c.paints ?? []).map(([d, fill, opacity]) => `<path d="${d}" fill="${fill}" fill-opacity="${opacity}"/>`).join('')
    return `<svg width="${size}" height="${size}" viewBox="0 0 100 100"><defs><mask id="m${serial}" maskUnits="userSpaceOnUse" x="-100" y="-100" width="300" height="300"><rect x="-100" y="-100" width="300" height="300" fill="#fff"/>${holes}</mask></defs><g mask="url(#m${serial})" fill-rule="evenodd"><path d="${c.body}" fill="${color}"/>${paint}<path d="${c.shade}" fill="#000" fill-opacity=".07"/></g></svg>`
  }
  const cells = dark => Object.entries(CHARACTERS).map(([id, c], index) => {
    const color = (dark && INK_DARK[id]) || INK[id] || colors[index % colors.length]
    return `<div class="cell"><div>${mark(c, color, 96)}</div><div class="row">${mark(c, color, 40)}${mark(c, dark ? '#fff' : '#000', 28)}${mark(c, color, 20)}</div><div class="name">${id}</div></div>`
  }).join('')
  writeFileSync(process.argv[out + 1], `<!doctype html><meta charset="utf-8"><style>body{margin:0;font:13px -apple-system,system-ui,sans-serif;background:#fcfcfc}section{padding:12px 20px;display:grid;grid-template-columns:repeat(7,104px);gap:4px}.dark{background:#141414}.cell{display:flex;flex-direction:column;align-items:center;gap:6px;padding:6px 0}.row{display:flex;align-items:center;gap:6px}.name{color:#777}</style><section>${cells(false)}</section><section class="dark">${cells(true)}</section>`)
}
