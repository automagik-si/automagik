import { refusal } from './refusal.js'

export const SKILL_KEYS = Object.freeze({
  'skill.name-format': 'Use a capability name with lowercase letters, digits, and single hyphens; connector names are reserved.',
  'skill.name-reserved': 'The name "{name}" is reserved for the /{name} command of the app or an agent. Choose another name.',
  'skill.name-device': 'The name "{name}" is reserved by Windows for a device. Choose another name.',
  'skill.name-taken': 'A capability named {name} already exists. Edit it, or choose another name.',
  'skill.not-found': 'No skill named {name}.',
  'skill.rename': 'The name in SKILL.md must stay {name}; renaming a skill is not possible here.',
  'skill.hash-format': 'This skill version is not valid. Open the skill again.',
  'skill.path': 'A file path in the skill is not allowed: {rule}.',
  'skill.too-large-md': 'The skill is over 64 KiB. Shorten it or move detail to a separate file.',
  'skill.too-large-file': 'A file in the skill is over 1 MiB.',
  'skill.too-large-total': 'The skill is over 5 MiB in all.',
  'skill.too-many-files': 'The skill has more than 256 files.',
  'skill.store-failed': "Could not store the skill's files ({code}). Nothing was saved.",
  'skill.changed-elsewhere': 'This skill changed in another window. Open it again.',
  'skill.preview-expired': 'This preview expired. Preview the skill again.',
  'skill.record-invalid': "This skill's record cannot be read by this version. Delete it, or update the app.",
  'skill.proposal-stale': 'This proposal was made by an older version. It will be proposed again if it still applies.',
})

export function skillRefusal(reason, params) {
  const key = `skill.${reason}`
  const message = SKILL_KEYS[key].replace(/\{(\w+)\}/g, (_, name) => String(params?.[name] ?? ''))
  return refusal(message, { key, params })
}
