import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

test('D2Y-1 host route sources pass through readableRoute before provider decisions', () => {
  const rawRoute = /(?:\brequestHeader|\bmodel(?:\?\.|\.)current|(?<!function )\bstoredRoute(?:Of)?)\s*(?:\?\.)?\(|\bvalues\??\.modelSelection\b|\bevent\??\.data\??\.header\b/
  // A checked call may contain accessor calls in its argument.
  const checkedCall = /\breadableRoute\((?:[^()\n]|\([^()\n]*\))*\)/g

  for (const name of ['role-runtime.js', 'models.js', 'parts.js']) {
    const source = readFileSync(new URL(`../src/host/${name}`, import.meta.url), 'utf8')
    const lines = source.split('\n')
    for (const [index, line] of lines.entries()) {
      const unchecked = line.replace(checkedCall, '')
      if (unchecked.trimStart().startsWith('//') || !rawRoute.test(unchecked)) continue
      const location = `${name}:${index + 1}: ${line.trim()}`
      // Some callers keep the raw result to distinguish absence from malformation
      // or to read metadata. Their next line must validate the route itself.
      const binding = /^\s*const (\w+) = /.exec(unchecked)?.[1]
      assert.ok(binding && /(?:\)|\.(?:header|next))\s*$/.test(unchecked), location)
      assert.match(lines[index + 1] ?? '', new RegExp(`\\breadableRoute\\(${binding}\\b`), location)
      const directField = new RegExp(`(?<![\\w$.])${binding}(?:\\??\\.config)?\\??\\.(?:provider|model)\\b`)
      assert.doesNotMatch(source, directField, location)
    }
  }
})
