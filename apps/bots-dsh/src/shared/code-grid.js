/** Bounds for a terminal grid drawn by the Code pane. */
export function validGrid(size) {
  const { cols, rows } = size ?? {}
  return Number.isInteger(cols) && cols >= 2 && cols <= 1000
    && Number.isInteger(rows) && rows >= 1 && rows <= 1000
    && cols * rows <= 250_000
}
