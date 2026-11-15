import { WHATSAPP_SIGNUPS_OPEN } from './shared.js'

export const escape = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
// products: a product choice for later. The endpoint and the schema do not take one yet, so no
// page passes any and nothing is rendered; when they do, pass [[value, label], ...] here.
// whatsapp: whether the form offers WhatsApp beside email (WHATSAPP_SIGNUPS_OPEN in shared.js).
export const waitlistIntro = ({ whatsapp = WHATSAPP_SIGNUPS_OPEN } = {}) => `<p>${whatsapp ? 'Choose email or WhatsApp to confirm your interest.' : 'Confirm your interest by email.'} This does not create a Cloud account or promise access. We send no launch or marketing message.</p>`
export function waitlistForm({ products = [], whatsapp = WHATSAPP_SIGNUPS_OPEN } = {}) {
  const language = '<label>Confirmation language<select name="language"><option value="en">English</option><option value="pt-BR">Português</option></select></label>'
  const product = products.length ? `\n    <label>Which product is this about?<select name="product">${products.map(([value, label]) => `<option value="${escape(value)}">${escape(label)}</option>`).join('')}</select></label>` : ''
  return `<form class="waitlist-form" method="post" action="/api/waitlist">
    <input type="hidden" name="action" value="add">${product}
    <label>What would you like to do?<textarea name="goal" required maxlength="1000" rows="3" placeholder="Tell us the work you want your agents to take on."></textarea></label>
    <div class="field-row"><label>Where would you use it?<select name="platform" required><option value="android">Android</option><option value="linux">Linux</option><option value="both">Android and Linux</option></select></label><label>Apps or tools <span class="muted">(optional)</span><input name="apps" maxlength="200" placeholder="The tools involved in your work"></label></div>
    <label>What would a good result look like?<textarea name="expected_result" required maxlength="500" rows="2" placeholder="Describe the outcome you would like."></textarea></label>
    ${whatsapp ? `<div class="field-row"><label>Confirm through<select name="channel" required><option value="email">Email</option><option value="whatsapp">WhatsApp — you send the first message</option></select></label>${language}</div>
    <p class="fine" id="whatsapp-delay">WhatsApp confirmation may take a little while. <span lang="pt-BR">A confirmação pelo WhatsApp pode demorar um pouco.</span></p>
    <label>Your email <span class="muted">(required for email confirmation)</span><input type="email" name="email" autocomplete="email" maxlength="254" placeholder="you@example.com"></label>` : `<input type="hidden" name="channel" value="email">
    <div class="field-row"><label>Your email<input type="email" name="email" autocomplete="email" maxlength="254" required placeholder="you@example.com"></label>${language}</div>`}
    <label class="consent"><input type="checkbox" name="consent" value="yes" required><span>I agree to the use of my contact details and answers to record and review my interest in Automagik Cloud, and to one confirmation through my chosen channel. This does not create an account or sign me up for marketing. <a href="#privacy">Privacy and removal</a>.</span></label>
    <button class="button primary" type="submit">Register my interest <span aria-hidden="true">→</span></button>
    <p class="fine">${whatsapp ? 'Email sends a confirmation link. WhatsApp shows a code for you to send to our support Bot. We never message you first on WhatsApp, and send nothing else.' : 'We send one email with a confirmation link, and nothing else.'}</p>
  </form>`
}
export function supportPrivacy() {
  return `<section lang="en" aria-labelledby="support-whatsapp-en"><h3 id="support-whatsapp-en">Support on WhatsApp</h3><p>When you write to Automagik on WhatsApp, Automagik's support assistant answers, with people from our
team watching and joining in. It only answers you; it never writes first.</p><p>Your conversation is isolated in its own sandbox: the assistant uses only your conversation to answer
you. We keep it so the assistant remembers you; nothing is deleted automatically. Your messages reach
us through Omni, our messaging service, and are processed by the AI model behind the assistant. We do
not sell your data, use it for advertising or send you marketing messages.</p><p>You can download your conversation or reset it at any time: just ask the assistant, or write to
privacy@automagik.si. A waitlist code you send is recorded as confirmed; the waitlist never stores the
text of your message.</p></section><section lang="pt-BR" aria-labelledby="support-whatsapp-pt"><h3 id="support-whatsapp-pt">Suporte pelo WhatsApp</h3><p>Quando você escreve para a Automagik pelo WhatsApp, o assistente de suporte da Automagik responde,
com pessoas da nossa equipe acompanhando e participando. Ele só responde a você; nunca inicia a conversa.</p><p>Sua conversa fica isolada em seu próprio sandbox: o assistente usa apenas a sua conversa para responder
a você. Nós a mantemos para que o assistente se lembre de você; nada é excluído automaticamente.
Suas mensagens chegam até nós pelo Omni, nosso serviço de mensagens, e são processadas pelo modelo
de IA por trás do assistente. Não vendemos seus dados, não os usamos para publicidade e não enviamos
mensagens de marketing.</p><p>Você pode baixar sua conversa ou reiniciá-la a qualquer momento: basta pedir ao assistente ou escrever
para privacy@automagik.si. Um código da lista de espera que você enviar é registrado como confirmado;
a lista de espera nunca armazena o texto da sua mensagem.</p></section>`
}
// Without WhatsApp sign-ups, the WhatsApp sentences describe the sign-ups made before the pause:
// their rows, codes and removal stay as they were.
export function privacyNote({ whatsapp = WHATSAPP_SIGNUPS_OPEN } = {}) {
  return `<details id="privacy" class="privacy"><summary>Privacy, consent and removing your details</summary><div>
    <p>Namastex Labs is the controller. Contact <a href="mailto:privacy@automagik.si">privacy@automagik.si</a> for access or correction.</p>
    <p>We keep your answers, chosen platform, language, contact channel, consent version and registration time. Email confirmation stores your email and confirmation time. ${whatsapp ? 'WhatsApp confirmation stores' : 'New sign-ups confirm by email only. For an earlier sign-up that chose WhatsApp, its confirmation stores'} the sender ID or number WhatsApp gives us, the message identifier, confirmation reply, event time and confirmation time, never your message text or sender name. WhatsApp may give us an opaque sender ID instead of a phone number. Confirmation tokens and codes are stored as hashes.</p>
    <p>Your consent lets us record and review your interest in Cloud. This is not a Cloud account, a purchase, or consent to training. Only the owner can read or export the list. We do not sell it or share it for advertising.</p>
    <p>Cloudflare processes the page and stores the list in a database restricted to the European Union. This involves international transfers. Email confirmation uses Resend and its delivery providers; ${whatsapp ? 'choosing WhatsApp involves WhatsApp/Meta and our Omni. Use email if you prefer not to share your WhatsApp number.' : 'an earlier sign-up that chose WhatsApp involves WhatsApp/Meta and our Omni.'}</p>
    <p>Unconfirmed email entries expire after a day. ${whatsapp ? 'Send a WhatsApp code within half an hour; confirmation' : 'An earlier WhatsApp code counts if it was sent within half an hour of the sign-up; its confirmation'} may be processed up to 180 days after code expiry, using the time your message was received. Pending WhatsApp entries are kept for that backlog window. Entries outside their applicable window are deleted on the next request. Confirmed entries stay until Cloud launches or you remove them; the owner reviews retention every six months. Short-lived keyed abuse counters and email cooldown hashes expire after a day. Raw IPs and user agents are not stored by the function.</p>
    <p>You can request confirmation, access, correction or deletion, withdraw consent, and complain to the ANPD or your EU supervisory authority. Removing your details withdraws consent. There are no cookies or analytics in this page.</p>
    <form class="removal-form" method="post" action="/api/waitlist"><input type="hidden" name="action" value="remove"><label>Contact to remove<select name="channel"><option value="email">Email</option><option value="whatsapp">WhatsApp sender ID or number</option><option value="code">WhatsApp confirmation code</option></select></label><label>Email, WhatsApp sender ID/number or original code<input name="contact" autocomplete="off" maxlength="254" required placeholder="Email, +international number or AMG-code"></label><button class="button secondary" type="submit">Remove my details</button><p class="fine">The response is the same whether or not the contact was registered.</p></form>
    ${supportPrivacy()}
  </div></details>`
}
export function htmlPage(title, content, status = 200) {
  return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex, nofollow"><title>${escape(title)} · Automagik</title><link rel="stylesheet" href="/theme.css"><link rel="stylesheet" href="/styles.css"></head><body><header class="top"><div class="wrap top-inner"><a class="brand" href="/" aria-label="Automagik home"><picture><source media="(prefers-color-scheme: dark)" srcset="/assets/brand/automagik-lockup-three-colours-cream-header.svg"><img src="/assets/brand/automagik-lockup-three-colours-ink-header.svg" width="1632" height="264" alt="Automagik"></picture></a><a href="/cloud/">Cloud</a></div></header><main class="wrap response"><h1>${escape(title)}</h1>${content}</main></body></html>`, { status, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Robots-Tag': 'noindex, nofollow', 'Content-Security-Policy': "default-src 'none'; style-src 'self'; img-src 'self' data:; font-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'" } })
}
export const unavailable = () => htmlPage('Registration is unavailable', '<p>We could not complete your request. Nothing is confirmed. Please try again later.</p><p><a href="/cloud/">Back to Cloud</a></p>', 503)
