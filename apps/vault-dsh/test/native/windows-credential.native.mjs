import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { watch } from 'node:fs'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, win32 } from 'node:path'
import { test } from 'node:test'
import { createWindowsCredential } from '../../src/windows-credential/adapter.js'
import { connection, provider } from '../../src/windows-credential/parse.js'
import { availability, createRunner, environment, powershell, root } from '../../src/windows-credential/run.js'
import { encodedArgs, readerArgs, readerSource, windowsScript } from '../../src/windows-credential/script.js'
import { checkTranscripts, compilerScratchEvidence, filesBelow } from './wincred-evidence.mjs'
import { cleanupTargets, invokeFixture, writerArgs } from './wincred-writer.ps1.mjs'

if (process.platform !== 'win32' || process.env.VAULT_WINDOWS_NATIVE !== '1') {
  throw new Error('This check requires the disposable native Windows CI job')
}
assert.equal(availability(), undefined)

const recordHarness = String.raw`
public static class ReaderChecks {
  private class SplitInput : MemoryStream {
    public SplitInput(byte[] bytes) : base(bytes) {}
    public override int Read(byte[] bytes, int offset, int count) {
      return base.Read(bytes, offset, Math.Min(2, count));
    }
  }
  public static int Run() {
    string op, target;
    if (!AutomagikWinCred.Request(new SplitInput(Encoding.ASCII.GetBytes("probe \n")), out op, out target)
        || op != "probe") return 13;
    if (AutomagikWinCred.Request(new SplitInput(new byte[2049]), out op, out target)
        || AutomagikWinCred.Request(new SplitInput(new byte[] { 0xF0, 114, 111, 98, 101, 32, 10 }), out op, out target)
        || AutomagikWinCred.Request(new SplitInput(Encoding.ASCII.GetBytes("read YWJjZB==\n")), out op, out target)) return 13;
    foreach (string malformed in new string[] { "probe \r\n", "probe \nprobe \n", "probe " }) {
      if (AutomagikWinCred.Request(new SplitInput(Encoding.ASCII.GetBytes(malformed)), out op, out target)) return 13;
    }

    var entry = new AutomagikWinCred.Credential {
      Type = 1, Persist = 3, TargetName = "Fixture", CredentialBlobSize = 2, CredentialBlob = new IntPtr(1)
    };
    int copies = 0;
    Action<IntPtr, byte[], int, int> copy = (pointer, bytes, start, size) => { copies++; };
    using (var output = new MemoryStream()) {
      if (AutomagikWinCred.Record(entry, "fIXTURE", true, output, copy) != 0 || copies != 0) return 13;
      if (AutomagikWinCred.Record(entry, "fIXTURE", false, output, copy) != 0 || copies != 1) return 13;
      if (AutomagikWinCred.Record(entry, "Fixtures", false, output, copy) != 13) return 13;
      entry.Type = 2;
      if (AutomagikWinCred.Record(entry, "Fixture", false, output, copy) != 13) return 13;
      entry.Type = 1;
      entry.Flags = 4;
      if (AutomagikWinCred.Record(entry, "Fixture", false, output, copy) != 13) return 13;
      entry.Flags = 0;
      entry.Persist = 0;
      if (AutomagikWinCred.Record(entry, "Fixture", false, output, copy) != 13) return 13;
      entry.Persist = 1;
      entry.CredentialBlobSize = 2561;
      if (AutomagikWinCred.Record(entry, "Fixture", false, output, copy) != 13) return 13;
      entry.CredentialBlobSize = 2;
      entry.CredentialBlob = IntPtr.Zero;
      if (AutomagikWinCred.Record(entry, "Fixture", false, output, copy) != 13) return 13;
      entry.CredentialBlob = new IntPtr(1);
      if (!CheckReserved(entry, output)) return 13;
    }
    return copies == 1 ? 0 : 13;
  }

  private static bool CheckReserved(AutomagikWinCred.Credential entry, Stream output) {
    int copies = 0;
    Action<IntPtr, byte[], int, int> copy = (pointer, bytes, start, size) => { copies++; };
    if (AutomagikWinCred.Record(entry, entry.TargetName, false, output, copy) != 0) return false;
    entry.TargetName = "AuToMaGiK-VaUlT:Fixture";
    if (AutomagikWinCred.Record(entry, entry.TargetName, false, output, copy) != 13) return false;
    return copies == 1;
  }
}
`

