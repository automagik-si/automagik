import assert from 'node:assert/strict'
import { test } from 'node:test'
import { checkProfile, readProfile } from '../src/host/image.js'

const root = '<entry access="deny" escalatable="false"><special>:root</special></entry>'
const scratch = '<entry access="read"><path>/S</path></entry>'
const helper = '<entry access="read"><path>/H/tmp/arg0-linux/codex-arg0hEg6rp</path></entry>'
const block = (entries = root + scratch + helper) =>
  '<permission_profile type="managed"><file_system type="restricted">'
    + `${entries}</file_system></permission_profile>`
const input = text => JSON.stringify([{ type: 'message', content: [{
  type: 'input_text', text: `<environment_context>${text}</environment_context>`,
}] }])
const check = (text, codexHome = '/H') =>
  checkProfile(readProfile(input(text)), { scratch: '/S', codexHome })

test('the image helper accepts a path rooted at the Codex home', () => {
  assert.equal(check(block()), true)
})

test('the image helper accepts a literal home with regex characters', () => {
  const entry = '<entry access="read"><path>/H.+[x]/tmp/arg0-a/codex-arg0b</path></entry>'
  assert.equal(check(block(root + scratch + entry), '/H.+[x]'), true)
})

for (const [home, path] of [
  ['/H', '/other/H/tmp/arg0-linux/codex-arg0hEg6rp'],
  ['/H', '/x/H/tmp/arg0-a/codex-arg0b'],
  ['/H.+[x]', '/p/H.+[x]/tmp/arg0-a/codex-arg0b'],
]) test(`the image helper refuses a suffix home in ${path}`, () => {
  const entry = `<entry access="read"><path>${path}</path></entry>`
  assert.equal(check(block(root + scratch + entry), home), false)
})
