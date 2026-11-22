export const personKey = ({ issuer, subject }) => JSON.stringify([issuer, subject])
const shortSubject = subject => subject.length <= 16 ? subject : subject.slice(0, 13) + '…'
const issuerLabel = issuer => {
  try { return new URL(issuer).host || issuer } catch { return issuer }
}

export function personLabels(people) {
  const unique = new Map(people.map(person => [personKey(person), person]))
  const short = person => issuerLabel(person.issuer) + ' · ' + shortSubject(person.subject)
  const counts = new Map()
  for (const person of unique.values()) counts.set(short(person), (counts.get(short(person)) ?? 0) + 1)
  return new Map([...unique].map(([key, person]) => [
    key, counts.get(short(person)) > 1 ? issuerLabel(person.issuer) + ' · ' + person.subject : short(person),
  ]))
}

export function availablePeople(seen, allow) {
  const listed = new Set(allow.map(personKey))
  return seen.flatMap(({ roles, issuer, subject }) => {
    if (listed.has(personKey({ issuer, subject })) || roles.includes('owner') || roles.includes('admin')) return []
    const role = roles.includes('member') ? 'member' : roles.includes('guest') ? 'guest' : undefined
    return role ? [{ issuer, subject, role }] : []
  })
}
