export const CLAUDE = 'acp-claude/default'
export const AGY = 'acp-antigravity/default'
export const refusedSolverAgent = { ok: false, error: {
  code: 'bot/refused', message: 'Antigravity cannot be a Solver yet. Choose another agent for the Solver.', details: {},
} }

const providers = {
  'acp-claude': 'Claude Code',
  'acp-antigravity': 'Antigravity',
  deepseek: 'DeepSeek',
}

export function serve(ctx, refs) {
  ctx.llm.listProviders = () => [...new Set(refs.map(ref => ref.split('/')[0]))]
    .map(id => ({ id, name: providers[id] }))
  ctx.llm.listModels = async provider => refs.filter(ref => ref.startsWith(provider + '/'))
    .map(ref => ({ id: ref.split('/')[1], name: providers[provider] + ' Fixture' }))
}
