// Generated from src/client/gated-client.js by scripts/build-client.mjs. Do not edit by hand.
window.__ModuleLoader__.load({
  id: '@automagik/bots-dsh',
  chunk: 'client.gated.js',
  factory: (platformRequire) => ({
    initialize: (shared) => {
const require = (name) => name === './gated-shared.js' ? shared : platformRequire(name)
const module = { exports: {} }
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/client/gated-client.js
var gated_client_exports = {};
__export(gated_client_exports, {
  PeopleCard: () => PeopleCard,
  applyMember: () => applyMember
});
module.exports = __toCommonJS(gated_client_exports);

// src/client/member-root.js
var import_react = require("react");
var import_gated_shared = require("./gated-shared.js");

// src/shared/routes.js
var CODING_CLIS = Object.freeze(["acp-claude", "acp-codex"]);
var CONNECTED_BY = Object.freeze(["native", "pi-ai", "claude-code-plugin", "acp", "hermes-remote"]);
var HARNESSES = Object.freeze(["dsh", "claude-code", "codex", "gemini"]);
var SUBSCRIPTION_ROUTES = Object.freeze(["grok", "antigravity"]);
var ACP_HARNESS = Object.freeze({ claude: "claude-code", codex: "codex", gemini: "gemini" });
var ACP_NAME = Object.freeze({
  "acp-claude": "Claude Code",
  "acp-codex": "Codex",
  "acp-hermes": "Hermes",
  "acp-antigravity": "Antigravity",
  "acp-omp": "omp"
});
var LEGACY_LOCAL_CLIS = Object.freeze([
  "codex-cli",
  "devin-cli",
  "gemini-cli",
  "grok-cli",
  "cursor-cli",
  "cline",
  "qwen-code",
  "goose"
]);
var SELECTOR_ROUTES = Object.freeze(["native", "acp", "herdr", "hermes-remote"]);

// src/client/member-model.js
var initialMember = {
  bots: [],
  byId: /* @__PURE__ */ Object.create(null),
  botId: null,
  pages: [],
  cursor: null,
  generation: 0,
  loading: false,
  failed: false,
  withdrawn: false
};
function selectBot(view, botId, withdrawn = false) {
  return {
    ...view,
    botId,
    withdrawn,
    generation: view.generation + 1,
    pages: [],
    cursor: null,
    loading: false,
    failed: false
  };
}
function updateRoster(view, bots) {
  const byId = Object.fromEntries(bots.map((bot) => [bot.id, bot]));
  const next = { ...view, bots, byId };
  if (view.botId !== null && Object.hasOwn(byId, view.botId)) return next;
  if (view.botId !== null) return selectBot(next, null, true);
  return view.withdrawn || bots.length === 0 ? next : selectBot(next, bots[0].id);
}
var requestView = ({ generation, botId }) => ({ generation, botId });
var isCurrent = (view, request) => view.generation === request.generation && view.botId === request.botId;
var changedBot = (view, request, botId) => isCurrent(view, request) && view.botId === botId;
function applyPage(view, request, page, earlier) {
  if (!isCurrent(view, request)) return view;
  const items = Array.isArray(page.items) ? page.items : [];
  return {
    ...view,
    pages: earlier ? [...view.pages, items] : [items],
    cursor: page.cursor,
    loading: false,
    failed: false
  };
}
var feedEnded = (view) => selectBot({ ...initialMember, generation: view.generation }, null, view.withdrawn);
var pageRows = (pages) => pages.map((items, page) => items.map((row, index) => ({ row, key: `${page}:${index}` }))).reverse().flat();
function botLabels(bots) {
  const counts = /* @__PURE__ */ new Map();
  for (const { name } of bots) counts.set(name, (counts.get(name) ?? 0) + 1);
  return new Map(bots.map(({ id, name }) => [id, counts.get(name) > 1 ? `${name} · ${id}` : name]));
}

// src/client/member-root.js
var mark = (bot) => (0, import_react.createElement)(import_gated_shared.BotMark, { bot, look: { ...(0, import_gated_shared.lookOf)(bot), pet: void 0 }, live: false, size: 28 });
var plain = (text) => (text ?? "").split("\n").flatMap((line, index) => index === 0 ? [line] : [(0, import_react.createElement)("br", { key: index }), line]);
function MemberRows({ pages, roster, botId }) {
  const bot = Object.hasOwn(roster.byId, botId) ? roster.byId[botId] : void 0;
  return pageRows(pages).map(({ row, key }) => {
    if (row.kind === "divider") {
      const switched = typeof row.switchedTo === "string" && row.switchedTo !== "" ? (0, import_gated_shared.t)("Switched to {agent}", { agent: ACP_NAME[row.switchedTo.split("/")[0]] ?? row.switchedTo }) : void 0;
      const day = Number.isFinite(row.time) ? (0, import_gated_shared.dayLabel)(row.time) : void 0;
      return (0, import_react.createElement)(
        "div",
        { key, className: "bt-part-line", role: "separator" },
        switched === void 0 && day === void 0 ? null : (0, import_react.createElement)("span", null, [switched, day].filter((part) => part !== void 0).join(" · "))
      );
    }
    if (row.kind === "user") {
      return (0, import_react.createElement)("div", { key, className: "bt-urow" }, (0, import_react.createElement)(
        "div",
        { className: "bt-ububble" },
        plain(row.text),
        row.images ? (0, import_react.createElement)("span", { className: "bt-uimages" }, row.images === 1 ? (0, import_gated_shared.t)("1 image") : (0, import_gated_shared.t)("{count} images", { count: row.images })) : null
      ));
    }
    if (row.kind === "bot") {
      return (0, import_react.createElement)(
        "div",
        { key, className: "bt-msg-line" },
        bot ? mark(bot) : null,
        (0, import_react.createElement)("div", { className: "bt-bubble" }, plain(row.text))
      );
    }
    return null;
  });
}
function MemberRoot({ source, load }) {
  const view = (0, import_react.useSyncExternalStore)(source.subscribe, source.getSnapshot);
  const bot = view.botId !== null && Object.hasOwn(view.byId, view.botId) ? view.byId[view.botId] : void 0;
  return (0, import_react.createElement)(
    "main",
    { className: "bt-earlier", style: { height: "100%", overflowY: "auto" } },
    bot ? (0, import_react.createElement)("header", { className: "bt-msg-line" }, mark(bot), (0, import_react.createElement)("strong", null, bot.name)) : null,
    (0, import_react.createElement)("div", { className: "bt-earlier-top" }, view.loading ? (0, import_react.createElement)(import_gated_shared.Shimmer, null, (0, import_gated_shared.t)("Loading earlier messages…")) : view.failed ? (0, import_react.createElement)("button", { type: "button", className: "bt-soft", onClick: () => load(view.cursor) }, (0, import_gated_shared.t)("Couldn’t load earlier messages · Retry")) : view.cursor ? (0, import_react.createElement)("button", { type: "button", className: "bt-soft", onClick: () => load(view.cursor) }, (0, import_gated_shared.t)("Load earlier")) : null),
    (0, import_react.createElement)(MemberRows, { pages: view.pages, roster: view, botId: view.botId }),
    view.withdrawn ? (0, import_react.createElement)("p", { className: "bt-set-hint" }, (0, import_gated_shared.t)("This Bot is no longer shared with you.")) : bot && !view.loading && !view.failed && !view.pages.some((items) => items.length > 0) ? (0, import_react.createElement)("p", { className: "bt-set-hint" }, (0, import_gated_shared.t)("Nothing to read here yet.")) : null,
    (0, import_react.createElement)("p", { className: "bt-set-hint" }, (0, import_gated_shared.t)("You can read this chat, but not send messages."))
  );
}
function MemberSidebar({ source, select }) {
  const view = (0, import_react.useSyncExternalStore)(source.subscribe, source.getSnapshot);
  const labels = botLabels(view.bots);
  return (0, import_react.createElement)("div", { className: "bt-side" }, view.bots.length === 0 ? (0, import_react.createElement)("p", { className: "bt-set-hint" }, (0, import_gated_shared.t)("No Bots are shared with you yet.")) : view.bots.map((bot) => (0, import_react.createElement)("button", {
    key: bot.id,
    type: "button",
    className: "bt-soft",
    "aria-pressed": view.botId === bot.id,
    onClick: () => select(bot.id)
  }, mark(bot), labels.get(bot.id))));
}
function applyMember(ctx) {
  const source = (0, import_gated_shared.createSource)(initialMember);
  let stopped = false;
  let connected = false;
  let needsChat = false;
  let selection = null;
  let feed, retry, pageRequest, rosterRequest;
  const current = source.getSnapshot;
  const active = () => !stopped && !(0, import_gated_shared.isRetired)();
  const accepts = (request) => active() && connected && isCurrent(current(), request);
  const cancelReads = () => {
    pageRequest?.abort();
    rosterRequest?.abort();
    pageRequest = rosterRequest = void 0;
  };
  const clear = () => {
    cancelReads();
    selection = current().botId ?? selection;
    source.set(feedEnded);
  };
  function load(cursor) {
    const request = requestView(current());
    if (!accepts(request) || request.botId === null) return;
    if (cursor && pageRequest) return;
    pageRequest?.abort();
    const pending = pageRequest = new AbortController();
    source.set((view) => ({ ...view, loading: true, failed: false }));
    void (0, import_gated_shared.call)(cursor ? "earlier" : "chat", { botId: request.botId, ...cursor ? { cursor } : {} }, pending.signal).then((page) => {
      if (accepts(request) && pageRequest === pending) source.set((view) => applyPage(view, request, page, Boolean(cursor)));
    }, (error) => {
      if (!accepts(request) || pageRequest !== pending) return;
      if (error?.code === "bot/not-found") {
        clear();
        selection = null;
        source.set((view) => selectBot(view, null, true));
        refresh();
      } else source.set((view) => ({ ...view, loading: false, failed: true, cursor: cursor ?? null }));
    }).finally(() => {
      if (pageRequest === pending) pageRequest = void 0;
    });
  }
  function refresh({ chat = false } = {}) {
    if (!active() || !connected) return;
    needsChat ||= chat;
    rosterRequest?.abort();
    const request = requestView(current());
    const pending = rosterRequest = new AbortController();
    void (0, import_gated_shared.call)("state", void 0, pending.signal).then((answer) => {
      if (!accepts(request) || rosterRequest !== pending) return;
      const next = updateRoster({ ...current(), botId: selection ?? current().botId }, Array.isArray(answer.bots) ? answer.bots : []);
      selection = null;
      if (!isCurrent(next, request)) {
        pageRequest?.abort();
        pageRequest = void 0;
      }
      source.set(next);
      if (needsChat || next.botId !== request.botId) load();
      needsChat = false;
    }, () => {
      if (accepts(request) && rosterRequest === pending) clear();
    }).finally(() => {
      if (rosterRequest === pending) rosterRequest = void 0;
    });
  }
  function select(id) {
    if (!active() || current().botId === id || !Object.hasOwn(current().byId, id)) return;
    const refreshing = rosterRequest !== void 0;
    cancelReads();
    source.set((view) => selectBot(view, id));
    if (refreshing) refresh({ chat: true });
    else load();
  }
  function connect() {
    if (!active()) return;
    let mounted;
    try {
      mounted = (0, import_gated_shared.requestViewer)("feed");
    } catch {
      return;
    }
    const viewer = (0, import_gated_shared.mountedViewer)();
    const stream = feed = new EventSource(`api/omni-ui/feed?viewer=${viewer.id}.${viewer.role}`);
    const live = () => {
      try {
        (0, import_gated_shared.checkViewer)(mounted);
      } catch {
        return false;
      }
      return active() && feed === stream;
    };
    stream.addEventListener("hello", () => {
      if (!live()) return;
      connected = true;
      refresh({ chat: true });
    });
    stream.addEventListener("revision", () => {
      if (live()) refresh();
    });
    stream.addEventListener("changed", (event) => {
      if (!live() || !connected) return;
      const request = requestView(current());
      let id;
      try {
        id = JSON.parse(event.data)?.botId;
      } catch {
        return;
      }
      if (changedBot(current(), request, id)) load();
    });
    stream.addEventListener("error", () => {
      if (!live()) return;
      connected = false;
      clear();
      if (stream.readyState === EventSource.CLOSED) {
        stream.close();
        feed = void 0;
        retry = setTimeout(connect, 1e4);
      }
    });
  }
  const stop = () => {
    stopped = true;
    feed?.close();
    clearTimeout(retry);
    clear();
    selection = null;
    source.set(initialMember);
  };
  ctx.effect(() => {
    const off = (0, import_gated_shared.onRetire)(stop);
    connect();
    return () => {
      off();
      stop();
    };
  }, "ds-bot: shared chats");
  ctx.effect(() => (0, import_gated_shared.installCompiledStyles)(
    import_gated_shared.SHELL_CSS + import_gated_shared.SIDEBAR_CSS + import_gated_shared.LEFT_BAR_CSS + import_gated_shared.CONVERSATION_CSS,
    "shared-chats"
  ), "ds-bot: shared chat styles");
  ctx.effect(() => {
    const style = (0, import_gated_shared.installStyles)((0, import_gated_shared.themeCss)((0, import_gated_shared.allThemes)().deepseek), "shared-chat-theme");
    return () => style.remove();
  }, "ds-bot: shared chat theme");
  const shadow = (name, options, component) => ctx.slots.inject(name, () => ctx.slots.register({
    name,
    ...options,
    priority: (0, import_gated_shared.freePriority)(ctx.slots.entries(name), { priority: -100, ...options })
  }, component));
  ctx.effect(() => shadow("main", { key: "conversation", inject: () => ({ source, load }) }, MemberRoot), "ds-bot: shared chat");
  ctx.effect(() => shadow("sidebar.workspaces", { inject: () => ({ source, select }) }, MemberSidebar), "ds-bot: shared Bots");
  for (const name of ["settings.trigger", "settings.launcher"]) {
    ctx.effect(() => shadow(name, {}, import_gated_shared.Nothing), "ds-bot: hide " + name);
  }
  ctx.effect(() => shadow("sidebar.brand.mark", {}, import_gated_shared.BrandMark), "ds-bot: brand mark");
  ctx.effect(() => shadow("sidebar.brand.name", {}, import_gated_shared.BrandName), "ds-bot: brand name");
  ctx.effect(() => {
    const info = ctx.layout.panelInfo;
    const reset = () => {
      if (info.getSnapshot().activePanelId != null) ctx.layout.selectPanel(null);
    };
    const off = info.subscribe(reset);
    reset();
    return off;
  }, "ds-bot: keep shared chat selected");
}

// src/client/people-card.js
var PeopleReact = __toESM(require("react"), 1);
var import_gated_shared2 = require("./gated-shared.js");

// src/client/people-model.js
var personKey = ({ issuer, subject }) => JSON.stringify([issuer, subject]);
var shortSubject = (subject) => subject.length <= 16 ? subject : subject.slice(0, 13) + "…";
var issuerLabel = (issuer) => {
  try {
    return new URL(issuer).host || issuer;
  } catch {
    return issuer;
  }
};
function personLabels(people) {
  const unique = new Map(people.map((person) => [personKey(person), person]));
  const short = (person) => issuerLabel(person.issuer) + " · " + shortSubject(person.subject);
  const counts = /* @__PURE__ */ new Map();
  for (const person of unique.values()) counts.set(short(person), (counts.get(short(person)) ?? 0) + 1);
  return new Map([...unique].map(([key, person]) => [
    key,
    counts.get(short(person)) > 1 ? issuerLabel(person.issuer) + " · " + person.subject : short(person)
  ]));
}
function availablePeople(seen, allow) {
  const listed = new Set(allow.map(personKey));
  return seen.flatMap(({ roles, issuer, subject }) => {
    if (listed.has(personKey({ issuer, subject })) || roles.includes("owner") || roles.includes("admin")) return [];
    const role = roles.includes("member") ? "member" : roles.includes("guest") ? "guest" : void 0;
    return role ? [{ issuer, subject, role }] : [];
  });
}

// src/client/people-card.js
var { createElement: h2, useEffect, useRef, useState } = PeopleReact;
var modes = [
  ["owners", "Only you and admins"],
  ["allowlist", "People you choose"],
  ["workspace", "Anyone in the workspace"]
];
var shareNotes = {
  opening: "Starting a new part of this chat for sharing…",
  open: "Shared: people you add read this chat from its new part on.",
  spoiled: "Sharing did not start because something moved into the new part; stop sharing and share again."
};
var stale = "Who may talk to this Bot changed in another window; check it and save again.";
var roleWord = (role) => role === "member" ? (0, import_gated_shared2.t)("Member") : (0, import_gated_shared2.t)("Guest");
function PeopleCard({ bot, roster }) {
  const role = (0, import_gated_shared2.mountedViewer)()?.role;
  return role === "owner" || role === "admin" ? h2(OwnerPeopleCard, { key: bot.id, id: bot.id, main: (0, import_gated_shared2.isMainOf)(roster, bot.id) }) : null;
}
function OwnerPeopleCard({ id, main }) {
  const [seen, setSeen] = useState(null);
  const [share, setShare] = useState(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const lifetime = useRef(null);
  const busy = useRef(false);
  const readShare = (signal) => (0, import_gated_shared2.call)("people-share", { id }, signal).then((value) => {
    if (!signal.aborted) setShare(value);
  });
  useEffect(() => {
    const scope = new AbortController();
    lifetime.current = scope;
    void Promise.all([(0, import_gated_shared2.call)("people-seen", void 0, scope.signal), (0, import_gated_shared2.call)("people-share", { id }, scope.signal)]).then(([people2, value]) => {
      if (!scope.signal.aborted) {
        setSeen(people2);
        setShare(value);
      }
    }, () => {
    });
    return () => scope.abort();
  }, [id]);
  useEffect(() => {
    if (saving || share?.state !== "opening") return;
    const scope = new AbortController();
    const timer = setTimeout(() => {
      void readShare(scope.signal).catch((failure) => {
        if (!scope.signal.aborted) {
          setError(failure.message);
          setShare((value) => ({ ...value }));
        }
      });
    }, 3e3);
    return () => {
      scope.abort();
      clearTimeout(timer);
    };
  }, [id, share, saving]);
  if (!seen || !share) return null;
  const { people } = share;
  async function save(next) {
    const signal = lifetime.current.signal;
    if (busy.current || signal.aborted) return;
    busy.current = true;
    setSaving(true);
    setError(null);
    try {
      const result = await (0, import_gated_shared2.call)("update-bot", { id, people: next, expect: people }, signal);
      if (!signal.aborted) setShare((value) => ({ ...value, people: result.people }));
    } catch (failure) {
      if (!signal.aborted) setError(failure.code === "bot/stale" ? (0, import_gated_shared2.t)(stale) : failure.message);
    } finally {
      try {
        if (!signal.aborted) await readShare(signal);
      } catch {
      }
      busy.current = false;
      if (!signal.aborted) setSaving(false);
    }
  }
  const title = (0, import_gated_shared2.t)("Who can talk to this Bot");
  const choices = availablePeople(seen, people.allow);
  const labels = personLabels([...people.allow, ...choices]);
  const seenById = new Map(seen.map((person) => [personKey(person), person.lastSeen]));
  return h2(
    import_gated_shared2.Card,
    { title },
    h2(
      "div",
      { className: "bt-set-row bt-bs-row bt-bs-stack" },
      h2("span", { className: "bt-set-hint" }, (0, import_gated_shared2.t)("Sharing starts a new part of this chat; earlier parts stay yours.")),
      h2(import_gated_shared2.Segmented, { label: title, value: people.mode }, modes.filter(([mode]) => !main || mode !== "workspace").map(([mode, label]) => h2("button", {
        key: mode,
        type: "button",
        "aria-pressed": people.mode === mode,
        disabled: saving,
        onClick: () => {
          if (people.mode !== mode) void save({ ...people, mode });
        }
      }, (0, import_gated_shared2.t)(label))))
    ),
    h2("div", { className: "bt-set-row bt-bs-row" }, h2(
      "span",
      { className: "bt-set-hint" },
      (0, import_gated_shared2.t)("People you add can read this Bot's chat; they can't send messages yet.")
    )),
    people.mode !== "owners" ? h2(
      "div",
      null,
      h2(
        import_gated_shared2.Row,
        {
          label: (0, import_gated_shared2.t)("Guests and named people"),
          stack: true,
          hint: seen.length === 0 ? (0, import_gated_shared2.t)("No one has signed in since the last restart.") : null
        },
        choices.length > 0 ? h2("select", {
          className: "bt-soft",
          "aria-label": (0, import_gated_shared2.t)("Add person"),
          disabled: saving,
          value: "",
          onChange: (event) => {
            const person = choices.find((entry) => personKey(entry) === event.target.value);
            if (person) void save({ ...people, allow: [...people.allow, person] });
          }
        }, h2("option", { value: "" }, (0, import_gated_shared2.t)("Add person")), choices.map((person) => h2("option", { key: personKey(person), value: personKey(person) }, labels.get(personKey(person)) + " · " + roleWord(person.role)))) : null
      ),
      people.allow.map((person) => {
        const key = personKey(person);
        const lastSeen = seenById.get(key);
        return h2(
          "div",
          { key, className: "bt-set-row bt-bs-row" },
          h2(
            "span",
            { className: "bt-set-copy" },
            labels.get(key) + " · " + roleWord(person.role),
            h2("span", { className: "bt-set-hint" }, Number.isFinite(lastSeen) ? (0, import_gated_shared2.t)("Last seen {time}", { time: (0, import_gated_shared2.relativeShort)(lastSeen) }) : (0, import_gated_shared2.t)("Not signed in since the last restart"))
          ),
          h2("button", {
            type: "button",
            className: "bt-soft",
            disabled: saving,
            onClick: () => void save({ ...people, allow: people.allow.filter((entry) => personKey(entry) !== key) })
          }, (0, import_gated_shared2.t)("Remove"))
        );
      })
    ) : null,
    Object.hasOwn(shareNotes, share.state) ? h2("p", { className: "bt-set-hint", role: "status" }, (0, import_gated_shared2.t)(shareNotes[share.state])) : null,
    error ? h2("p", { className: "bt-set-hint", role: "alert" }, error) : null
  );
}
return module.exports
    },
  }),
})
