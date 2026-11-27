// The isolated tests run from exactly the git archive whose entries form their key.
// Whole-repository checks, including privacy and the cross-plugin contracts, use the commit.
import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const isolatedTests = ['accounts-fleet', 'restart', 'revive', 'worker'];
const scope = ['.github', '.gitattributes', 'scripts', 'herdr', 'herdr-layout', 'am', 'apps/acp-dsh', 'package.json', 'bun.lock'];
const isolate = (gate) => isolatedTests.includes(gate);
const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trimEnd();
const out = (name, value) => appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);

// A tree object contains the file modes, contents and paths of the complete test
// checkout. Rebuilding it in the verifier also checks the planner's declared inputs.
export function scopedTree() {
  const dir = mkdtempSync(join(tmpdir(), 'verify-index-'));
  const env = { ...process.env, GIT_INDEX_FILE: join(dir, 'index') };
  try {
    const entries = execFileSync('git', ['ls-tree', '-rz', 'HEAD', '--', ...scope], { maxBuffer: 32 * 1024 * 1024 });
    execFileSync('git', ['update-index', '-z', '--index-info'], { input: entries, env });
    return execFileSync('git', ['write-tree'], { encoding: 'utf8', env }).trim();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export function verificationPlan({ ships, herdr, meter, pocket }, commit, scopedKey) {
  if (ships !== 'yes') return [];
  const gates = ['base', 'am'];
  if (herdr === 'yes') gates.push(...isolatedTests, 'herdr-1', 'herdr-2', 'herdr-3', 'herdr-static');
  if (meter === 'yes') gates.push('meter');
  if (pocket === 'yes') gates.push('pocket');
  return gates.map(gate => ({ gate, key: isolate(gate) ? scopedKey : commit }));
}

export function herdrFiles(files, gate) {
  if (isolate(gate)) return [gate + '.test.mjs'];
  const shard = ['herdr-1', 'herdr-2', 'herdr-3'].indexOf(gate);
  if (shard < 0) throw new Error('unknown Herdr shard: ' + gate);
  return files.filter(file => file.endsWith('.test.mjs') && !isolatedTests.includes(file.slice(0, -'.test.mjs'.length)))
    .sort().filter((_, i) => i % 3 === shard);
}

const run = (cmd, args, cwd) => execFileSync(cmd, args, { cwd, stdio: 'inherit' });

function verify(gate, key) {
  if (['base', 'am', 'meter', 'pocket', 'herdr-static'].includes(gate)) {
    run('bash', ['scripts/release-gates.sh', gate]);
    if (gate === 'herdr-static') {
      run('bash', ['scripts/release-gates.sh', 'herdr-imports']);
      run('bash', ['scripts/release-gates.sh', 'herdr-app']);
    }
    return;
  }
  const files = herdrFiles(readdirSync('herdr/test'), gate).map(file => 'test/' + file);
  if (!files.length) throw new Error('empty verification group: ' + gate);
  if (!isolate(gate)) return run('node', ['--test', ...files], 'herdr');
  const dir = mkdtempSync(join(tmpdir(), 'herdr-verify-'));
  try {
    const archive = join(dir, 'input.tar');
    if (scopedTree() !== key) throw new Error('verification tree differs from plan');
    run('git', ['archive', '--mtime=2000-01-01T00:00:00Z', key, '-o', archive]);
    run('tar', ['-xf', archive, '-C', dir]);
    run('node', ['--test', ...files], join(dir, 'herdr'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export function passed(jobs, jobName, image) {
  return jobs.some(job => job.name === jobName && job.conclusion === 'success' &&
    job.steps.some(step => step.name === 'Verified on ' + image && step.conclusion === 'success'));
}

function previousPass(gate, key, image) {
  if (!isolate(gate) || !image) return false;
  const repo = 'repos/' + process.env.GITHUB_REPOSITORY;
  const api = path => JSON.parse(execFileSync('gh', ['api', repo + path], { encoding: 'utf8' }));
  try {
    // Only the release workflow's own push jobs on dev may vouch for a gate. A reused
    // result never emits the verification step, so references cannot form a chain.
    const runs = api('/actions/workflows/release.yml/runs?branch=dev&event=push&per_page=12').workflow_runs;
    for (const prior of runs) {
      if (String(prior.id) === process.env.GITHUB_RUN_ID || prior.head_repository?.full_name !== process.env.GITHUB_REPOSITORY) continue;
      const { jobs } = api('/actions/runs/' + prior.id + '/jobs?per_page=100');
      if (passed(jobs, 'Preflight / Verify ' + gate + ' ' + key, image)) {
        console.log('Verified in ' + prior.html_url);
        return true;
      }
    }
  } catch {
    console.warn('Could not read prior verification. Running the check.');
  }
  return false;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [operation, gate, key] = process.argv.slice(2);
  if (operation === 'plan') {
    const sha = git('rev-parse', 'HEAD');
    const include = verificationPlan(process.env, sha, process.env.herdr === 'yes' ? scopedTree() : '');
    out('sha', sha);
    out('matrix', JSON.stringify({ include: include.length ? include : [{ gate: 'empty', key: sha }] }));
  } else if (operation === 'lookup') {
    const image = process.env.ImageVersion && [process.env.RUNNER_OS, process.env.RUNNER_ARCH, process.env.ImageVersion].join('-');
    out('reuse', previousPass(gate, key, image));
    out('image', image || 'unknown');
  } else if (operation === 'verify') verify(gate, key);
  else throw new Error('unknown verification command');
}
