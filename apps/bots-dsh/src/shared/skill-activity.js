export const SKILL_ACTIVITY = 'skill-activity'
export const SKILL_ACTIVITY_RECORD = 'plugin:automagik/skill-activity'

export function skillActivityOf(event) {
  if (event?.type !== SKILL_ACTIVITY_RECORD || event.ignorable !== true) return
  const { name, id, turn, step, roomId, eventSeq } = event.data ?? {}
  if (typeof id !== 'string' || typeof name !== 'string' || name.length > 32 || !/^[a-z](?:[a-z0-9]|-(?=[a-z0-9]))*$/.test(name)) return
  if (eventSeq !== undefined) {
    if (!Number.isSafeInteger(eventSeq) || eventSeq < 0 || eventSeq >= event.seq ||
        turn !== undefined || step !== undefined || roomId !== undefined) return
    return { kind: SKILL_ACTIVITY, name, seq: event.seq, time: event.time }
  }
  if (!Number.isSafeInteger(turn) || !Number.isSafeInteger(step) || turn < 0 || step < 0) return
  return { kind: SKILL_ACTIVITY, name, seq: event.seq, time: event.time, turn, step,
    ...(typeof roomId === 'string' && { roomId }) }
}
