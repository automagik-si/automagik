import { accessSync, constants, realpathSync, statSync } from 'node:fs'
import { isAbsolute, sep } from 'node:path'

export const READ_PATH = Object.freeze({ read: 'file_path', read_image: 'file_path', glob: 'path', grep: 'path' })
const SEARCH_FILTER = Object.freeze({ glob: 'pattern', grep: 'include' })
const UP_PATH = /(^|[\\/])\.\.([\\/]|$)/
const UP_FILTER = /(^|[\\/{,])\.\.([\\/},]|$)/
const WINDOWS_PATH = /^[a-zA-Z]:[\\/][^:]*$/

export const BINDING_REFUSAL = 'The Session’s file-tool folder could not be established.'
export const PROVIDER_REFUSAL = 'The Session’s file-tool folder requires a verified local tool and provider.'
export const FOLDER_REFUSAL = 'The Session’s file-tool folder is unavailable.'

function absolutePath(value) {
  return typeof value === 'string' && isAbsolute(value) && !UP_PATH.test(value)
    && (process.platform !== 'win32' || WINDOWS_PATH.test(value))
}

export function readableFolder(path) {
  if (!absolutePath(path)) throw new Error(FOLDER_REFUSAL)
  const real = realpathSync.native(path)
  if (!absolutePath(real) || !statSync(real).isDirectory()) throw new Error(FOLDER_REFUSAL)
  accessSync(real, constants.R_OK | constants.X_OK)
  return real
}

export function scopedArguments(folder, name, args) {
  try {
    if (readableFolder(folder) !== folder) return { reason: FOLDER_REFUSAL }
  } catch {
    return { reason: FOLDER_REFUSAL }
  }
  const reason = `This Session’s file tools read only inside ${JSON.stringify(folder)}. Give an existing absolute path there with no "..".`
  const key = READ_PATH[name]
  const path = args?.[key]
  const filter = Object.hasOwn(SEARCH_FILTER, name) ? args?.[SEARCH_FILTER[name]] : undefined
  if (!absolutePath(path)) return { reason }
  if (filter !== undefined && (typeof filter !== 'string' || isAbsolute(filter) || UP_FILTER.test(filter))) return { reason }

  try {
    const real = realpathSync.native(path)
    if (!absolutePath(real) || (real !== folder && !real.startsWith(folder.endsWith(sep) ? folder : folder + sep))) return { reason }
    const info = statSync(real)
    if (!(info.isFile() || (key === 'path' && info.isDirectory()))) return { reason }
    return { args: { ...args, [key]: real } }
  } catch {
    return { reason }
  }
}
