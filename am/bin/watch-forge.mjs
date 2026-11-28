// Read-only forge queries for am watch. GraphQL batches PRs and activity without prose.
import { forgeHost } from "../workers.js";

const WATCH_RUNS = 20;
const CI_STEP = /(?:^|[^a-z0-9])(?:build(?:ing)?|tests?|testing)(?:$|[^a-z0-9])/i;
const AUXILIARY = /^(?:upload|download|publish|report|collect|cache|restore|setup|set up)\b/i;
const buildOrTest = (name) => typeof name === "string" && !AUXILIARY.test(name.trim())
  && CI_STEP.test(name);
const positive = (value) => Number.isSafeInteger(value) && value > 0;
const date = (value) => Date.parse(value) || 0;
const shaOf = (value) => /^[0-9a-f]{40,64}$/.test(value ?? "") ? value : null;
const nodes = (connection) =>
  Array.isArray(connection?.nodes) ? connection.nodes.filter(Boolean) : [];
const literal = JSON.stringify;

export function watchRepository(tool, remote) {
  const host = forgeHost(remote);
  if (!tool || !host || !/^[a-z0-9.-]+$/i.test(host)) return null;
  let path;
  try { path = new URL(remote).pathname; } catch { path = remote.split(/:(.*)/s)[1]; }
  path = path?.replace(/^\/+|\/+$/g, "").replace(/\.git$/, "");
  const parts = path?.split("/");
  if (!parts || (tool === "gh" ? parts.length !== 2 : parts.length < 2)
      || parts.some((part) => !/^[a-z0-9_.-]+$/i.test(part) || /^\.{1,2}$/.test(part))) return null;
  return { tool, host, path, base: `https://${host}/${path}`, github: tool === "gh" };
}

function rateLimit(headers, status, result, data, now) {
  const failure = result.code !== 0 || data?.errors?.length;
  const text = failure ? `${result.stderr}\n${literal(data?.errors ?? data)}` : "";
  const limited = /HTTP 429|rate.limit(ed|[ _-](?:exceeded|reached))|too many requests/i;
  const remaining = headers["x-ratelimit-remaining"] ?? headers["ratelimit-remaining"];
  if (status !== 429 && remaining !== "0" && !limited.test(text)) return 0;
  const reset = Number(headers["x-ratelimit-reset"] ?? headers["ratelimit-reset"]) * 1000;
  const retry = headers["retry-after"];
  const until = Math.max(reset || 0, Number(retry) * 1000 + now || date(retry));
  return until > now ? Math.min(until, now + 86_400_000) : now + 15 * 60_000;
}

export function watchApi(repo, exec, state, now, out) {
  return async (endpoint, query) => {
    if (state.rateLimitUntil > now) return null;
    out.forgeCalls++;
    const result = await exec(["api", endpoint, "--hostname", repo.host, "--include",
      ...(query ? ["--method", "POST", "-f", `query=${query}`] : ["--method", "GET"])]);
    const [head, ...tail] = result.stdout.trim().split(/\r?\n\r?\n/);
    const status = Number(/^HTTP\/\S+\s+(\d+)/.exec(head)?.[1]);
    const headers = Object.fromEntries([...head.matchAll(/^([\w-]+):[ \t]*(.+)$/gm)]
      .map(([, key, value]) => [key.toLowerCase(), value.trim()]));
    let data;
    try { data = JSON.parse(status ? tail.join("\n\n") : result.stdout); } catch {}
    const until = rateLimit(headers, status, result, data, now);
    if (until) state.rateLimitUntil = until;
    if (result.code !== 0 || !data || data.errors?.length) {
      // GitHub can return data for other aliases when an explicitly followed number is missing.
      const missing = Array.isArray(data?.errors) && data.errors.length
        && data.errors.every((error) =>
          error.type === "NOT_FOUND" && /^p\d+$/.test(error.path?.at(-1) ?? ""));
      if (!missing) {
        if (!until) out.forgeUnavailable = true;
        return null;
      }
    }
    return data;
  };
}

const PAGE = "pageInfo { hasNextPage endCursor }";
const GH_FIELDS = `
  number state createdAt closedAt mergedAt headRefName headRefOid isCrossRepository mergeable
  author { login }
  commits(last:1) { nodes { commit { oid statusCheckRollup { state
    contexts(first:1) {
      checkRunCountsByState { state count } statusContextCountsByState { state count }
    }
  } } } }
  reviews(last:30, states:[APPROVED, CHANGES_REQUESTED, COMMENTED, DISMISSED]) {
    nodes { id submittedAt author { login } }
  }
  comments(last:30) { nodes { id createdAt author { login } } }
`;
const GL_FIELDS = `
  iid state createdAt closedAt mergedAt sourceBranch diffHeadSha detailedMergeStatus
  sourceProject { fullPath } author { username } headPipeline { status }
  notes(last:20, filter:ONLY_COMMENTS) { nodes { id createdAt author { username } } }
  approvedBy(first:20) { nodes { id username } }
  changeRequesters(first:20) { nodes { id username } }
`;
const GH_BRANCH_FIELDS = "number state createdAt closedAt mergedAt headRefName isCrossRepository";
const GL_RUN_FIELDS = "id createdAt updatedAt status";