const envHarness = String.raw`
using System;
using System.Collections;
using System.Collections.Generic;
using System.Text;
public static class EnvCheck {
  public static int Run() {
    var expected = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
    var optional = new HashSet<string>(StringComparer.OrdinalIgnoreCase) {
      "HOMEDRIVE", "HOMEPATH", "LOGONSERVER", "SYSTEMDRIVE", "USERDOMAIN", "USERNAME", "USERPROFILE", "NODE_V8_COVERAGE"
    };
    var problems = new List<string>();
    string line;
    while ((line = Console.In.ReadLine()) != null) {
      int sep = line.IndexOf(' ');
      expected.Add(line.Substring(0, sep), Encoding.UTF8.GetString(Convert.FromBase64String(line.Substring(sep + 1))));
    }
    foreach (DictionaryEntry entry in Environment.GetEnvironmentVariables()) {
      string key = (string)entry.Key;
      string value;
      if (!expected.TryGetValue(key, out value)) problems.Add("unexpected " + key);
      else if (value != (string)entry.Value) problems.Add("different " + key);
      expected.Remove(key);
    }
    foreach (string key in expected.Keys) if (!optional.Contains(key)) problems.Add("missing " + key);
    // Names only, never values.
    if (problems.Count > 0) { Console.Out.WriteLine(string.Join(" ", problems)); return 13; }
    Console.Out.WriteLine("environment matches");
    return 0;
  }
}
`

