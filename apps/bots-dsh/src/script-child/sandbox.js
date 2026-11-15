// Where a browser_exec script runs: QuickJS, a JavaScript interpreter compiled to
// WebAssembly. The script and everything it can reach live in the interpreter's own
// memory, which is one WebAssembly array; no object of this process's JavaScript (Node)
// can be handed to it, because the two do not share objects at all. What crosses is what
// this file copies across, and that is two functions:
//
//   call(name, args)        both text; answers a number, the call's id, or 0 for "no"
//   finish(answer, error)   each null, or a text written as JSON; answers nothing
//
// Each copies text out of the interpreter and nothing else, and never throws: the
// interpreter would turn an exception of this side into an error of its own that carries
// this side's message and stack. The other direction is one function of the script's
// side, `settle`, called with a number, a boolean and text or null.
//
// An answer and an error cross as JSON because the copy out of the interpreter ends at a
// NUL character and does not keep half a surrogate pair: JSON writes both as escapes, so
// the text arrives whole. Helper arguments are JSON already.
//
// test/browser-script-sandbox.test.js checks that these two are the whole surface.
import variant from '@jitl/quickjs-singlefile-mjs-release-sync'
import { newQuickJSWASMModuleFromVariant } from 'quickjs-emscripten-core'

// The stack the interpreter may use: about 1,500 nested calls. Past it the script gets
// an error of its own (stack overflow). The interpreter's calls are made on this
// process's own stack, and the engine's own code can run through that one first (a deep
// structure it walks): the run then ends with the same error, wherever this side meets
// it, inside the two functions included.
//
// Memory has no limit here. The interpreter's own limit counts one allocation at a time
// in this build, not the total, so the total is capped where it cannot be miscounted: the
// runner starts this process with a cap on any WebAssembly memory (script-runner.js).
const STACK_LIMIT = 256 * 1024
// The longest text either function takes: the host refuses longer helper arguments, and
// an answer goes to a model. As JSON a character is at most six, between two quotes.
export const MAX_TEXT = 4_000_000
const MAX_JSON = MAX_TEXT * 6 + 2
const NOT_TEXT = 'Script produced an answer that is not text, or is longer than 4 MB.'
// What a script is told in place of a helper's reply that its memory has no room for.
export const NO_ROOM = 'The helper\'s reply does not fit in the memory the script has left.'

// The interpreter has no room for something this side was about to place in its memory.
class NoRoom extends Error {}
// The two errors of this side after which the interpreter is not entered again, as the
// script would have been told them: this process's stack ran out, or the interpreter's
// memory did. Anything else is undefined.
const fatal = (error) => {
  if (error instanceof RangeError) return 'InternalError: stack overflow'
  return error instanceof NoRoom ? 'InternalError: out of memory' : undefined
}

// Runs inside the interpreter. It keeps its own copies of the built-ins it uses, so a
// script that rewrites JSON or Promise breaks only itself, and it holds `call` and
// `finish` in its closure: the script gets the helpers, never the two functions.
export const PRELUDE = `(function (call, finish, namesJson, body) {
  'use strict'
  const { parse, stringify } = JSON
  const toText = String
  const PromiseOf = Promise
  const ErrorOf = Error
  const names = parse(namesJson)
  // "TypeError: cannot read property 'x' of null": the kind of error is half the message.
  const describe = error => {
    try {
      // The interpreter throws null when it has no memory left to make an error with.
      if (error === null) return 'Script threw null (the interpreter does that when it is out of memory).'
      if (typeof error !== 'object' || !('message' in error)) return toText(error)
      const name = typeof error.name === 'string' && error.name !== 'Error' ? error.name + ': ' : ''
      return name + toText(error.message)
    } catch { return 'Script failed.' }
  }
  // An error, and the run's end, as finish takes them: JSON.
  const fail = (error) => {
    let text = '"Script failed."'
    try { text = stringify(describe(error)) } catch {}
    finish(null, text)
  }
  const waiting = { __proto__: null }
  const ask = name => (...args) => new PromiseOf((resolve, reject) => {
    // JSON turns a trailing undefined into null, which would defeat a helper's default.
    while (args.length > 0 && args[args.length - 1] === undefined) args.length -= 1
    const json = stringify(args)
    if (typeof json === 'string' && json.length > ${MAX_TEXT}) {
      reject(new ErrorOf('Helper arguments are larger than 4 MB.'))
      return
    }
    const id = call(name, json)
    if (!(id > 0)) {
      reject(new ErrorOf('Helper arguments must be plain JSON values.'))
      return
    }
    waiting[id] = {
      resolve: (value) => {
        try { resolve(value === null ? undefined : parse(value)) } catch (error) { reject(error) }
      },
      reject: message => reject(new ErrorOf(message)),
    }
  })
  const helpers = []
  for (let index = 0; index < names.length; index += 1) helpers[index] = ask(names[index])
  let answer
  const done = (value) => { answer = value }
  const timers = { __proto__: null }
  let lastTimer = 0
  const setTimeout = (fn, ms, ...rest) => {
    const timer = ++lastTimer
    const id = call('wait', stringify([+ms || 0]))
    if (!(id > 0)) return timer
    timers[timer] = true
    waiting[id] = {
      resolve: () => {
        if (!timers[timer]) return
        delete timers[timer]
        if (typeof fn === 'function') fn(...rest)
      },
      reject: () => {},
    }
    return timer
  }
  const clearTimeout = (timer) => { delete timers[timer] }
  const noop = () => {}
  const console = { log: noop, info: noop, warn: noop, error: noop, debug: noop }
  const settle = (id, ok, value) => {
    const waiter = waiting[id]
    if (waiter === undefined) return
    delete waiting[id]
    if (ok) waiter.resolve(value)
    else waiter.reject(typeof value === 'string' ? value : 'The helper failed.')
  }
  const end = (value) => {
    let text = null
    try {
      if (value !== undefined) {
        const answer = toText(value)
        // Too long is said before the JSON of it is made, which can be six times as long.
        text = answer.length > ${MAX_TEXT} ? undefined : stringify(answer)
      }
    } catch (error) {
      fail(error)
      return
    }
    if (text === undefined) finish(null, ${JSON.stringify(JSON.stringify(NOT_TEXT))})
    else finish(text, null)
  }
  let run
  try {
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
    run = new AsyncFunction(...names, 'done', 'setTimeout', 'clearTimeout', 'console', '"use strict";\\n' + body)
  } catch (error) {
    fail(error)
    return settle
  }
  run(...helpers, done, setTimeout, clearTimeout, console).then(value => end(answer ?? value), fail)
  return settle
})`

