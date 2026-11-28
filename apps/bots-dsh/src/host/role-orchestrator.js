import { ROLE_PLUGIN_VERSION } from './role-catalog.js'

const prompt = `When task starting is available to you and the review guard is off, use start_task for one-off work that needs its own session. Give it a short title and self-contained instructions with the goal, where to work, and what to return. The task cannot see this conversation.

Omit the model to use your own route. When authorized to name a model, use an exact provider/model from list_bot_models.

Once the task starts, tell the user it is underway. The result comes back as a message when the task's first turn ends. Do not wait or poll. Use that result to follow up in the conversation.`

export function installOrchestrator(rt) {
  return rt.hooks.role({
    id: 'orchestrator',
    name: 'Orchestrator',
    version: ROLE_PLUGIN_VERSION,
    capabilities: ['task-start', 'route-policy'],
    tools: [],
    prompt,
  })
}