const chunks = (values, size) => Array.from({ length: Math.ceil(values.length / size) },
  (_, i) => values.slice(i * size, (i + 1) * size));

function githubReads(repo, branches, numbers, after, first) {
  const [owner, name] = repo.path.split("/").map(literal);
  const open = after || first ? `open:pullRequests(first:50, states:OPEN
    ${after ? `,after:${literal(after)}` : ""}) { ${PAGE} nodes { ${GH_FIELDS} } }` : "";
  const watched = numbers.map((n) => `p${n}:pullRequest(number:${n}) { ${GH_FIELDS} }`);
  const workers = branches.map((branch, i) => `
    w${i}:pullRequests(first:1, headRefName:${literal(branch)},orderBy:{
      field:CREATED_AT,direction:DESC
    }) { nodes { ${GH_BRANCH_FIELDS} } }`);
  return `query Watch { viewer { login } repo:repository(owner:${owner},name:${name}) {
    defaultBranchRef { name } ${open} ${watched.join(" ")} ${workers.join(" ")}
  } }`;
}

function gitlabReads(repo, branches, numbers, after, first, branch) {
  const open = after || first ? `open:mergeRequests(first:10, state:opened
    ${after ? `,after:${literal(after)}` : ""}) { ${PAGE} nodes { ${GL_FIELDS} } }` : "";
  const known = numbers.length ? `known:mergeRequests(first:${numbers.length},
    iids:${literal(numbers.map(String))}) { nodes { ${GL_FIELDS} } }` : "";
  const workers = branches.length ? `workers:mergeRequests(first:100,
    sourceBranches:${literal(branches)}) { nodes {
      iid state createdAt closedAt mergedAt sourceBranch sourceProject { fullPath }
    } }` : "";
  const ci = first && branch ? gitlabRunsQuery(branch) : "";
  return `query Watch { currentUser { username } repo:project(fullPath:${literal(repo.path)}) {
    repository { rootRef } ${open} ${known} ${workers} ${ci}
  } }`;
}

const gitlabRunsQuery = (branch) =>
  `runs:pipelines(first:${WATCH_RUNS},ref:${literal(branch)}) { nodes { ${GL_RUN_FIELDS} } }`;

function normalizeChecks(item, github, sha) {
  if (!sha) return null;
  if (!github) {
    const pipeline = item.headPipeline;
    if (!pipeline) return "pending";
    // A merged-result pipeline runs on a synthetic SHA. GitLab already resolves headPipeline
    // to the latest pipeline of the MR, including merged-result pipelines.
    return ({ SUCCESS: "green", FAILED: "red" })[pipeline.status] ?? "pending";
  }
  const commit = nodes(item.commits)[0]?.commit;
  if (commit?.oid !== sha) return null;
  const rollup = commit.statusCheckRollup;
  const waiting = /^(PENDING|EXPECTED|REQUESTED|WAITING|QUEUED|IN_PROGRESS)$/;
  const counts = [...(rollup?.contexts?.checkRunCountsByState ?? []),
    ...(rollup?.contexts?.statusContextCountsByState ?? [])];
  if (counts.some(({ state, count }) => count > 0 && waiting.test(state))) return "pending";
  if (rollup?.state === "SUCCESS") return "green";
  return ["ERROR", "FAILURE"].includes(rollup?.state) ? "red" : "pending";
}

function activity(connection, author, timeKey) {
  return nodes(connection).flatMap((item) => {
    const by = item.author?.login ?? item.author?.username;
    const time = date(item[timeKey]);
    if (!by || by === author || !time || typeof item.id !== "string") return [];
    return [{ id: item.id, time }];
  });
}

function projectPr(item, repo, normalizedPr, full) {
  const gh = repo.github;
  const pr = normalizedPr(gh ? item : { ...item, iid: Number(item.iid), sha: item.diffHeadSha });
  if (!pr || !positive(pr.number)) return null;
  const author = item.author?.login ?? item.author?.username;
  const sha = shaOf(pr.headRefOid);
  const match = gh ? item.isCrossRepository === false : item.sourceProject?.fullPath === repo.path;
  const branch = item.headRefName ?? item.sourceBranch;
  const merge = item.mergeable ?? item.detailedMergeStatus;
  return { number: pr.number, state: pr.state, sha, author, branch, match, full,
    created: date(pr.createdAt), closed: date(pr.mergedAt ?? pr.closedAt),
    checks: normalizeChecks(item, gh, sha),
    merge: ["CONFLICTING", "CONFLICT"].includes(merge) ? "conflicting"
      : ["MERGEABLE", "MERGEABLE_WITH_WARNINGS"].includes(merge) ? "mergeable" : null,
    reviews: activity(item.reviews, author, "submittedAt"),
    comments: activity(item.comments ?? item.notes, author, "createdAt"),
    approvals: ["approvedBy", "changeRequesters"].flatMap((key) =>
      nodes(item[key]).filter((user) => user.username && user.username !== author)
        .map(({ id }) => `${key}:${id}`)),
  };
}

