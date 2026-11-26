import { existsSync, readFileSync, watch } from 'node:fs'
import { join } from 'node:path'

// Await the supervisor's file event instead of polling it into existence. The wrapper renames
// its ready signal into place, so any observed ready file already carries the full content.
export function waitForContent(directory, name, expected, { timeoutMs, child, diagnostic }) {
  const target = join(directory, name)
  return new Promise((resolve, reject) => {
    let watcher
    let timer
    let settled = false
    let observed = 'missing'
    const finish = error => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      watcher?.close()
      child?.removeListener('close', exited)
      if (error) reject(error)
      else resolve(observed)
    }
    const check = () => {
      try {
        observed = readFileSync(target, 'utf8')
        if (typeof expected === 'function' ? expected(observed) : observed === expected) finish()
      } catch (error) {
        observed = error.code === 'ENOENT' ? 'missing' : `${error.code}: ${error.message}`
      }
    }
    const exited = () => {
      check()
      if (!settled) finish(new Error(diagnostic(
        `the supervisor exited before ${name} was ready (last content: ${JSON.stringify(observed)})`)))
    }
    timer = setTimeout(() => {
      // The bound is the last chance to look: a dropped watch event must not fail the wait
      // while a complete ready file is already on disk.
      check()
      finish(new Error(diagnostic(
        `${name} was not ready within ${timeoutMs}ms `
        + `(last content: ${JSON.stringify(observed)})`)))
    }, timeoutMs)
    try {
      watcher = watch(directory, { persistent: true }, check)
      watcher.on('error', error => finish(new Error(diagnostic(
        `watching ${name} failed: ${error.message}`))))
    } catch (error) {
      finish(new Error(diagnostic(`watching ${name} failed: ${error.message}`)))
      return
    }
    child?.once('close', exited)
    check()
    if (child && (child.pid === undefined || child.exitCode !== null
      || child.signalCode !== null)) exited()
  })
}

// Await a file the app writes for the test. The app renames it into place, so an observed
// record is complete; the bound only caps a hang and still looks once before failing.
export function waitForFile(directory, name, { timeoutMs, child, diagnostic }) {
  const target = join(directory, name)
  return new Promise((resolve, reject) => {
    let watcher
    let timer
    let settled = false
    const finish = error => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      watcher?.close()
      child?.removeListener('close', exited)
      if (error) reject(error)
      else resolve()
    }
    const check = () => {
      if (existsSync(target)) finish()
    }
    const exited = () => {
      check()
      if (!settled) finish(new Error(diagnostic(
        `the app exited before ${name} was written`)))
    }
    timer = setTimeout(() => {
      // The bound is the last chance to look: a dropped watch event must not fail the wait
      // while the app's complete record is already on disk.
      check()
      finish(new Error(diagnostic(`${name} was not written within ${timeoutMs}ms`)))
    }, timeoutMs)
    try {
      watcher = watch(directory, { persistent: true }, check)
      watcher.on('error', error => finish(new Error(diagnostic(
        `watching ${name} failed: ${error.message}`))))
    } catch (error) {
      finish(new Error(diagnostic(`watching ${name} failed: ${error.message}`)))
      return
    }
    child?.once('close', exited)
    check()
    if (child && (child.pid === undefined || child.exitCode !== null
      || child.signalCode !== null)) exited()
  })
}

// A successful stop empties the Job, so the delayed writer can never produce its file. Watch
// for the bound instead of sleeping: a defect that leaks the writer fails at its first write.
export function assertStaysAbsent(directory, name, { timeoutMs, diagnostic }) {
  const target = join(directory, name)
  return new Promise((resolve, reject) => {
    let watcher
    let timer
    let settled = false
    const finish = error => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      watcher?.close()
      if (error) reject(error)
      else resolve()
    }
    const check = () => {
      if (existsSync(target)) finish(new Error(diagnostic(
        `${name} appeared after login stop`)))
    }
    timer = setTimeout(() => {
      // The bound is the last chance to look: a dropped watch event must not let the watch
      // pass while the credential file is already on disk.
      check()
      finish()
    }, timeoutMs)
    try {
      watcher = watch(directory, { persistent: true }, check)
      watcher.on('error', error => finish(new Error(diagnostic(
        `watching ${name} failed: ${error.message}`))))
    } catch (error) {
      finish(new Error(diagnostic(`watching ${name} failed: ${error.message}`)))
      return
    }
    check()
  })
}
