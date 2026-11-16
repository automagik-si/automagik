import assert from 'node:assert/strict'
import { test } from 'node:test'
import { checkProfile, readProfile } from '../src/host/image.js'

const root = '<entry access="deny" escalatable="false"><special>:root</special></entry>'
const scratch = '<entry access="read"><path>/S</path></entry>'
const helper = '<entry access="read"><path>/H/tmp/arg0-linux/codex-arg0hEg6rp</path></entry>'
const block = (entries = root + scratch + helper) => `<permission_profile type="managed"><file_system type="restricted">${entries}</file_system></permission_profile>`
const input = text => JSON.stringify([{ type: 'message', content: [{ type: 'input_text', text: `<environment_context>${text}</environment_context>` }] }])
const check = text => checkProfile(readProfile(input(text)), { scratch: '/S', codexHome: '/H' })

for (const [name, value] of [
  ['measured Linux shape', block()], ['without helper', block(root + scratch)],
  ['order free', block(helper + scratch + root)], ['root escalatable absent', block().replace(' escalatable="false"', '')],
]) test(`resolved image profile accepts ${name}`, () => assert.equal(check(value), true))

for (const [name, value] of [
  ['extra read', block(root + scratch + helper + '<entry access="read"><path>/outside</path></entry>')],
  ['scratch write', block(root + scratch.replace('read', 'write'))],
  ['sibling scratch', block().replace('/S</path>', '/S-other</path>')],
  ['missing root', block(scratch)], ['duplicate root', block(root + root + scratch)],
  ['duplicate scratch', block(root + scratch + scratch)], ['duplicate helper', block(root + scratch + helper + helper)],
  ['escalatable root', block().replace('escalatable="false"', 'escalatable="true"')],
  ['escalatable scratch', block(root + scratch.replace('access="read"', 'access="read" escalatable="false"'))],
  ['minimal special', block(root + scratch + '<entry access="read"><special>:minimal</special></entry>')],
  ...['unrestricted', 'external', 'disabled'].map(type => [`profile ${type}`, block().replace('type="managed"', `type="${type}"`)]),
  ['unrestricted filesystem', block().replace('type="restricted"', 'type="unrestricted"')],
  ['unknown element', block(root + scratch + '<unknown/>')],
  ['unknown attribute', block().replace('access="deny"', 'access="deny" extra="yes"')],
  ['unknown profile attribute', block().replace('type="managed"', 'type="managed" extra="yes"')],
  ['unknown nesting', block(root + scratch.replace('/S', '<nested>/S</nested>'))],
  ['stray text', block(root + 'text' + scratch)], ['two blocks', block() + block()], ['no block', 'nothing'],
  ['unclosed second block', block() + '<permission_profile type="managed">'],
  ['helper outside home', block().replace('/H/tmp/', '/other/tmp/')],
  ['wrong helper shape', block().replace('/H/tmp/arg0-linux/codex-arg0hEg6rp', '/H/tmp/other')],
  ['helper trailing path', block().replace('codex-arg0hEg6rp', 'codex-arg0hEg6rp/child')],
  ['helper write', block(root + scratch + helper.replace('access="read"', 'access="write"'))],
  ['escalatable helper', block(root + scratch + helper.replace('access="read"', 'access="read" escalatable="false"'))],
  ['second distinct helper', block(root + scratch + helper + helper.replace('hEg6rp', 'OTHER1'))],
  ['home prefix lookalike', block().replace('/H/tmp/', '/H-other/tmp/')],
  ['helper traversal', block().replace('arg0-linux/', 'arg0-linux/../')],
  ['root read', block(root.replace('access="deny"', 'access="read"') + scratch)],
  ['missing scratch', block(root + helper)],
  ['unresolved workspace special', block(root + '<entry access="read"><special>:workspace_roots</special></entry>')],
  ['unknown entity', block().replace('/S</path>', '/S&unknown;</path>')],
  ['numeric entity', block().replace('/S</path>', '/S&#38;</path>')],
]) test(`resolved image profile rejects ${name}`, () => assert.equal(check(value), false))

test('resolved image profile decodes only the five named entities and escapes the home regex', () => {
  const text = block().replace('/S</path>', '/S&amp;&lt;&gt;&quot;&apos;</path>').replace('/H/tmp/', '/H.+[x]/tmp/')
  const parsed = readProfile(input(text))
  assert.equal(parsed.entries[1].path, '/S&<>"\'')
  assert.equal(checkProfile(parsed, { scratch: '/S&<>"\'', codexHome: '/H.+[x]' }), true)
  assert.equal(checkProfile(parsed, { scratch: '/S&<>"\'', codexHome: '/H' }), false)
  assert.equal(readProfile('invalid json'), undefined)
  assert.equal(readProfile('{}'), undefined)
})

for (const [name, value] of [
  ['filesystem attribute', block().replace('type="restricted"', 'type="restricted" extra="yes"')],
  ['path attribute', block().replace('<path>/S', '<path extra="yes">/S')],
  ['duplicate attribute', block().replace('access="deny"', 'access="deny" access="read"')],
  ['invalid boolean', block().replace('escalatable="false"', 'escalatable="False"')],
  ['two entry targets', block(root + scratch.replace('</path>', '</path><special>:root</special>'))],
  ['nested entry', block(root + scratch.replace('/S', '<entry access="read">/S</entry>'))],
  ['trailing element', block().replace('</file_system>', '</file_system><network/>')],
  ['bare ampersand', block().replace('/S</path>', '/S&</path>')],
  ['missing entity terminator', block().replace('/S</path>', '/S&amp</path>')],
]) test(`resolved image profile parser rejects ${name} outright`, () => {
  assert.equal(readProfile(input(value)), undefined)
})

test('resolved image profile reads only message text parts and refuses duplicate blocks across messages', () => {
  const message = (type, text) => ({ type: 'message', content: [{ type, text }] })
  for (const type of ['input_text', 'output_text', 'text']) {
    assert.ok(checkProfile(readProfile(JSON.stringify([message(type, block())])), { scratch: '/S', codexHome: '/H' }))
  }
  for (const items of [
    [{ type: 'function_call_output', output: block() }],
    [{ type: 'message', content: [{ type: 'image', text: block() }] }],
    [message('input_text', block()), message('output_text', block())],
  ]) assert.equal(readProfile(JSON.stringify(items)), undefined)
})

test('resolved image profile decodes entities once rather than treating their result as markup', () => {
  const parsed = readProfile(input(block().replace('/S</path>', '/S&amp;unknown;</path>')))
  assert.equal(parsed.entries[1].path, '/S&unknown;')
  assert.ok(checkProfile(parsed, { scratch: '/S&unknown;', codexHome: '/H' }))
})
