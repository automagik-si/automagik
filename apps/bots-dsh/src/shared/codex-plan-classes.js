// The plan classes in acp-dsh's reservation evidence (RFC 0024).
export const CODEX_PLAN_CLASSES = Object.freeze({
  personal: Object.freeze(['free', 'go', 'plus', 'pro', 'prolite', 'promax']),
  workspace: Object.freeze([
    'team', 'business', 'self_serve_business_prolite', 'self_serve_business_usage_based',
    'enterprise', 'ent26', 'enterprise_cbp_automation', 'enterprise_cbp_usage_based',
    'edu', 'edu_plus', 'edu_pro',
  ]),
})

export function codexPlanClass(plan) {
  for (const [group, plans] of Object.entries(CODEX_PLAN_CLASSES)) {
    if (plans.includes(plan)) return group
  }
  return 'unknown'
}
