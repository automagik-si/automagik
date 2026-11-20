// The mapping loader runs with the Vault plugin off too. Keep this validation in
// step with the reference format in vault-dsh/src/hashicorp-vault/parse.js.
export const hashicorp = 'hashicorp-vault'
export const hashicorpCloud = 'HashiCorp Vault is unavailable in Automagik Cloud.'
export const hashicorpMismatch = 'This mapping belongs to another Vault server; connect to that server or map again.'
export const validHashicorpConnection = value => typeof value === 'string' && /^hv:[a-f0-9]{32}$/.test(value) && value.length === 35
const segments = value => value.split('/').every(part => part !== '' && part !== '.' && part !== '..')
export const validHashicorpMount = value => typeof value === 'string' && /^[A-Za-z0-9_.-][A-Za-z0-9_./-]{0,127}$/.test(value)
  && !/[^A-Za-z0-9_./-]/.test(value) && segments(value)
export const validHashicorpField = value => typeof value === 'string' && value.length >= 1 && value.length <= 128 && !value.includes('\0')
export const validHashicorpPath = (mount, path) => validHashicorpMount(mount) && typeof path === 'string' && path.length <= 400
  && path.isWellFormed() && !path.startsWith('-') && !path.includes('\0') && segments(path) && JSON.stringify([mount, path]).length <= 512

export function hashicorpItem(item) {
  if (typeof item !== 'string' || item.length > 512) return
  try {
    const parts = JSON.parse(item)
    if (Array.isArray(parts) && parts.length === 2 && validHashicorpPath(...parts) && JSON.stringify(parts) === item) return parts
  } catch {}
}

export function hashicorpItems(mount, folder, rows) {
  const items = []
  for (const row of rows.slice(0, 50)) {
    if (!validHashicorpPath(mount, row?.id) || typeof row.folder !== 'boolean') continue
    const name = row.id.split('/').at(-1)
    if (row.id !== (folder === '' ? name : folder + '/' + name) || row.name !== name + (row.folder ? '/' : '')) continue
    items.push({ id: row.id, name: row.name, folder: row.folder })
  }
  return items
}
