/* Automagik ID: the sign-in and allow-access pages. One small same-origin script, no build
   step. It follows apps/id/PAGES-CONTRACT.md: it calls only that contract's endpoints, keeps
   nothing in browser storage, writes nothing to the console and shows only its own words,
   never text or HTML that came back from a failed call. */
(() => {
  'use strict';

  // Never inside a frame: an Allow button must not be clickable through someone else's page.
  if (window.top !== window.self) { document.documentElement.hidden = true; return; }

  // The provider's query exactly as it arrived. It is read here and sent back whole; it is
  // never edited, sorted or rebuilt, and nothing in it is trusted for display.
  const oauthQuery = window.location.search.slice(1);
  const asked = new URLSearchParams(oauthQuery);
  const clientId = asked.get('client_id') || '';
  const prompts = (asked.get('prompt') || '').split(' ').filter(Boolean);
  const hasRequest = oauthQuery !== '';
  const mustCreate = prompts.includes('create');
  const mustBeFresh = prompts.includes('login') || asked.has('max_age');

  // Sign-up is by invitation. Its admission ticket arrives in the fragment (#ticket=…), which no
  // server receives or logs; the page keeps it in memory only, sends it in a header, and takes
  // it out of the address bar at once.
  const TICKET_HEADER = 'X-Automagik-Admission';
  let ticket = '';
  if (document.body.dataset.page === 'sign-in' && window.location.hash) {
    const given = new URLSearchParams(window.location.hash.slice(1)).get('ticket') || '';
    ticket = /^[A-Za-z0-9_.-]{1,4096}$/.test(given) ? given : '';
    window.history.replaceState(null, '', window.location.pathname + window.location.search);
  }

  const T = {
    moment: 'One moment…',
    passkey: 'A passkey is your fingerprint, face or screen lock. No password.',
    prompt: 'Follow the prompt on your device.',
    promptSave: 'Follow the prompt to save your passkey.',
    waiting: 'Waiting for your passkey…',
    checking: 'Checking…',
    cancelled: 'Cancelled. Try again whenever you’re ready.',
    failedUse: 'That passkey didn’t work here. Try again, or create a new one.',
    failedSave: 'The passkey wasn’t saved. Try again.',
    already: 'This device already has your passkey. Use it to continue.',
    cannot: 'This device can’t make a passkey here. Try another one.',
    unsupported: 'This browser can’t use passkeys.',
    unsupportedNote: 'Open this page in an up-to-date Safari, Chrome, Edge or Firefox.',
    unsupportedWhatsApp: 'This browser can’t use passkeys. Use WhatsApp.',
    invite: 'New accounts need an invitation. Open the link from yours.',
    inviteBad: 'That invitation isn’t valid or has run out. Ask for a new one.',
    inviteUsed: 'That invitation was already used. Sign in instead.',
    waInvite: 'This number has no account yet. New accounts need an invitation.',
    saved: 'Passkey saved. You’re in!',
    in: 'You’re in!',
    here: 'You’re already signed in on this browser.',
    again: 'Please sign in again.',
    signedOut: 'Signed out.',
    back: name => `Taking you back to ${name}…`,
    backPlain: 'Taking you back…',
    returned: name => `All set. You can go back to ${name}.`,
    close: 'You can close this page.',
    useWhatsApp: 'Use WhatsApp',
    startAgain: 'Start again',
    waStarting: 'Getting your message ready…',
    waStart: 'Starting…',
    waOpen: 'Open WhatsApp and press send. I’ll wait right here.',
    waScan: 'Scan the code with your phone, then press send in WhatsApp. I’ll wait right here.',
    waStepOpen: 'Open WhatsApp with the button below.',
    waStepScan: 'Scan the code with your phone’s camera.',
    waOpenHere: 'Open WhatsApp on this computer',
    waLeft: time => `Waiting for your message · ${time}`,
    waStill: 'Waiting for your message…',
    waSlow: 'Checking a little slower for a moment.',
    waExpired: 'That code ran out. Start again for a new one.',
    rate: 'Too many tries. Take a short break.',
    tryIn: left => `Try again in ${left} s`,
    offline: 'Can’t reach Automagik. Check your connection.',
    broken: 'Something went wrong on our side.',
    expiredTitle: 'This link has expired',
    expired: 'Let’s start over.',
    expiredNote: 'Go back to the app you came from and start again.',
    trust: name => `${name} never sees your passkey.`,
    allowing: 'Allowing…',
    cancelling: 'Cancelling…',
    allowed: ['Allowed', 'Done!'],
    refused: ['Cancelled', 'No problem.'],
    timedOut: 'Your sign-in timed out.',
    notAllowed: 'This account can’t allow that.',
    notAllowedNote: name => `Go back to ${name} and try another account.`,
    scopes: {
      openid: ['Know it’s you', 'Your Automagik ID'],
      profile: ['See your profile', 'Your name and picture'],
      offline_access: ['Stay connected', 'Keeps working while you’re away'],
    },
    otherScope: 'Other access this app asks for',
    claims: 'Extra details',
  };

  const $ = id => document.getElementById(id);
  const scene = $('scene');
  const pet = $('pet');
  const bubble = $('say');
  const card = $('card');
  let product = '';
  let acting = false;

  // ---- The hosts: who speaks, the face they make and what they say -------------------
  function mood(name) {
    if (scene.dataset.mood === name) return;
    scene.dataset.mood = name;
    pet.classList.remove('start');
    void pet.offsetWidth;
    pet.classList.add('start');
  }
  pet.addEventListener('animationend', () => pet.classList.remove('start'));
  function who(name) { if (scene.dataset.who !== name) scene.dataset.who = name; }
  function say(text, tone) {
    bubble.textContent = text;
    if (tone) bubble.dataset.tone = tone; else delete bubble.dataset.tone;
    bubble.classList.remove('pop');
    void bubble.offsetWidth;
    bubble.classList.add('pop');
  }
  function title(lead, name) {
    $('lead').textContent = lead;
    $('product').textContent = name || '';
    $('product').hidden = !name;
  }
  function show(view, focus) {
    for (const part of card.querySelectorAll('[data-view]')) part.hidden = part.dataset.view !== view;
    card.setAttribute('aria-busy', view === 'loading' ? 'true' : 'false');
    if (focus) focus.focus({ preventScroll: true });
  }

  // ---- Calls: same origin, JSON, cookies the page never reads ------------------------
  function problem(kind, more) { return Object.assign(new Error(kind), { kind }, more); }
  function retryAfter(response) {
    const seconds = Number(response.headers.get('X-Retry-After') || response.headers.get('Retry-After'));
    return Number.isFinite(seconds) && seconds > 0 ? Math.min(Math.ceil(seconds), 3600) : 30;
  }
  async function call(path, body, extra) {
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), 20000);
    let response;
    let text;
    try {
      response = await fetch(path, {
        method: body === undefined ? 'GET' : 'POST',
        credentials: 'include',
        cache: 'no-store',
        redirect: 'manual',
        signal: abort.signal,
        headers: { Accept: 'application/json',
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...extra },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      text = await response.text();
    } catch {
      throw problem('network');
    } finally {
      clearTimeout(timer);
    }
    if (response.status === 429) throw problem('rate', { wait: retryAfter(response) });
    let data = null;
    let readable = true;
    try { data = text ? JSON.parse(text) : null; } catch { readable = false; }
    if (response.ok) {
      if (!readable) throw problem('service');
      return data;
    }
    if (response.status < 400 || response.status >= 500) throw problem('service');
    const code = data && typeof data === 'object' ? String(data.code || data.error || '') : '';
    throw problem('refused', { status: response.status, code });
  }

  // Go where the server says, and only there. The query's own return address is never used.
  function go(url) {
    let target = null;
    try { target = new URL(String(url), window.location.origin); } catch { target = null; }
    if (!target || /^(javascript|data|vbscript|blob|file|about):$/i.test(target.protocol)) {
      throw problem('service');
    }
    window.location.assign(target.href);
    // A desktop app's own page may open elsewhere: do not spin for ever once it has been sent.
    setTimeout(() => {
      const spin = card.querySelector('[data-view="going"]:not([hidden]) .spin');
      if (!spin) return;
      spin.hidden = true;
      mood('idle');
      say(product ? T.returned(product) : T.in);
      $('going-text').textContent = T.close;
    }, 6000);
  }
  function follow(result) {
    if (!result || result.redirect !== true || typeof result.url !== 'string') return false;
    go(result.url);
    return true;
  }

  // The client's name, verified by the service against the signed query.
  async function verifiedName() {
    if (!clientId) throw problem('refused');
    const client = await call('/api/auth/oauth2/public-client-prelogin', {
      client_id: clientId, oauth_query: oauthQuery,
    });
    if (!client || typeof client !== 'object') throw problem('service');
    const name = typeof client.client_name === 'string' ? client.client_name.trim() : '';
    return name || clientId;
  }
  // After a refusal: is the request itself still good? A stale or changed one ends here.
  async function requestEnded() {
    if (!hasRequest) return false;
    try { await verifiedName(); return false; } catch (error) { return error.kind === 'refused'; }
  }

  // ---- One action at a time; waits; busy buttons -------------------------------------
  async function act(button, label, run) {
    if (acting) return;
    acting = true;
    const controls = [...card.querySelectorAll('button,input')];
    for (const control of controls) { control.disabled = true; control.setAttribute('data-acting', ''); }
    const text = button.querySelector('[data-label]') || button;
    const kept = [...text.childNodes];
    const spin = document.createElement('span');
    spin.className = 'spin';
    spin.setAttribute('aria-hidden', 'true');
    text.replaceChildren(label);
    button.dataset.busy = '';
    button.prepend(spin);
    try {
      await run();
    } finally {
      spin.remove();
      delete button.dataset.busy;
      text.replaceChildren(...kept);
      for (const control of controls) {
        control.removeAttribute('data-acting');
        control.disabled = control.hasAttribute('data-hold');
      }
      acting = false;
      if (document.activeElement === document.body && !button.disabled && button.offsetParent) {
        button.focus({ preventScroll: true });
      }
    }
  }
  const holds = new Map();
  function hold(key, seconds, controls, paint, done) {
    release(key);
    const until = Date.now() + seconds * 1000;
    for (const control of controls) { control.disabled = true; control.setAttribute('data-hold', ''); }
    const tick = () => {
      const left = Math.ceil((until - Date.now()) / 1000);
      if (left > 0) return paint(left);
      release(key);
    };
    holds.set(key, { timer: setInterval(tick, 250), controls, done });
    tick();
  }
  function release(key) {
    const held = holds.get(key);
    if (!held) return;
    clearInterval(held.timer);
    holds.delete(key);
    for (const control of held.controls) {
      control.removeAttribute('data-hold');
      control.disabled = control.hasAttribute('data-acting');
    }
    if (held.done) held.done();
  }
  // A 429: say so, show the wait, and keep the buttons still until it is over.
  function rateLimited(seconds, waitId, controls) {
    const wait = $(waitId);
    mood('fail');
    say(T.rate, 'oops');
    wait.hidden = false;
    hold(waitId, seconds, controls, (left) => { wait.textContent = T.tryIn(left); }, () => { wait.hidden = true; });
  }
  function trouble(error, waitId, controls) {
    if (error.kind === 'rate') return rateLimited(error.wait, waitId, controls);
    mood('fail');
    say(error.kind === 'network' ? T.offline : T.broken, 'oops');
  }

  // ---- Shared ends ---------------------------------------------------------------------
  function stop(lead, name, line, note) {
    title(lead, name);
    mood('fail');
    say(line, 'oops');
    $('stop-text').textContent = note;
    show('stop', $('title'));
  }
  function ended() { stop(T.expiredTitle, '', T.expired, T.expiredNote); }
  function retry(error, again) {
    const button = $('retry');
    show('retry');
    button.onclick = () => { release('retry-wait'); again(); };
    trouble(error, 'retry-wait', [button]);
  }
  function going(lead) {
    if (lead) title(lead, '');
    $('going-text').textContent = product ? T.back(product) : T.backPlain;
    show('going', $('title'));
  }

  // ====================================================================================
  // Sign in
  // ====================================================================================
  const webauthn = window.isSecureContext && typeof window.PublicKeyCredential === 'function' &&
    !!navigator.credentials && typeof navigator.credentials.get === 'function' &&
    typeof navigator.credentials.create === 'function';
  let whatsappOn = false;
  let signedIn = false;
  let proof = null;

  const bytes = text => Uint8Array.from(atob(text.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
  const text64 = buffer => btoa(String.fromCharCode(...new Uint8Array(buffer)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const listed = list => (Array.isArray(list) ? list : []).map(entry => ({ ...entry, id: bytes(entry.id) }));
  function requestOptions(json) {
    if (typeof PublicKeyCredential.parseRequestOptionsFromJSON === 'function') {
      try { return PublicKeyCredential.parseRequestOptionsFromJSON(json); } catch { /* by hand */ }
    }
    return { ...json, challenge: bytes(json.challenge), allowCredentials: listed(json.allowCredentials) };
  }
  function creationOptions(json) {
    if (typeof PublicKeyCredential.parseCreationOptionsFromJSON === 'function') {
      try { return PublicKeyCredential.parseCreationOptionsFromJSON(json); } catch { /* by hand */ }
    }
    return {
      ...json, challenge: bytes(json.challenge), user: { ...json.user, id: bytes(json.user.id) },
      excludeCredentials: listed(json.excludeCredentials),
    };
  }
  // WebAuthn JSON: the browser's own toJSON where it has one, the same shape by hand otherwise.
  function credentialJSON(credential) {
    if (typeof credential.toJSON === 'function') return credential.toJSON();
    const from = credential.response;
    const response = { clientDataJSON: text64(from.clientDataJSON) };
    if (from.attestationObject) {
      response.attestationObject = text64(from.attestationObject);
      if (typeof from.getTransports === 'function') response.transports = from.getTransports();
    } else {
      response.authenticatorData = text64(from.authenticatorData);
      response.signature = text64(from.signature);
      if (from.userHandle) response.userHandle = text64(from.userHandle);
    }
    return {
      id: credential.id, rawId: text64(credential.rawId), type: credential.type, response,
      clientExtensionResults: typeof credential.getClientExtensionResults === 'function' ?
        credential.getClientExtensionResults() : {},
      ...(credential.authenticatorAttachment ? { authenticatorAttachment: credential.authenticatorAttachment } : {}),
    };
  }

  // Signed in. The service may already have resumed the request; otherwise ask it to.
  async function entered(result, created, omitted) {
    signedIn = true;
    // A ticket is spent once it has made an account, and kept for nothing else.
    ticket = '';
    if (!hasRequest) return done(created);
    mood('jump');
    say(created ? T.saved : T.in);
    going('You’re signed in');
    // A new account gets a beat to see that its passkey was saved.
    if (created) await new Promise(resolve => setTimeout(resolve, 900));
    try {
      if (follow(result)) return;
      const next = await call('/api/auth/oauth2/continue', mustCreate && omitted ?
        { oauth_query: oauthQuery, created: true } : { oauth_query: oauthQuery, selected: true });
      if (!follow(next)) throw problem('service');
    } catch (error) {
      if (error.kind === 'refused') return ended();
      session();
      trouble(error, 'session-wait', [$('continue'), $('switch')]);
    }
  }
  function done(created) {
    title('You’re signed in', '');
    mood('jump');
    say(created ? T.saved : T.in);
    show('done', $('title'));
  }

  function passkeys(line, tone) {
    title(mustCreate ? 'Create your account for' : 'Sign in to', product || 'Automagik');
    const use = $('use-passkey');
    const create = $('create-passkey');
    if (mustCreate && create.classList.contains('secondary')) {
      // Asked to create: the same two choices, the new account first.
      create.classList.replace('secondary', 'primary');
      use.classList.replace('primary', 'secondary');
      create.querySelector('.aside').hidden = true;
      use.querySelector('[data-label]').textContent = 'I have a passkey';
      create.prepend(use.querySelector('svg'));
      use.before(create);
    }
    $('whatsapp-offer').hidden = !whatsappOn;
    who('genie');
    say(line || T.passkey, tone);
    show('passkey');
  }
  function passkeyTrouble(error, creating) {
    const controls = [$('use-passkey'), $('create-passkey'), $('use-whatsapp')];
    if (error.kind) return trouble(error, 'passkey-wait', controls);
    const name = error && error.name;
    if (name === 'NotAllowedError' || name === 'AbortError') { mood('hmm'); return say(T.cancelled); }
    mood('fail');
    if (creating && name === 'InvalidStateError') return say(T.already, 'oops');
    if (name === 'NotSupportedError' || name === 'SecurityError' || name === 'ConstraintError') {
      return say(T.cannot, 'oops');
    }
    say(creating ? T.failedSave : T.failedUse, 'oops');
  }
  // The service's refusal of an invitation, in the page's words; '' for any other refusal.
  function invitation(code) {
    if (code === 'INVITATION_REQUIRED') return T.invite;
    if (code === 'INVITATION_USED') return T.inviteUsed;
    return code === 'INVITATION_INVALID' ? T.inviteBad : '';
  }
  async function refused(error, creating) {
    if (error.kind !== 'refused') return passkeyTrouble(error, creating);
    if (invitation(error.code)) { mood('fail'); return say(invitation(error.code), 'oops'); }
    if (await requestEnded()) return ended();
    mood('fail');
    say(creating ? T.failedSave : T.failedUse, 'oops');
  }
  function usePasskey() {
    return act($('use-passkey'), T.waiting, async () => {
      mood('wait');
      say(T.prompt);
      try {
        const options = await call('/api/auth/passkey/generate-authenticate-options');
        const credential = await navigator.credentials.get({ publicKey: requestOptions(options) });
        mood('work');
        say(T.checking);
        const result = await call('/api/auth/passkey/verify-authentication', {
          response: credentialJSON(credential), ...(hasRequest ? { oauth_query: oauthQuery } : {}),
        });
        await entered(result, false, false);
      } catch (error) {
        await refused(error, false);
      }
    });
  }
  function createPasskey() {
    return act($('create-passkey'), T.waiting, async () => {
      mood('wait');
      say(T.promptSave);
      // Asked to create: the new account's sign-in is reported with `created`, not the query.
      const omitted = mustCreate;
      // No invitation, no new account: say so before anything is asked of the device.
      if (!ticket) { mood('hmm'); return say(T.invite); }
      try {
        if (signedIn) { await call('/api/auth/sign-out', {}); signedIn = false; }
        const options = await call('/api/auth/passkey/generate-register-options', undefined, { [TICKET_HEADER]: ticket });
        const credential = await navigator.credentials.create({ publicKey: creationOptions(options) });
        mood('work');
        say(T.checking);
        const result = await call('/api/auth/passkey/verify-registration', {
          response: credentialJSON(credential), createSession: true,
          ...(hasRequest && !omitted ? { oauth_query: oauthQuery } : {}),
        });
        await entered(result, true, omitted);
      } catch (error) {
        await refused(error, true);
      }
    });
  }

  // Already signed in here: carry on, or pick another account.
  function session() {
    title('Continue to', product);
    mood('wave');
    say(T.here);
    show('session');
  }
  function carryOn() {
    return act($('continue'), T.backPlain, async () => {
      try {
        const next = await call('/api/auth/oauth2/continue', { oauth_query: oauthQuery, selected: true });
        if (!follow(next)) throw problem('service');
        going();
      } catch (error) {
        if (error.kind !== 'refused') return trouble(error, 'session-wait', [$('continue'), $('switch')]);
        if (await requestEnded()) return ended();
        signedIn = false;
        mood('idle');
        passkeys(T.again);
      }
    });
  }
  function signOut(button) {
    return act(button, 'Signing out…', async () => {
      try {
        await call('/api/auth/sign-out', {});
        signedIn = false;
        mood('idle');
        passkeys(button.id === 'sign-out' ? T.signedOut : undefined);
      } catch (error) {
        trouble(error, 'session-wait', [$('continue'), $('switch')]);
      }
    });
  }

  // ---- WhatsApp: only when the service has it on ---------------------------------------
  // The person sends one message from their own WhatsApp; nothing is sent to them and no
  // number or code is typed here. The page shows the message, waits and asks the service.
  function stopWhatsApp() {
    if (!proof) return;
    proof.stopped = true;
    clearTimeout(proof.timer);
    clearInterval(proof.clock);
    proof = null;
  }
  // WhatsApp is the way in on offer: the only one on this browser, or after a code ran out.
  function offer(line, tone, again) {
    stopWhatsApp();
    title(mustCreate ? 'Create your account for' : 'Sign in to', product || 'Automagik');
    $('start-whatsapp').querySelector('[data-label]').textContent = again ? T.startAgain : T.useWhatsApp;
    $('offer-passkey').hidden = !webauthn;
    who('omni');
    mood(again ? 'hmm' : 'idle');
    say(line, tone);
    show('offer', again ? $('start-whatsapp') : undefined);
  }
  function startWhatsApp(button) {
    const first = button.id === 'use-whatsapp';
    return act(button, T.waStart, async () => {
      mood('work');
      say(T.waStarting);
      // Asked to create: the new account's sign-in is reported with `created`, not the query.
      const omitted = mustCreate;
      let started;
      try {
        if (omitted && signedIn) { await call('/api/auth/sign-out', {}); signedIn = false; }
        // A ticket is needed only if the number has no account yet; send it when there is one.
        started = await call('/api/auth/whatsapp/start', hasRequest && !omitted ? { oauth_query: oauthQuery } : {},
          ticket ? { [TICKET_HEADER]: ticket } : undefined);
      } catch (error) {
        if (error.kind !== 'refused') {
          return trouble(error, first ? 'passkey-wait' : 'offer-wait',
            first ? [$('use-passkey'), $('create-passkey'), button] : [button]);
        }
        if (invitation(error.code)) { mood('fail'); return say(invitation(error.code), 'oops'); }
        if (error.status === 403 || await requestEnded()) return ended();
        mood('fail');
        return say(T.broken, 'oops');
      }
      let link = null;
      try { link = new URL(String(started && started.url)); } catch { link = null; }
      const code = started && typeof started.code === 'string' ? started.code : '';
      if (!link || link.protocol !== 'https:' || !/^[A-Za-z0-9]{4,12}$/.test(code)) {
        mood('fail');
        return say(T.broken, 'oops');
      }
      waiting(link, code, Number(started.expiresAt), omitted);
    });
  }
  function waiting(link, code, expiresAt, omitted) {
    stopWhatsApp();
    const run = { stopped: false, asking: false, held: false, timer: 0, clock: 0 };
    proof = run;
    // On a phone the button opens WhatsApp; on a desk the phone scans the same link.
    const onPhone = window.matchMedia('(hover: none) and (pointer: coarse)').matches;
    const words = link.searchParams.get('text') || '';
    $('wa-words').textContent = words.endsWith(code) ? words.slice(0, -code.length).trim() : '';
    $('wa-code').textContent = code;
    const drawn = !onPhone && drawCode($('qr-code'), link.href);
    $('qr').hidden = !drawn;
    $('proof').classList.toggle('with-qr', drawn);
    $('wa-step-open').textContent = drawn ? T.waStepScan : T.waStepOpen;
    const open = $('open-whatsapp');
    open.href = link.href;
    open.className = drawn ? 'button secondary' : 'button primary';
    open.querySelector('[data-label]').textContent = drawn ? T.waOpenHere : 'Open WhatsApp';
    $('leave-whatsapp').hidden = !webauthn;
    const line = drawn ? T.waScan : T.waOpen;
    title(mustCreate ? 'Create your account for' : 'Sign in to', product || 'Automagik');
    who('omni');
    mood('wait');
    say(line);
    show('whatsapp', $('title'));

    const until = Math.min(Number.isFinite(expiresAt) ? expiresAt : Infinity, Date.now() + 300000);
    const paint = () => {
      const left = Math.max(0, Math.ceil((until - Date.now()) / 1000));
      $('wa-left').textContent = left ? T.waLeft(`${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`) : T.waStill;
    };
    paint();
    run.clock = setInterval(paint, 1000);
    let steady = true;
    const next = (wait) => { run.asking = false; if (!run.stopped) run.timer = setTimeout(ask, wait); };
    async function ask() {
      if (run.stopped || run.asking) return;
      run.asking = true;
      run.held = false;
      let result;
      try {
        result = await call('/api/auth/whatsapp/status');
      } catch (error) {
        if (run.stopped) return;
        steady = false;
        if (error.kind === 'rate') { mood('hmm'); say(T.waSlow); run.held = true; return next(error.wait * 1000); }
        if (error.kind === 'refused') {
          stopWhatsApp();
          return error.status === 403 || await requestEnded() ? ended() : offer(T.waExpired, '', true);
        }
        mood('fail');
        say(error.kind === 'network' ? T.offline : T.broken, 'oops');
        return next(2000);
      }
      if (run.stopped) return;
      const status = result && typeof result === 'object' ? result.status : '';
      if (status === 'verified' || (result && result.redirect === true)) {
        stopWhatsApp();
        return entered(result, false, omitted);
      }
      if (status === 'invitation_required' || status === 'invitation_used') {
        stopWhatsApp();
        return offer(status === 'invitation_used' ? T.inviteUsed : T.waInvite, 'oops', true);
      }
      if (status !== 'pending') return offer(T.waExpired, '', true);
      if (!steady) { steady = true; mood('wait'); say(line); }
      next(2000);
    }
    // Back from WhatsApp: ask at once instead of waiting for the next turn.
    run.now = () => { if (!run.held) { clearTimeout(run.timer); ask(); } };
    next(2000);
  }
  function leaveWhatsApp() {
    stopWhatsApp();
    mood('idle');
    passkeys();
  }

  // A QR code for the WhatsApp link, drawn here so nothing leaves this origin. Byte mode,
  // error correction M, versions 1 to 10 (up to 213 bytes): [codewords, check words per block,
  // blocks] and the centres of the alignment marks.
  const QR = [null, [26, 10, 1, []], [44, 16, 1, [6, 18]], [70, 26, 1, [6, 22]], [100, 18, 2, [6, 26]],
    [134, 24, 2, [6, 30]], [172, 16, 4, [6, 34]], [196, 18, 4, [6, 22, 38]], [242, 22, 4, [6, 24, 42]],
    [292, 22, 5, [6, 26, 46]], [346, 26, 5, [6, 28, 50]]];
  function codeMatrix(text) {
    const data = [...new TextEncoder().encode(text)];
    let version = 1;
    const room = v => QR[v][0] - QR[v][1] * QR[v][2];
    while (version <= 10 && 4 + (version < 10 ? 8 : 16) + data.length * 8 > room(version) * 8) version++;
    if (version > 10) return null;
    const [total, checks, count, marks] = QR[version];
    // The message: mode, length, bytes, an end mark, then padding to the version's room.
    const bits = [];
    const put = (value, length) => { for (let i = length - 1; i >= 0; i--) bits.push((value >>> i) & 1); };
    put(4, 4);
    put(data.length, version < 10 ? 8 : 16);
    for (const byte of data) put(byte, 8);
    put(0, Math.min(4, room(version) * 8 - bits.length));
    put(0, (8 - bits.length % 8) % 8);
    for (let pad = 0xec; bits.length < room(version) * 8; pad ^= 0xec ^ 0x11) put(pad, 8);
    const words = [];
    for (let i = 0; i < bits.length; i += 8) words.push(bits.slice(i, i + 8).reduce((byte, bit) => byte << 1 | bit, 0));
    // Check words (Reed-Solomon over GF(256)), block by block, then interleaved.
    const times = (x, y) => { let z = 0; for (let i = 7; i >= 0; i--) { z = (z << 1) ^ ((z >>> 7) * 0x11d); z ^= ((y >>> i) & 1) * x; } return z; };
    const divisor = new Array(checks).fill(0);
    divisor[checks - 1] = 1;
    for (let i = 0, root = 1; i < checks; i++, root = times(root, 2)) {
      for (let j = 0; j < checks; j++) { divisor[j] = times(divisor[j], root); if (j + 1 < checks) divisor[j] ^= divisor[j + 1]; }
    }
    const short = count - total % count;
    const length = Math.floor(total / count);
    const blocks = [];
    for (let i = 0, at = 0; i < count; i++) {
      const part = words.slice(at, at + length - checks + (i < short ? 0 : 1));
      at += part.length;
      const rest = new Array(checks).fill(0);
      for (const byte of part) {
        const factor = byte ^ rest.shift();
        rest.push(0);
        divisor.forEach((value, j) => { rest[j] ^= times(value, factor); });
      }
      if (i < short) part.push(0);
      blocks.push(part.concat(rest));
    }
    const stream = [];
    for (let i = 0; i < blocks[0].length; i++) {
      blocks.forEach((block, j) => { if (i !== length - checks || j >= short) stream.push(block[i]); });
    }
    // The grid: the fixed marks first, then the message in its zigzag.
    const size = version * 4 + 17;
    const grid = Array.from({ length: size }, () => new Array(size).fill(false));
    const fixed = Array.from({ length: size }, () => new Array(size).fill(false));
    const mark = (x, y, dark) => { if (x >= 0 && x < size && y >= 0 && y < size) { grid[y][x] = dark; fixed[y][x] = true; } };
    for (let i = 0; i < size; i++) { mark(6, i, i % 2 === 0); mark(i, 6, i % 2 === 0); }
    for (const [cx, cy] of [[3, 3], [size - 4, 3], [3, size - 4]]) {
      for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
        const ring = Math.max(Math.abs(dx), Math.abs(dy));
        mark(cx + dx, cy + dy, ring !== 2 && ring !== 4);
      }
    }
    const last = marks.length - 1;
    marks.forEach((cx, i) => marks.forEach((cy, j) => {
      if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) return;
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) mark(cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
    }));
    const format = (mask) => {
      let rest = mask;
      for (let i = 0; i < 10; i++) rest = (rest << 1) ^ ((rest >>> 9) * 0x537);
      const value = (mask << 10 | rest) ^ 0x5412;
      const bit = i => ((value >>> i) & 1) !== 0;
      for (let i = 0; i <= 5; i++) mark(8, i, bit(i));
      mark(8, 7, bit(6)); mark(8, 8, bit(7)); mark(7, 8, bit(8));
      for (let i = 9; i < 15; i++) mark(14 - i, 8, bit(i));
      for (let i = 0; i < 8; i++) mark(size - 1 - i, 8, bit(i));
      for (let i = 8; i < 15; i++) mark(8, size - 15 + i, bit(i));
      mark(8, size - 8, true);
    };
    format(0);
    if (version >= 7) {
      let rest = version;
      for (let i = 0; i < 12; i++) rest = (rest << 1) ^ ((rest >>> 11) * 0x1f25);
      const value = version << 12 | rest;
      for (let i = 0; i < 18; i++) {
        const dark = ((value >>> i) & 1) !== 0;
        mark(size - 11 + i % 3, Math.floor(i / 3), dark);
        mark(Math.floor(i / 3), size - 11 + i % 3, dark);
      }
    }
    let placed = 0;
    for (let right = size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (let step = 0; step < size; step++) for (let j = 0; j < 2; j++) {
        const x = right - j;
        const y = ((right + 1) & 2) === 0 ? size - 1 - step : step;
        if (fixed[y][x] || placed >= stream.length * 8) continue;
        grid[y][x] = ((stream[placed >>> 3] >>> (7 - (placed & 7))) & 1) !== 0;
        placed++;
      }
    }
    // The mask that leaves the calmest pattern, by the standard's four penalties.
    const MASKS = [(x, y) => (x + y) % 2 === 0, (x, y) => y % 2 === 0, x => x % 3 === 0, (x, y) => (x + y) % 3 === 0,
      (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0, (x, y) => x * y % 2 + x * y % 3 === 0,
      (x, y) => (x * y % 2 + x * y % 3) % 2 === 0, (x, y) => ((x + y) % 2 + x * y % 3) % 2 === 0];
    const flip = (mask) => {
      for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (!fixed[y][x] && MASKS[mask](x, y)) grid[y][x] = !grid[y][x];
    };
    const penalty = () => {
      let score = 0;
      let dark = 0;
      const lines = [];
      for (let i = 0; i < size; i++) {
        lines.push(grid[i].map(cell => (cell ? '1' : '0')).join(''));
        lines.push(grid.map(row => (row[i] ? '1' : '0')).join(''));
      }
      for (const line of lines) {
        for (const run of line.match(/0{5,}|1{5,}/g) || []) score += run.length - 2;
        for (const pattern of ['10111010000', '00001011101']) {
          for (let at = line.indexOf(pattern); at >= 0; at = line.indexOf(pattern, at + 1)) score += 40;
        }
      }
      for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
        if (grid[y][x]) dark++;
        if (x + 1 < size && y + 1 < size && grid[y][x] === grid[y][x + 1] &&
            grid[y][x] === grid[y + 1][x] && grid[y][x] === grid[y + 1][x + 1]) score += 3;
      }
      return score + Math.floor(Math.abs(dark * 20 - size * size * 10) / (size * size)) * 10;
    };
    let best = 0;
    let least = Infinity;
    for (let mask = 0; mask < 8; mask++) {
      flip(mask);
      format(mask);
      const score = penalty();
      if (score < least) { least = score; best = mask; }
      flip(mask);
    }
    flip(best);
    format(best);
    return grid;
  }
  function drawCode(svg, text) {
    const grid = codeMatrix(text);
    if (!grid) return false;
    const quiet = 2;
    let path = '';
    grid.forEach((row, y) => row.forEach((dark, x) => { if (dark) path += `M${x + quiet} ${y + quiet}h1v1h-1z`; }));
    const shape = document.createElementNS(svg.namespaceURI, 'path');
    shape.setAttribute('class', 'qr-dark');
    shape.setAttribute('d', path);
    svg.setAttribute('viewBox', `0 0 ${grid.length + quiet * 2} ${grid.length + quiet * 2}`);
    svg.replaceChildren(shape);
    return true;
  }

  async function signIn() {
    title('Sign in', '');
    mood('work');
    say(T.moment);
    show('loading');
    const [config, current, name] = await Promise.allSettled([
      call('/api/id/config'), call('/api/auth/get-session'), hasRequest ? verifiedName() : Promise.resolve(''),
    ]);
    if (name.status === 'rejected') {
      return name.reason.kind === 'refused' ? ended() : retry(name.reason, signIn);
    }
    product = name.value;
    // A config failure leaves passkeys usable and the WhatsApp option hidden.
    whatsappOn = config.status === 'fulfilled' && !!config.value && config.value.whatsappEnabled === true;
    signedIn = current.status === 'fulfilled' && !!current.value && !!current.value.session;
    if (signedIn && !mustCreate && !hasRequest) return done(false);
    if (signedIn && !mustCreate && !mustBeFresh) return session();
    if (!webauthn) {
      if (whatsappOn) return offer(T.unsupportedWhatsApp);
      return stop('Sign in to', product || 'Automagik', T.unsupported, T.unsupportedNote);
    }
    mood('wave');
    passkeys();
  }

  // ====================================================================================
  // Allow access
  // ====================================================================================
  function asks() {
    const list = $('asks');
    const row = (strong, detail) => {
      const item = document.createElement('li');
      const tick = document.createElement('span');
      tick.className = 'tick';
      tick.setAttribute('aria-hidden', 'true');
      const ask = document.createElement('div');
      ask.className = 'ask';
      const head = document.createElement('strong');
      head.append(strong);
      const sub = document.createElement('span');
      sub.textContent = detail;
      ask.append(head, sub);
      item.append(tick, ask);
      list.append(item);
    };
    list.replaceChildren();
    for (const scope of new Set((asked.get('scope') || '').split(' ').filter(Boolean))) {
      const known = Object.hasOwn(T.scopes, scope) ? T.scopes[scope] : null;
      if (known) { row(known[0], known[1]); continue; }
      // A scope this page has no words for is shown as it is, never hidden.
      const raw = document.createElement('code');
      raw.textContent = scope;
      row(raw, T.otherScope);
    }
    let claims = null;
    try { claims = JSON.parse(asked.get('claims') || 'null'); } catch { claims = null; }
    const names = new Set();
    for (const part of ['userinfo', 'id_token']) {
      if (claims && claims[part] && typeof claims[part] === 'object') {
        for (const key of Object.keys(claims[part])) names.add(key);
      }
    }
    if (names.size) row(T.claims, [...names].join(', '));
    $('asks-label').hidden = !list.children.length;
  }
  function decide(accept) {
    const buttons = [$('allow'), $('deny')];
    return act(accept ? $('allow') : $('deny'), accept ? T.allowing : T.cancelling, async () => {
      try {
        const result = await call('/api/auth/oauth2/consent', { accept, oauth_query: oauthQuery });
        if (!follow(result)) throw problem('service');
        const [lead, line] = accept ? T.allowed : T.refused;
        mood(accept ? 'jump' : 'idle');
        say(line);
        going(lead);
      } catch (error) {
        if (error.kind !== 'refused') return trouble(error, 'ask-wait', buttons);
        if (error.status === 401) return timedOut();
        if (error.status === 403) return stop('Not allowed', '', T.notAllowed, T.notAllowedNote(product));
        ended();
      }
    });
  }
  function timedOut() {
    title('Sign in again', '');
    mood('idle');
    say(T.timedOut);
    show('expired', $('title'));
  }
  async function consent() {
    title('Allow access', '');
    mood('work');
    say(T.moment);
    show('loading');
    if (!hasRequest) return ended();
    const [current, name] = await Promise.allSettled([call('/api/auth/get-session'), verifiedName()]);
    if (name.status === 'rejected') {
      return name.reason.kind === 'refused' ? ended() : retry(name.reason, consent);
    }
    if (current.status === 'rejected') {
      return current.reason.kind === 'refused' ? timedOut() : retry(current.reason, consent);
    }
    product = name.value;
    if (!current.value || !current.value.session) return timedOut();
    asks();
    title('Allow', `${product}?`);
    mood('idle');
    say(T.trust(product));
    show('ask');
  }

  // ---- Wiring --------------------------------------------------------------------------
  const on = (id, event, handler) => { const node = $(id); if (node) node.addEventListener(event, handler); };
  on('use-passkey', 'click', usePasskey);
  on('create-passkey', 'click', createPasskey);
  on('use-whatsapp', 'click', () => startWhatsApp($('use-whatsapp')));
  on('start-whatsapp', 'click', () => startWhatsApp($('start-whatsapp')));
  on('offer-passkey', 'click', leaveWhatsApp);
  on('leave-whatsapp', 'click', leaveWhatsApp);
  on('continue', 'click', carryOn);
  on('switch', 'click', () => signOut($('switch')));
  on('sign-out', 'click', () => signOut($('sign-out')));
  on('allow', 'click', () => decide(true));
  on('deny', 'click', () => decide(false));
  on('sign-in-again', 'click', () => { window.location.assign(`/sign-in?${oauthQuery}`); });
  // Leaving stops the asking; coming back from WhatsApp asks at once.
  window.addEventListener('pagehide', stopWhatsApp);
  document.addEventListener('visibilitychange', () => { if (proof && document.visibilityState === 'visible') proof.now(); });
  // Back from the product: start clean instead of showing a finished state.
  window.addEventListener('pageshow', (event) => { if (event.persisted) window.location.reload(); });

  if (document.body.dataset.page === 'consent') consent(); else signIn();
})();