const b64 = data => Buffer.from(data).toString('base64')
const request = (op, target = '') => Buffer.from(op + ' ' + b64(target) + '\n')
const output = (prefix, bytes) => Buffer.from(prefix + ' ' + b64(bytes) + '\n')
const clean = result => result.code === 0 && result.stderr.length === 0
test('native Windows Credential Manager round trip, validation and transcript privacy', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vault-windows-native-'))
  const transcriptDir = join(dir, 'transcripts')
  await mkdir(transcriptDir)
  const executions = []
  const markers = []
  const scratch = new Map()
  const sensitiveScratch = []
  let inspectedFiles = 0
  let scratchError = false
  let privateScratchBytes = false
  const privateNeedles = () => markers.flatMap(bytes => {
    // The one-byte malformed fixture isn't a useful privacy canary.
    if (bytes.length < 8) return []
    const text = bytes.toString('utf8')
    const forms = [bytes, Buffer.from(b64(bytes)), Buffer.from(b64(bytes), 'utf16le')]
    if (Buffer.from(text).equals(bytes)) forms.push(Buffer.from(text, 'utf16le'))
    return forms
  })

  function observeScratch(cwd, operation) {
    const evidence = compilerScratchEvidence(bytes => {
      inspectedFiles++
      privateScratchBytes ||= privateNeedles().some(marker => bytes.includes(marker))
    })
    const watcher = watch(cwd, { recursive: true }, (event, name) => {
      if (name) evidence.inspect(join(cwd, name), event)
      else if (operation) scratchError = true
    })
    watcher.on('error', () => { scratchError = true })
    scratch.set(cwd, { watcher, evidence })
    if (operation) sensitiveScratch.push({ operation, evidence })
  }

  async function inspectAndRemove(cwd, options) {
    const { watcher, evidence } = scratch.get(cwd)
    try {
      for await (const file of filesBelow(cwd)) evidence.inspect(file)
    } finally {
      watcher.close()
      scratchError ||= evidence.unexpected
      await rm(cwd, options)
      scratch.delete(cwd)
    }
  }

  async function privateScratch(work, operation) {
    const cwd = await mkdtemp(join(dir, 'fixture-'))
    observeScratch(cwd, operation)
    try { return await work(cwd) }
    finally { await inspectAndRemove(cwd, { force: true, recursive: true }) }
  }

  const native = (args, stdin, split, operation) => privateScratch(cwd =>
    invokeFixture(powershell, args, { cwd, env: environment(cwd), stdin, split }), operation)
  const registry = win32.join(root, 'System32', 'reg.exe')
  const policy = 'HKCU\\Software\\Policies\\Microsoft\\Windows\\PowerShell\\Transcription'
  const registryCommand = (...args) => invokeFixture(registry, args, { cwd: dir, env: environment(dir) })
  let readerOperation
  const runner = createRunner({
    profileDir: () => dir,
    removeScratch: inspectAndRemove,
    spawnChild(file, args, options) {
      if (file === powershell) {
        observeScratch(options.cwd, readerOperation === 'probe' ? undefined : 'adapter ' + readerOperation)
      }
      const child = spawn(file, args, options)
      if (file === powershell) executions.push(child.pid)
      return child
    },
  })
  const adapter = createWindowsCredential({}, {
    runner,
    run(op, ...args) {
      // The runner starts PowerShell synchronously, then settles I/O and cleanup separately.
      readerOperation = op
      try { return runner.run(op, ...args) } finally { readerOperation = undefined }
    },
  })
  const targets = new Map()
  const policyKeys = []
  const ref = item => ({ provider, connection, item, field: 'password' })
  const raw = async (op, target, split) => {
    const result = await native(readerArgs, request(op, target), split, op === 'probe' ? undefined : 'reader ' + op)
    executions.push(result.pid)
    return result
  }
  async function write(value, { kind = 'text', userName = randomUUID(), target = 'automagik-ci-' + randomUUID() } = {}) {
    const payload = Buffer.from(value)
    markers.push(Buffer.from(target), Buffer.from(userName), payload)
    if (kind === 'text') markers.push(Buffer.from(value, 'utf16le'))
    targets.set(target, false)
    const result = await native(writerArgs, Buffer.from(['W', b64(target), b64(userName), kind, b64(payload)].join(' ') + '\n'), false, 'writer write')
    targets.set(target, result.exited)
    executions.push(result.pid)
    assert.equal(result.exited && clean(result) && result.stdout.length === 0, true, 'fixture write')
    return { target, userName }
  }

  let primary
  try {
    for (const [key, type, value] of [
      ['OutputDirectory', 'REG_SZ', transcriptDir], ['EnableInvocationHeader', 'REG_DWORD', '1'], ['EnableTranscripting', 'REG_DWORD', '1'],
    ]) {
      const result = await registryCommand('add', policy, '/v', key, '/t', type, '/d', value, '/f')
      assert.equal(result.code === 0, true, 'enable PowerShell transcription')
      policyKeys.push(key)
    }
    const probe = await raw('probe', '', true)
    assert.equal(clean(probe) && probe.stdout.length === 0, true, 'probe emits no bytes')
    const validator = await native(encodedArgs(windowsScript(readerSource + recordHarness, '[ReaderChecks]::Run()')))
    assert.equal(clean(validator) && validator.stdout.length === 0, true, 'same C# parser and validator on synthetic records')

    const oldTemp = process.env.TEMP, oldTmp = process.env.TMP
    try {
      process.env.TEMP = process.env.TMP = join(dir, 'redirected-parent-temp')
      await privateScratch(async cwd => {
        const expected = { ...environment(cwd) }
        for (const key of ['HOMEDRIVE', 'HOMEPATH', 'LOGONSERVER', 'SYSTEMDRIVE', 'USERDOMAIN', 'USERNAME', 'USERPROFILE', 'NODE_V8_COVERAGE']) {
          if (process.env[key] !== undefined) expected[key] = process.env[key]
        }
        const frame = Object.entries(expected).map(([key, value]) => key + ' ' + b64(value) + '\n').join('')
        const result = await invokeFixture(powershell, encodedArgs(windowsScript(envHarness, '[EnvCheck]::Run()')),
          { cwd, env: environment(cwd), stdin: Buffer.from(frame) })
        const seen = result.stdout.toString().trim()
        assert.equal(clean(result) && seen === 'environment matches', true, 'child env values: ' + (/^[\w ()]*$/.test(seen) ? seen : 'unreadable'))
      })
    } finally {
      if (oldTemp === undefined) delete process.env.TEMP
      else process.env.TEMP = oldTemp
      if (oldTmp === undefined) delete process.env.TMP
      else process.env.TMP = oldTmp
    }

    const value = '\uFEFF' + randomUUID() + ' ç🌍  '
    const { target, userName } = await write(value)
    const variant = target.toUpperCase()
    markers.push(Buffer.from(variant))
    const valueFrame = await raw('read', variant, true)
    const metaFrame = await raw('meta', variant)
    assert.equal(clean(valueFrame) && valueFrame.stdout.equals(output('V', Buffer.from(value, 'utf16le'))), true, 'raw UTF-16LE frame from writer bytes')
    assert.equal(clean(metaFrame) && metaFrame.stdout.equals(output('M', Buffer.from(userName))), true, 'raw metadata frame')
    assert.equal((await adapter.preflight({}, () => true)).ok, true, 'adapter probe')
    assert.equal(adapter.unlock().ok, true, 'adapter gate')
    const picker = await adapter.listItems({ connection, target: variant })
    const row = picker.items?.[0]
    assert.equal(picker.ok && picker.items.length === 1 && row.id === variant && row.target === variant
      && row.userName === userName && row.fields.length === 1 && row.fields[0] === 'password'
      && Object.keys(row).length === 4, true, 'metadata only and request spelling: ' + (picker.ok ? 'row differs' : picker.code))
    assert.equal((await adapter.read(ref(variant))).value === value, true, 'adapter reads the writer’s UTF-16LE bytes')

    const missing = target + '-missing'
    markers.push(Buffer.from(missing))
    const absent = await adapter.read(ref(missing))
    assert.equal(!absent.ok && absent.code === 'revoked' && absent.audit === 'refused', true)
    const odd = await write(Buffer.from([0xff]), { kind: 'raw' })
    const empty = await write(Buffer.alloc(0), { kind: 'raw', userName: '' })
    const largeValue = randomUUID().repeat(36).slice(0, 1280).padEnd(1280, ' ')
    const large = await write(largeValue)
    assert.equal((await adapter.read(ref(odd.target))).code, 'field')
    assert.equal((await adapter.read(ref(empty.target))).code, 'field')
    assert.equal((await adapter.read(ref(large.target))).value === largeValue, true, '2560-byte blob')

    const missingRaw = await raw('meta', missing)
    assert.equal(missingRaw.code === 10 && missingRaw.stdout.length === 0 && missingRaw.stderr.length === 0, true, 'clean missing-target frame')
  } catch (error) {
    primary = error
  }
  // Cleanup and privacy checks run after a failure too, but never hide the failure that stopped the run.
  const failures = []
  const check = async work => { try { await work() } catch (error) { failures.push(error) } }
  let tidy = false
  await check(async () => {
    tidy = (await adapter.prepareQuit()).ok
    tidy = (await cleanupTargets(targets, {
      async remove(target) {
        const result = await native(writerArgs, Buffer.from('D ' + b64(target) + '\n'), false, 'writer delete')
        executions.push(result.pid)
        return clean(result) && result.stdout.length === 0
      },
      async absent(target) {
        const result = await raw('meta', target)
        return result.code === 10 && result.stdout.length === 0 && result.stderr.length === 0
      },
    })) && tidy
  })
  await check(async () => {
    if (executions.length === 0) return
    await checkTranscripts(transcriptDir, executions, privateNeedles())
    assert.equal(scratch.size, 0, 'each invocation directory was inspected and removed')
    assert.equal(scratchError, false, 'compiler scratch inspection completed')
    assert.equal(privateScratchBytes, false, 'private bytes in compiler scratch')
    // Coverage holds only for a run that reached every operation.
    if (primary !== undefined) return
    assert.equal(inspectedFiles > 0, true, 'compiler files inspected before deletion')
    assert.equal(sensitiveScratch.some(({ operation }) => operation === 'reader read'), true, 'raw read scratch tracked')
    assert.equal(sensitiveScratch.some(({ operation }) => operation === 'adapter read'), true, 'adapter read scratch tracked')
    assert.equal(sensitiveScratch.some(({ operation }) => operation === 'writer write'), true, 'writer scratch tracked')
    for (const { operation, evidence } of sensitiveScratch) {
      assert.equal(evidence.inspected > 0, true, `nonempty compiler files inspected for ${operation}`)
      assert.equal(evidence.incomplete, false, `missing or unreadable compiler files for ${operation}`)
    }
  })
  for (const key of policyKeys.reverse()) {
    const result = await registryCommand('delete', policy, '/v', key, '/f').catch(() => ({}))
    tidy = result.code === 0 && tidy
  }
  for (const { watcher } of scratch.values()) watcher.close()
  await rm(dir, { force: true, recursive: true })
  await check(() => assert.equal(tidy, true, 'all known writers exited and registered generic targets were cleaned up'))
  const errors = [primary, ...failures].filter(error => error !== undefined)
  if (errors.length === 1) throw errors[0]
  if (errors.length > 1) throw new AggregateError(errors, errors.map(error => error.message).join(' | '))
})
