// Record the Main Bot's automatic authorisation for this specific picture forward.
import { randomUUID } from 'node:crypto'
import { refusal } from './refusal.js'

export function install(rt) {
  async function approvePictureForward(exec, { sender, target, images }) {
    const main = Object.values(rt.state.bots).find(bot => rt.isMain(bot.id))
    if (!main) throw refusal('Not sent: there is no Main Bot to authorise this private picture forward.')
    exec.signal?.throwIfAborted()
    const book = `pair-${[sender.id, target.id].sort().join('-')}`
    rt.ledger.append(book, {
      event: 'picture-forward-authorised', id: randomUUID(), time: Date.now(),
      by: main.id, from: sender.id, to: target.id,
      images: images.map(ref => ref.attachmentId), automatic: true,
    })
    await rt.ledger.written(book)
  }
  Object.assign(rt, { approvePictureForward })
}
