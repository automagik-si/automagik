export const SKILL_SOURCE = 'automagik-skill'
export const SKILL_NOTICE = 'automagik-skill-notice'

export const personParts = content => Array.isArray(content)
  ? content.filter(part => part?.automagikSkill?.kind !== SKILL_SOURCE) : []
