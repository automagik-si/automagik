# WISH-REPORT — create_bot deve aceitar kind e dsh sair como na UI

## Entrega

- **PR:** https://github.com/automagik-si/automagik/pull/1434 (base `dev`)
- **Branch:** `wish/create-bot-deve-aceitar-kind-e-dsh-sair`
- **Base:** `d5c630f8` (= `origin/dev` no momento do push)
- **Commit do código:** `f9b61804 feat(bots-dsh): let create_bot choose a Bot kind, with dsh on the native UI path`

## Mudança de comportamento (antes -> depois)

**Antes:** `create_bot({ kind: 'dsh' })` ignorava `kind` e criava um Bot comum (`kind=None`), com a persona nas `instructions`.
**Depois:** `create_bot` aceita `plain` (padrão), `dsh`, `omni` e `genie`; `dsh` reusa o mesmo caminho da UI (`rt.addAgent({ teamMember: true })`, o de **New DSH bot**), então o Bot sai nativo DSH (`kind=dsh`, a baleia), com o preset/persona e o wiring de plugins do DSH e os defaults do DSH, não um prompt em cima de um Bot comum.

## O que mudou (arquivos)

- `apps/bots-dsh/src/host/tools.js` — `create_bot` declara `kind` (`plain|dsh|omni|genie`) e `profile` (preset DSH, só para `dsh`). `dsh` chama `rt.addAgent({ teamMember: true })` (o caminho único da UI, em `agents.js`); `omni`/`genie` seguem para o `kind` que `roster.js` já persistia; `plain` não grava `kind`.
- `apps/bots-dsh/test/agents.test.js` — testes novos: paridade `create_bot(kind: 'dsh')` x `add-agent({ teamMember: true })` da UI (kind, `profile`, `dshAgentId`, registro nativo adotado, `agentPreset` no `sessionController.create`, sem prompt) e `plain`/`omni`/`genie` + kind inválido recusado pelo schema.
- `apps/bots-dsh/test/work-dir.test.js` e `apps/bots-dsh/test/permissions.test.js` — o contrato antigo ("modelo não pode dar kind") virou "kind declarado é aceito; os demais parâmetros não declarados continuam barrados". A permissão do criador continua mandando.
- `apps/bots-dsh/README.md` — a seção **DSH bots** documenta o `kind` do `create_bot` e o mesmo caminho da UI.

## Red (falha real antes da correção)

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

## Green (suíte relevante completa)

Comando (o gate do plugin, `apps/bots-dsh/package.json` → `test`):

```sh
cd apps/bots-dsh && bun run test
```

Saída real (fim da execução):

```text
ℹ tests 5385
ℹ suites 23
ℹ pass 5237
ℹ fail 0
ℹ cancelled 0
ℹ skipped 148
ℹ todo 0
ℹ duration_ms 186456.598028
test-guard: complete run: plan 1..5224, 5224 top-level results, 5385 tests (5237 pass, 0 fail, 0 cancelled, 148 skipped, 0 todo), 391 files
```

Exit code: `0`.

Lint:

```sh
cd apps/bots-dsh && bun run lint
```

```text
Found 137 warnings and 0 errors.
Finished in 43ms on 849 files with 97 rules using 32 threads.
```

## Como foi verificado

1. Red primeiro: os dois testes novos de `agents.test.js` falharam em `kind` (`undefined !== 'dsh'` / `undefined !== 'omni'`), provando que `create_bot` ignorava o `kind` e que o Bot `dsh` saía sem o registro nativo da UI.
2. Correção mínima: `create_bot` só ganhou o parâmetro e o desvio para `rt.addAgent({ teamMember: true })`; persona, preset, wiring e defaults vêm do caminho que a UI já usa, sem duplicação.
3. Suíte completa do plugin (`bun run test`) e lint verdes, como acima.
