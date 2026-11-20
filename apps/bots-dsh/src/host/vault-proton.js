// The mapping loader runs with the Vault plugin off too. Keep in step with
// vault-dsh/src/proton-pass/parse.js.
export const protonPass = 'proton-pass'
export const protonCloud = 'Proton Pass is unavailable in Automagik Cloud.'
export const validProtonConnection = connection => connection === undefined || connection === protonPass
export const validProtonItem = item => typeof item === 'string' && item.length === 177
  && /^[A-Za-z0-9_-]{86}==\/[A-Za-z0-9_-]{86}==$/.test(item)
export const PROTON_FIELDS = new Set(['username', 'email', 'password', 'note', 'cardholder_name', 'number',
  'verification_number', 'expiration_date', 'pin', 'ssid', 'private_key'])

export function validProtonToken(token) {
  if (typeof token !== 'string' || token.length !== 113) return false
  const key = /^pst_[!-9;-~]{64}::([A-Za-z0-9_-]{43})$/.exec(token)?.[1]
  if (key === undefined) return false
  const bytes = Buffer.from(key, 'base64url')
  return bytes.length === 32 && bytes.toString('base64url') === key
}

export function protonItems(rows) {
  const items = []
  for (const row of rows.slice(0, 50)) {
    if (!validProtonItem(row?.id) || typeof row.name !== 'string' || row.name.length > 512
      || typeof row.vault !== 'string' || !Array.isArray(row.fields)) continue
    const fields = new Map()
    for (const field of row.fields) {
      if (PROTON_FIELDS.has(field?.id) && typeof field.label === 'string' && field.label) {
        fields.set(field.id, { selector: field.id, label: field.label })
      }
    }
    if (fields.size) items.push({ id: row.id, name: row.name, vault: row.vault, fields: [...fields.values()] })
  }
  return items
}
