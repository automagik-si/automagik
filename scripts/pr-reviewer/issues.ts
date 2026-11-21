/** RFC 0029 D3a part 3: draft review issues and reconcile issue state after a merge. */
import { createHash } from 'node:crypto';
import { loadList, scan } from '../../herdr/scripts/privacy-check.mjs';
import { references } from './rfc-checks';
import { LABELS } from './rules';

type Privacy = (text: string) => string[];
type Held = { action: 'held'; problems: string[] };

type DraftInput = {
  finding: { text: string; path: string; line: number };
  pr: { number: number; headSha: string };
  openIssues: readonly { number: number; title: string; body: string | null }[];
  searchComplete: boolean;
  privacy: Privacy;
};

type IssueDraft =
  | { action: 'comment'; issue: number; body: string }
  | { action: 'open'; title: string; body: string; labels: [typeof LABELS.fromReview]; pmMessage: string }
  | { action: 'wait' }
  | Held;

export function repositoryPrivacy(): Privacy {
  const list = loadList();
  // Diagnostics omit the matched text, which may itself be private.
  return text => scan('pr-reviewer publication', text, list)
    .map(({ line, rule }) => `${rule} on line ${line}`);
}

function normalize(text: string): string {
  return text.normalize('NFC').trim().replace(/\s+/g, ' ').toLowerCase();
}

export function draftIssue({ finding, pr, openIssues, searchComplete, privacy }: DraftInput): IssueDraft {
  if (!searchComplete) return { action: 'wait' };

  const { text, path, line } = finding;
  const hash = createHash('sha256').update(JSON.stringify([normalize(text), path])).digest('hex');
  const marker = `<!-- pr-reviewer:finding:${hash} -->`;
  const location = `PR #${pr.number} at \`${pr.headSha}\`, \`${path}:${line}\`.`;
  const title = Array.from('Review: ' + text.split(/\r\n?|\n/, 1)[0].trim()).slice(0, 80).join('');
  const normalizedTitle = normalize(title);
  const match = openIssues.find(issue => issue.body?.includes(marker))
    ?? openIssues.find(issue => normalize(issue.title) === normalizedTitle);
  if (match) {
    const problems = privacy(location);
    if (problems.length) return { action: 'held', problems };
    return { action: 'comment', issue: match.number, body: location };
  }

  const body = `${marker}\n\n${location}\n\n${text}`;
  const pmMessage = `New issue from PR #${pr.number} — ${title}`;
  const problems = [title, body, pmMessage].flatMap(text => privacy(text));
  if (problems.length) return { action: 'held', problems };
  return { action: 'open', title, body, labels: [LABELS.fromReview], pmMessage };
}

type ClosingInput = {
  repo: string;
  prBody: string;
  baseRef: string;
  defaultBranch: string;
  mergeCommit: string;
  commitMessage: string;
  privacy?: Privacy;
  issues: readonly {
    number: number;
    state: 'open' | 'closed';
    openedByApp: boolean;
    resolvedByMerge: boolean;
  }[];
};

type ClosingAction =
  | { action: 'close' | 'comment'; issue: number; comment: string }
  | { action: 'unknown'; issue: number }
  | Held;

// Closing an issue changes state, so the evidence must be unambiguous: inline code (within one paragraph, even when it
// wraps) becomes word joiners, never spaces, so `Fixes \`x\` #8` or a wrapped code example claims nothing. Fenced
// blocks are left to the shared parser; an unmatched backtick hides nothing.
function neutralizeInlineCode(text: string): string {
  const out: string[] = [];
  let paragraph: string[] = [];
  let fence: string | null = null;
  const flush = () => {
    if (!paragraph.length) return;
    out.push(paragraph.join('\n').replace(/(?<!`)(`+)(?!`)[\s\S]*?(?<!`)\1(?!`)/g,
      match => match.replace(/[^\n]/g, '\u2060')));
    paragraph = [];
  };
  for (const line of text.split('\n')) {
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (fence !== null) {
      out.push(line);
      if (marker && marker[0] === fence[0] && marker.length >= fence.length) fence = null;
    } else if (marker) {
      flush();
      out.push(line);
      fence = marker;
    } else if (!line.trim()) {
      flush();
      out.push(line);
    } else {
      paragraph.push(line);
    }
  }
  flush();
  return out.join('\n');
}

function closingReferences(text: string, repo: string): number[] {
  // End any list at its first issue (GitHub closes only the reference right after a keyword) while keeping Markdown
  // and the issue token intact, so the shared parser can still ignore examples and foreign issues.
  return references(neutralizeInlineCode(text).replace(/#\d+\b/g, '$&.'), repo).closing;
}

export function closingDrift({
  repo, prBody, baseRef, defaultBranch, mergeCommit, commitMessage, privacy = repositoryPrivacy(), issues,
}: ClosingInput): ClosingAction[] {
  const { refs } = references(prBody, repo);
  const closing = baseRef === defaultBranch
    ? [...closingReferences(prBody, repo), ...closingReferences(commitMessage, repo)]
    : [];
  const claimed = new Set(closing);
  const numbers = [...new Set([...closing, ...refs])].sort((a, b) => a - b);
  const byNumber = new Map(issues.map(issue => [issue.number, issue]));
  const actions: ClosingAction[] = [];
  const merge = `Merge \`${mergeCommit}\``;

  for (const number of numbers) {
    const issue = byNumber.get(number);
    if (!issue) {
      actions.push({ action: 'unknown', issue: number });
    } else if (claimed.has(number) && issue.state === 'open') {
      if (issue.openedByApp && issue.resolvedByMerge) {
        actions.push({ action: 'close', issue: number, comment: `${merge} resolved this issue.` });
      } else {
        actions.push({
          action: 'comment', issue: number,
          comment: `${merge} claimed this issue. Please confirm it was resolved and close it if so.`,
        });
      }
    } else if (!claimed.has(number) && issue.state === 'closed') {
      actions.push({
        action: 'comment', issue: number,
        comment: `${merge} referenced this issue. Please check whether it should be reopened.`,
      });
    }
  }
  return actions.map(action => {
    if (!('comment' in action)) return action;
    const problems = privacy(action.comment);
    return problems.length ? { action: 'held', problems } : action;
  });
}
