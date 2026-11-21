// The copy check: every pt-BR text of the pack, against its English text and the copy rules.
// - `omni-ui` is the Bot team's (apps/bots-dsh): its keys are the English text, and each key the
//   pack translates is still one of them. No DSH namespace is carried: DSH's own pt serves them.
// - A text keeps the {placeholders} of its English text.
// - Brazilian Portuguese, gender-neutral: no article before Unfold and no gendered word after it,
//   no gendered word for the person, "clique" and never "toque", never "sandbox", and no European
//   Portuguese.
//
//   node scripts/copy-check.mjs     checks src/client/locales/pt-BR
//
// Exits 1 with one line per finding.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { FOLDER, loadDictionaries } from './dictionaries.mjs'

const OMNI_UI = 'omni-ui'
const PLACEHOLDER = /\{(\w+)\}/g
const ARTICLE = '(?:o|a|os|as|do|da|dos|das|no|na|nos|nas|ao|à|aos|às|pelo|pela|num|numa|dum|duma|um|uma)'

export const RULES = [
  ['puts an article before Unfold', new RegExp(`(?<![\\p{L}-])${ARTICLE}\\s+Unfold\\b`, 'iu')],
  ['genders Unfold', /\bUnfold\s+(?:está|estava|esteve|ficou|fica|foi|é|era|será|estará)\s+(?:pront|conectad|desconectad|ocupad|sozinh|ligad|desligad|atualizad|parad|preparad|cansad)[oa]s?\b/iu],
  ['uses a gendered pronoun', /(?<![\p{L}-])(?:ele|ela|eles|elas|dele|dela|deles|delas|nele|nela|neles|nelas)(?![\p{L}-])/iu],
  ['uses a gendered word for the person', /(?<![\p{L}-])(?:bem-vind[oa]s?|obrigad[oa]s?|usuári[oa]s?)(?![\p{L}-])|(?<![\p{L}-])(?:você|vocês)\s+(?:está|estão|esteja|estejam|estiver|é|são|seja|sejam|foi|foram|fica|ficou|ficará|será)\s+(?:\p{L}+(?:ad|id)[oa]s?|pront[oa]s?|cert[oa]s?|segur[oa]s?|sozinh[oa]s?|atent[oa]s?)(?![\p{L}-])|\p{L}(?:o\(a\)|a\(o\)|os\(as\)|o\/a|a\/o)(?![\p{L}-])|(?<![\p{L}-])(?:tod[xe@]s|amig[xe@]s)(?![\p{L}-])/iu],
  ['says tap', /(?<![\p{L}-])(?:tap|taps|tapped|toque|toques|tocar|tocou)(?![\p{L}-])/iu],
  ['says sandbox', /sandbox/iu],
  ['is European Portuguese', new RegExp([
    // words only Portugal uses: Brazil says tela, usuário, arquivo, celular, registro, equipe, senha,
    // seção, contato, fato, atual, acessar, compartilhar, pressionar
    '(?<![\\p{L}-])(?:ecrã|ecrãs|utilizador|utilizadores|ficheiro|ficheiros|telemóvel|registo|registos|equipa|equipas|palavra-passe|secção|contacto|contactos|facto|actual|actualizar'
      + '|aceder|acede|acedido|acedida|partilh\\p{L}*|premir)(?![\\p{L}-])',
    // the progressive "está a fazer", and a status line "A carregar…" ("A seguir…", "A partir…" are Brazilian)
    '(?<![\\p{L}-])(?:está|estão|estou|estamos|esteja|estava|estavam)\\s+a\\s+\\p{L}+(?:ar|er|ir)(?![\\p{L}-])',
    '^\\s*a\\s+(?!(?:partir|seguir)(?![\\p{L}-]))\\p{L}+(?:ar|er|ir)\\s*(?:…|\\.\\.\\.)',
  ].join('|'), 'iu')],
  // "click on" as Portugal says it: "carregue em/no" followed by what is clicked (a name or a control);
  // "carregue em segundo plano" is Brazilian. Case matters here, so it is a rule of its own.
  ['is European Portuguese', /(?<![\p{L}-])[Cc]arregu(?:e|em)\s+(?:em|no|na|nos|nas)\s+(?:[\p{Lu}"“«]|(?:botão|botões|ícone|tecla|link|menu|opção)(?![\p{L}-]))/u],
]

// Plugins that add their own words to the Bot team's omni-ui namespace (its addStrings), from
// outside this repository: a recorded list of the keys each adds (the English text), under
// test/fixtures/. Unfold's session plugin left with the Unfold plugins (RFC 0020); its keys were
// recorded at the hand-over commit.
export const OMNI_PLUGIN_STRINGS = [
  '../test/fixtures/unfold-session-strings.json',
  '../test/fixtures/omni-channels-history-strings.json',
]

// The omni-ui keys: the Bot team's (its locale hook registers them as the zh dictionary's keys),
// then those the plugins above add to the same namespace.
export async function omniKeys() {
  const { installLocale } = await import('../../bots-dsh/src/client/i18n.js')
  let keys = new Set()
  const off = installLocale({ register: (_ns, _locale, dict) => { keys = new Set(Object.keys(dict)); return () => {} }, bind: () => (key) => key })
  off()
  for (const path of OMNI_PLUGIN_STRINGS) {
    for (const key of JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8')).keys) keys.add(key)
  }
  return keys
}

const placeholders = (text) => [...text.matchAll(PLACEHOLDER)].map((match) => match[1]).sort().join(',')

export async function checkCopy({ folder = FOLDER, reference, omni } = {}) {
  const findings = []
  const english = reference ? JSON.parse(readFileSync(reference, 'utf8')) : {}
  const known = omni ?? await omniKeys()
  for (const [ns, dict] of Object.entries(loadDictionaries(folder))) {
    const source = ns === OMNI_UI ? null : english[ns]
    if (ns !== OMNI_UI && !source) {
      findings.push(`${ns}: not a DSH namespace in ${reference ?? 'the reference'}`)
      continue
    }
    for (const [key, text] of Object.entries(dict)) {
      const en = source ? source[key] : (known.has(key) ? key : undefined)
      if (en === undefined) findings.push(`${ns}:${key}: not an en key`)
      // Only a text that is blank in English too (a separator, an empty prefix) may be blank.
      if (typeof text !== 'string' || (text.trim() === '' && (en === undefined || en.trim() !== ''))) {
        findings.push(`${ns}:${key}: empty or not text`)
        continue
      }
      if (en !== undefined && placeholders(en) !== placeholders(text)) findings.push(`${ns}:${key}: drops or adds a placeholder ("${text}")`)
      for (const [rule, pattern] of RULES) {
        const hit = text.match(pattern)
        if (hit) findings.push(`${ns}:${key}: ${rule} ("${hit[0]}" in "${text}")`)
      }
    }
  }
  return findings
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const findings = await checkCopy()
  for (const line of findings) console.error(`copy-check: ${line}`)
  process.exit(findings.length > 0 ? 1 : 0)
}
