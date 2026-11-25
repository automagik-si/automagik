export const SKILL_SOURCE = 'automagik-skill'
export const SKILL_NOTICE = 'automagik-skill-notice'
export const AGY_OFF_SKILLS_NOTICE = 'Skills cannot be loaded in Antigravity with native tools off on this version'
export const SKILL_TOOL = 'load_skill'

export const personParts = content => Array.isArray(content)
  ? content.filter(part => part?.automagikSkill?.kind !== SKILL_SOURCE) : []

// The conversation shows the person's original wording. Only the sanitized text
// is stored in message content, which is also read directly by DSH's title code.
export function chatPersonParts({ content, source }) {
  const original = source?.automagikSkillOriginalText
  if (!original || !Array.isArray(content)) return personParts(content)
  return personParts(content.map((part, index) => part?.type === 'text' && typeof original[index] === 'string'
    ? { ...part, text: original[index] } : part))
}
