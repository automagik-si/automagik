# WISH-REPORT — create_bot deve aceitar kind e dsh sair como na UI

## Entrega

- **PR:** https://github.com/automagik-si/automagik/pull/1434 (base `dev`)
- **Branch:** `wish/create-bot-deve-aceitar-kind-e-dsh-sair`
- **Base:** `d5c630f8` (= `origin/dev` no momento do push)
- **Commits:**
  - `f9b61804` — `feat(bots-dsh): let create_bot choose a Bot kind, with dsh on the native UI path`
  - `3f79e97d` — `fix(bots-dsh): keep create_bot's level and tool narrowing on the dsh path`
  - `docs: add the wish report for create_bot kinds` (este arquivo; hash no fim da branch)

## Mudança de comportamento (antes -> depois)

**Antes:** `create_bot({ kind: 'dsh' })` ignorava `kind` e criava um Bot comum (`kind=None`), com a persona nas `instructions`.
**Depois:** `create_bot` aceita `plain` (padrão), `dsh`, `omni` e `genie`; `dsh` reusa o mesmo caminho da UI (`rt.addAgent({ teamMember: true })`, o de **New DSH bot**), então o Bot sai nativo DSH (`kind=dsh`, a baleia), com o preset/persona e o wiring de plugins do DSH e os defaults do DSH — não um prompt em cima de um Bot comum.

## O que mudou (arquivos)

- `apps/bots-dsh/src/host/tools.js`
  - `create_bot` declara `kind` (`plain|dsh|omni|genie`) e `profile` (preset DSH, só para `dsh`).
  - `dsh` chama `rt.addAgent({ teamMember: true })` — o caminho único que `agents.js` já usa para o **New DSH bot** da UI — em vez de montar persona/plugins de novo.
  - `omni`/`genie` seguem para o `kind` que `roster.js` já persistia; `plain` não grava `kind`.
  - O narrowing que todo `create_bot` faz continua no `dsh`: o nível herdado do criador e a deny list dele são lidos antes de o Bot existir, gravados no registro adotado e aplicados à Session nativa já aberta. Um Main Bot read-only não abre uma Session DSH mais ampla que ele.
- `apps/bots-dsh/test/agents.test.js` — paridade `create_bot(kind: 'dsh')` x `add-agent({ teamMember: true })` da UI (kind, `profile`, `dshAgentId`, registro nativo adotado, `agentPreset` no `sessionController.create`, sem prompt), deny list herdada, e `plain`/`omni`/`genie` + kind inválido recusado pelo schema.
- `apps/bots-dsh/test/permissions.test.js` — o nível do criador continua valendo no `dsh`; o contrato antigo de parâmetros não declarados foi ajustado para o `kind` declarado.
- `apps/bots-dsh/test/work-dir.test.js` — idem: `kind` declarado é aceito; os demais parâmetros não declarados continuam barrados.
- `apps/bots-dsh/README.md` — a seção **DSH bots** documenta o `kind` do `create_bot` e o mesmo caminho da UI.

## Red (falhas reais antes da correção)

Comando:

```sh
cd apps/bots-dsh && node --import ./test/harness-resolve.mjs --test --test-timeout=120000 \
  --test-name-pattern="create_bot (kind dsh|takes plain)" test/agents.test.js
```

Saída real:

```text
✖ create_bot kind dsh takes the UI DSH path: native preset and wiring, not a prompt (87.68024ms)
✖ create_bot takes plain, omni and genie kinds, and refuses one it does not know (20.281794ms)
ℹ tests 2
ℹ suites 0
ℹ pass 0
ℹ fail 2
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 489.690545

✖ failing tests:

test at test/agents.test.js:643:1
✖ create_bot kind dsh takes the UI DSH path: native preset and wiring, not a prompt (87.68024ms)
  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:

  undefined !== 'dsh'

test at test/agents.test.js:681:1
✖ create_bot takes plain, omni and genie kinds, and refuses one it does not know (20.281794ms)
  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:
  + actual - expected

  + undefined
  - 'omni'
```

Red do narrowing (achado durante a correção; o caminho nativo da UI não herda o nível do criador):

```text
✖ create_bot kind dsh still starts at its creator's level (88.962836ms)
  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:
  + actual - expected

  + undefined
  - 'careful'
```

## Green (suíte relevante completa)

Comando (o gate do plugin, `apps/bots-dsh/package.json` → `test`):

```sh
cd apps/bots-dsh && bun run test
```

Saída real (fim da execução, árvore final):

```text
ℹ tests 5387
ℹ suites 23
ℹ pass 5239
ℹ fail 0
ℹ cancelled 0
ℹ skipped 148
ℹ todo 0
ℹ duration_ms 183287.826519
test-guard: complete run: plan 1..5226, 5226 top-level results, 5387 tests (5239 pass, 0 fail, 0 cancelled, 148 skipped, 0 todo), 391 files
```

Exit code: `0`.

Lint:

```sh
cd apps/bots-dsh && bun run lint
```

```text
Found 137 warnings and 0 errors.
Finished in 50ms on 849 files with 97 rules using 32 threads.
```

## CI do PR

Todas as verificações passaram — `bots-dsh (plugin tests)`, `CI`, imagens Linux/Server, `Boot`, `Desktop`, `Pocket`, `Privacy`, `GitGuardian`, `Cloudflare Pages` etc. — **exceto** o workflow **Conventional commits**, que reprova `f9b61804` porque uma linha do corpo do commit tem mais de 100 caracteres.

Corrigir isso exige reescrever a mensagem (`amend`) ou publicar uma branch nova a partir de `d5c630f8`, e a wish proíbe amend e force-push. **Decisão necessária:** (a) autorizar o reword de `f9b61804` (amend + force-with-lease só nesta branch), ou (b) abrir uma branch/PR limpos com os mesmos diffs. Nada foi reescrito.

## Nota de ambiente

O tip inicial do worktree era o commit vazio `26d6b8bf` ("Genie starts here"), sem a árvore do projeto. A branch foi restaurada para a base real da wish, `d5c630f8` (= `origin/dev` no momento do push), e o trabalho foi feito a partir dela. Nenhum outro checkout ou branch foi tocado.

## Como foi verificado

1. Red primeiro: os testes novos de `agents.test.js` falharam em `kind` (`undefined !== 'dsh'` / `undefined !== 'omni'`), provando que `create_bot` ignorava o `kind` e que o Bot `dsh` saía sem o registro nativo da UI.
2. Red do narrowing: um criador read-only produzia um Bot `dsh` sem nível (`undefined` em vez de `careful`); corrigido antes do green.
3. Correção mínima: o `create_bot` só ganhou o parâmetro e o desvio para `rt.addAgent({ teamMember: true })`; persona, preset, wiring e defaults vêm do caminho que a UI já usa, sem duplicação.
4. Suíte completa do plugin (`bun run test`), CI do PR e lint verdes, como acima.