/** Read one batched page in the usual case. Larger rosters and PR lists use bounded pages. */
export async function watchPullRequests(repo, api, normalizedPr, options) {
  const { branches, recent, tracked, followed, branch } = options;
  const numbers = [...new Set([...followed, ...tracked])];
  const gh = repo.github;
  const makeQuery = gh ? githubReads : gitlabReads;
  const n = chunks(numbers, gh ? 60 : 10);
  const b = chunks([...recent], gh ? 40 : 25);
  const result = new Map();
  let after, login, defaultBranch, pipelines;
  const pages = Math.max(n.length, b.length, 1);
  for (let i = 0; i < pages || after; i++) {
    const query = makeQuery(repo, b[i] ?? [], n[i] ?? [], after, i === 0, branch);
    const response = await api("graphql", query);
    const data = response?.data?.repo;
    if (!data) return null;
    login ??= response.data.viewer?.login ?? response.data.currentUser?.username;
    defaultBranch ??= data.defaultBranchRef?.name ?? data.repository?.rootRef;
    pipelines ??= data.runs;
    const add = (item, full) => {
      const pr = projectPr(item, repo, normalizedPr, full);
      if (pr && (full || !result.has(pr.number))) result.set(pr.number, pr);
    };
    for (const [key, entry] of Object.entries(data)) {
      if (key === "open" || key === "known") nodes(entry).forEach((item) => add(item, true));
      else if (/^p\d+$/.test(key) && entry) add(entry, true);
      else if (key === "workers" || /^w\d+$/.test(key)) {
        nodes(entry).forEach((item) => add(item, false));
      }
    }
    const next = data.open?.pageInfo;
    if (next?.hasNextPage && (!next.endCursor || next.endCursor === after || i >= 99)) return null;
    after = next?.hasNextPage ? next.endCursor : null;
  }
  const explicit = new Set(followed);
  const known = new Set(tracked);
  const prs = [...result.values()].filter((pr) => explicit.has(pr.number)
    || (pr.match && branches.has(pr.branch))
    || (pr.state === "OPEN" ? login && login === pr.author : known.has(pr.number)));
  return { prs, branch: defaultBranch, pipelines: defaultBranch === branch ? pipelines : null };
}

export async function watchRuns(repo, api, { branch, pipelines }) {
  if (!branch) return [];
  let list;
  if (repo.github) {
    const query = new URLSearchParams({ branch, exclude_pull_requests: "true",
      per_page: WATCH_RUNS });
    const data = await api(`repos/${repo.path}/actions/runs?${query}`);
    list = data?.workflow_runs;
  } else {
    if (!pipelines) {
      const query = `query WatchRuns {
        repo:project(fullPath:${literal(repo.path)}) { ${gitlabRunsQuery(branch)} }
      }`;
      const data = await api("graphql", query);
      pipelines = data?.data?.repo?.runs;
    }
    list = pipelines?.nodes;
  }
  if (!Array.isArray(list)) return null;
  return list.flatMap((run) => {
    const id = repo.github ? run.id : Number(/\/(\d+)$/.exec(run.id)?.[1]);
    const attempt = repo.github && positive(run.run_attempt) ? run.run_attempt : 1;
    const created = date(run.run_started_at ?? run.created_at ?? run.createdAt);
    const finished = date(run.updated_at ?? run.updatedAt);
    if (!positive(id) || !created) return [];
    const state = repo.github ? (run.status === "completed" ? run.conclusion : null)
      : { SUCCESS: "success", FAILED: "failure" }[run.status];
    const result = state === "success" ? "green" : state === "failure" ? "red" : null;
    const key = `${id}:${repo.github ? attempt : finished}`;
    return [{ id, attempt, created, result, key }];
  }).sort((a, b) => b.created - a.created || b.id - a.id);
}

export async function watchBuildFailed(repo, api, run) {
  for (let page = 1; page <= 10; page++) {
    const endpoint = repo.github
      ? `repos/${repo.path}/actions/runs/${run.id}/attempts/${run.attempt}/jobs`
      : `projects/${encodeURIComponent(repo.path)}/pipelines/${run.id}/jobs`;
    const data = await api(`${endpoint}?per_page=100&page=${page}`);
    const jobs = repo.github ? data?.jobs : data;
    if (!Array.isArray(jobs)) return null;
    if (repo.github ? jobs.some((job) => job.steps?.some((step) =>
      step.conclusion === "failure" && buildOrTest(step.name)))
      : jobs.some((job) => job.status === "failed" && !job.allow_failure
        && (buildOrTest(job.stage) || buildOrTest(job.name)))) return true;
    if (jobs.length < 100) return false;
  }
  return null;
}