// call(name, args) → a positive id, or anything else for "no"; finish(answer, error).
// Both are this side's and get text (finish: or null) only. overdue() → undefined, or
// once the run's time is up the error to end it with; it is asked while a script runs.
// Resolves to start(names, body) and settle(id, ok, text), plus the context for the tests.
export async function openSandbox({ call, finish, overdue = () => undefined, prelude = PRELUDE }) {
  const QuickJS = await newQuickJSWASMModuleFromVariant(variant)
  // Everything this side places in the interpreter's memory, a text or a list, needs
  // room there. This checks that the interpreter had room before anything is placed:
  // with none, nothing is placed and the library's call fails with an error of this side.
  const allocate = QuickJS.module._malloc
  QuickJS.module._malloc = (size) => {
    const at = allocate(size)
    if (at === 0 && size > 0) throw new NoRoom()
    return at
  }
  const runtime = QuickJS.newRuntime()
  runtime.setMaxStackSize(STACK_LIMIT)
  // import() and import statements find nothing to load.
  runtime.setModuleLoader(() => ({ error: new Error('Imports are not available.') }))
  const context = runtime.newContext()
  // The property names this side reads, placed once, while the interpreter is empty.
  const keys = { length: context.newString('length'), name: context.newString('name'), message: context.newString('message') }

  // Once the interpreter itself failed (no memory left to report an error with, or this
  // process's stack ran out under it), or the run's time is up, its state is not to be
  // entered again: the run ends here, with the error said from this side. `broken` is
  // that error. Where saying it fails too (no stack left for that either), it is said
  // again once the stack is back.
  let broken
  let told = false
  const tell = () => {
    if (broken === undefined || told) return
    try {
      finish(null, broken)
      told = true
    } catch {}
  }
  const breakWith = (message) => {
    if (broken !== undefined) return
    broken = message
    tell()
  }
  // An error of this side inside one of the two functions: the script is not told, and
  // one this side cannot go on after ends the run.
  const caught = (error) => {
    const message = fatal(error)
    if (message !== undefined) breakWith(message)
  }
  // The interpreter asks this while a script runs, and stops the script where it is when
  // the answer is yes; no catch or finally of the script runs after it. So a script
  // whose own code never yields ends at the run's deadline without the host, and a run
  // that ended here runs no more of its script. It is not asked during one long call of
  // a built-in: such a script is stopped by the host only.
  runtime.setInterruptHandler(() => {
    try {
      const late = broken === undefined ? overdue() : undefined
      if (late !== undefined) breakWith(String(late))
    } catch {}
    return broken !== undefined
  })

  // Text out of the interpreter, or undefined for anything that is not text or is longer
  // than `limit`.
  const text = (handle, limit = MAX_TEXT) => {
    if (handle === undefined || context.typeof(handle) !== 'string') return undefined
    // The length first: a text too long is refused before a copy of it is made here.
    const length = context.getProp(handle, keys.length).consume(value => context.getNumber(value))
    if (!(length <= limit)) return undefined
    // And again after: the copy of a text that is not well formed can be longer than it.
    const copy = context.getString(handle)
    return copy.length <= limit ? copy : undefined
  }
  // An answer or an error out of the interpreter: null, or the text its JSON holds.
  // Undefined for anything else: a missing argument, text that is not the JSON of a
  // text, and a text too long.
  const textOrNull = (handle) => {
    if (handle === undefined) return undefined
    const type = context.typeof(handle)
    if (type !== 'string') return type === 'object' && context.sameValue(handle, context.null) ? null : undefined
    const json = text(handle, MAX_JSON)
    if (json === undefined) return undefined
    let value
    try { value = JSON.parse(json) } catch { return undefined }
    return typeof value === 'string' && value.length <= MAX_TEXT ? value : undefined
  }

  const callFunction = context.newFunction('call', (nameHandle, argsHandle) => {
    let id = 0
    // A run that ended makes no more helper calls.
    if (broken === undefined) {
      try {
        const name = text(nameHandle)
        const args = text(argsHandle)
        if (name !== undefined && args !== undefined) id = call(name, args)
      } catch (error) {
        caught(error)
      }
    }
    return context.newNumber(Number.isSafeInteger(id) && id > 0 ? id : 0)
  })
  const finishFunction = context.newFunction('finish', (answerHandle, errorHandle) => {
    // A run that ended has its error already.
    if (broken === undefined) {
      try {
        const answer = textOrNull(answerHandle)
        const error = textOrNull(errorHandle)
        if (answer === undefined || error === undefined) finish(null, NOT_TEXT)
        else finish(answer, error)
      } catch (error) {
        caught(error)
      }
    }
    return context.undefined
  })

  // The name and message of an error of the interpreter. Reading them can run a getter
  // of the script; it runs inside the interpreter, like the rest of the script.
  const describe = (handle) => {
    try {
      const read = key => context.getProp(handle, key).consume(value => context.typeof(value) === 'string' ? context.getString(value) : '')
      const name = read(keys.name)
      const message = read(keys.message)
      return name && message ? `${name}: ${message}` : name || message || 'Script failed.'
    } catch (error) {
      return fatal(error) ?? 'Script failed.'
    }
  }
  // Every entry into the interpreter, then the promise reactions it left to run. A
  // reaction of the script that throws rejects a promise of the script; one that fails
  // here could not even do that.
  const enter = (fn) => {
    if (broken !== undefined) return
    try {
      fn()
      while (broken === undefined && runtime.hasPendingJob()) {
        const result = runtime.executePendingJobs()
        if (result.error) result.error.consume(error => breakWith(describe(error)))
      }
    } catch (error) {
      breakWith(fatal(error) ?? 'Script failed.')
    }
    tell()
  }
  // Text into the interpreter, or undefined when the interpreter has no room for it.
  const place = (value) => {
    let handle
    try {
      handle = context.newString(value)
    } catch (error) {
      if (error instanceof NoRoom) return undefined
      throw error
    }
    // Room for the copy, and none for the interpreter's own text of it.
    if (context.typeof(handle) === 'string') return handle
    handle.dispose()
    return undefined
  }

  let settleHandle
  return {
    context,
    start(names, body) {
      enter(() => {
        const install = context.unwrapResult(context.evalCode(prelude, 'browser_exec'))
        const namesHandle = context.newString(JSON.stringify(names))
        const bodyHandle = context.newString(body)
        try {
          const result = context.callFunction(install, context.undefined, callFunction, finishFunction, namesHandle, bodyHandle)
          if (result.error) result.error.consume(error => breakWith(describe(error)))
          else settleHandle = result.value
        } finally {
          install.dispose()
          namesHandle.dispose()
          bodyHandle.dispose()
        }
      })
    },
    settle(id, ok, value) {
      enter(() => {
        if (settleHandle === undefined || context.typeof(settleHandle) !== 'function') return
        const placed = typeof value === 'string'
        let valueHandle = context.null
        if (placed) {
          valueHandle = place(value)
          // A reply the interpreter has no room for is not handed to it: the script's
          // call fails with an error that says so. No room for that either ends the run.
          if (valueHandle === undefined) {
            ok = false
            valueHandle = place(NO_ROOM)
            if (valueHandle === undefined) throw new NoRoom()
          }
        }
        const idHandle = context.newNumber(id)
        try {
          const result = context.callFunction(settleHandle, context.undefined, idHandle, ok ? context.true : context.false, valueHandle)
          if (result.error) result.error.consume(error => breakWith(describe(error)))
          else result.value.dispose()
        } finally {
          idHandle.dispose()
          if (placed) valueHandle.dispose()
        }
      })
    },
  }
}
