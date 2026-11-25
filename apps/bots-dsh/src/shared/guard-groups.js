const WAY_OUT = '{name} from its groups (for a group of two, delete the group or add another Bot first), then turn the guard on'

export const GUARD_GROUP_COPY = {
  join: "{name} has the review guard on, so it cannot join a group. To add it, turn the review guard off in {name}'s Details first.",
  inGroup: `{name} is in a group ({groups}), so its review guard cannot be turned on. Remove ${WAY_OUT}.`,
  off: `The review guard of {name} was turned off because {name} is in a group, and a Bot with the guard on cannot be in one. To turn it back on, remove ${WAY_OUT} in its Details.`,
  more: '{groups} and {count} more',
}

const PT = {
  join: '{name} está com a trava de revisão ligada e, por isso, não pode entrar em um grupo. Para adicionar ao grupo, primeiro desligue a trava de revisão em Detalhes de {name}.',
  inGroup: '{name} está em um grupo ({groups}) e, por isso, a trava de revisão não pode ser ligada. Remova {name} dos grupos (em um grupo de dois, exclua o grupo ou adicione outro Bot primeiro) e depois ligue a trava.',
  off: 'A trava de revisão de {name} foi desligada porque {name} está em um grupo, e um Bot com a trava ligada não pode participar de grupos. Para ligar a trava de novo, remova {name} dos grupos (em um grupo de dois, exclua o grupo ou adicione outro Bot primeiro) e depois ligue a trava em Detalhes.',
  more: '{groups} e mais {count}',
}

const ZH = {
  join: '{name} 的审阅守卫已开启，因此无法加入群组。若要加入群组，请先在 {name} 的详情中关闭审阅守卫。',
  inGroup: '{name} 已加入群组（{groups}），因此无法开启审阅守卫。请将 {name} 移出所在群组（如果群组只有两个 Bot，请先删除群组或添加另一个 Bot），然后开启审阅守卫。',
  off: '{name} 的审阅守卫已关闭，因为 {name} 已加入群组，而开启了守卫的 Bot 无法加入群组。若要重新开启，请将 {name} 移出所在群组（如果群组只有两个 Bot，请先删除群组或添加另一个 Bot），然后在详情中开启审阅守卫。',
  more: '{groups}，另有 {count} 个',
}

export const guardGroupZh = Object.fromEntries(
  Object.entries(GUARD_GROUP_COPY).map(([key, text]) => [text, ZH[key]]),
)

export function guardGroupText(key, args, locale) {
  const language = locale?.toLowerCase().split('-')[0]
  const copy = language === 'pt' ? PT : language === 'zh' ? ZH : GUARD_GROUP_COPY
  return copy[key].replace(/\{(\w+)\}/g, (_, name) => args[name])
}

export const GUARD_OFF_NOTICE = 'review-guard-off'

export function guardOffNoticeOf(bot, sessionId) {
  const notice = bot?.guardOffNotice
  if (notice?.kind !== GUARD_OFF_NOTICE || notice.id !== GUARD_OFF_NOTICE
    || !Number.isFinite(notice.at) || typeof sessionId !== 'string' || notice.sessionId !== sessionId) return
  return notice
}
