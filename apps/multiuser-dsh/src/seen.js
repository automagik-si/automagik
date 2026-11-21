export function createSeen({ max = 1000, now = Date.now } = {}) {
  const people = new Map()
  return {
    record({ issuer, subject, roles }) {
      const key = JSON.stringify([issuer, subject])
      people.delete(key)
      people.set(key, { issuer, subject, roles: Object.freeze([...roles]), lastSeen: now() })
      if (people.size > max) {
        let oldest
        for (const entry of people) {
          if (!oldest || entry[1].lastSeen < oldest[1].lastSeen) oldest = entry
        }
        people.delete(oldest[0])
      }
    },
    list() {
      return Object.freeze([...people.values()].reverse()
        .sort((a, b) => b.lastSeen - a.lastSeen)
        .map(person => Object.freeze({ ...person })))
    },
  }
}
