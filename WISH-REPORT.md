# Wish report — App deve desenhar Bot não instalado no roster

- **PR:** https://github.com/automagik-si/automagik/pull/1441
- **Branch:** `wish/app-deve-desenhar-bot-nao-instalado-no-r`
- **Base do PR:** `dev` (empilhada sobre o #1430; ver "Base" abaixo)
- **Commit do cliente:** `9794d9e3` `fix(bots-dsh): draw a crew Bot whose plugin is not installed as such`
- Trabalhei só no worktree próprio; o checkout compartilhado foi apenas lido, sem alterações.

## Mudança de comportamento em uma linha

Antes: um Bot de crew cujo plugin não está instalado aparecia como ocioso e saudável no roster; depois: aparece como **Not installed**, com o motivo, no row, no mark/avatar, no painel do Bot e no aria-label, e não é pintado como trabalhando, esperando ou falho.

## Base (necessária, e desvio do commit dado)

O worktree foi entregue em `26d6b8bf` ("Genie starts here"), um commit **sem árvore** (nenhum arquivo). A metade cliente depende do campo de instalação do #1430 (`src/host/installed.js`), então a branch foi semeada em `1db80783`, o head do PR #1430 (baseado em `d5c630f8`). Por isso o PR contra `dev` mostra dois commits: o do #1430 e o desta entrega. Quando o #1430 entrar, o diff deste PR é só o commit do cliente.

## Red primeiro (falha real, antes da correção)

```
✖ a crew Bot whose plugin is missing carries that in the client view
  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:
  + actual - expected
  + undefined
  - false

✖ a Bot whose plugin is not installed does not look idle or working
  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:
  + actual - expected
  + 'idle'
  - 'not-installed'

✖ a Bot whose plugin is not installed says so, in the bar and in the rail
  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:
  + actual - expected
  + 'idle'
  - 'not-installed'
```

Os três testes novos reproduzem a metade que faltava: a view não tinha `installed`, e o row/mark caíam em `idle`.

## O que mudou

- `apps/bots-dsh/src/host/channel.js` — cada Bot da view do roster leva `installed`/`reason` de `installed.js`; o endpoint `state` chama `refreshInstallation()` (TTL do próprio #1430) e uma mudança de instalação força uma view completa mesmo sem mudança de revisão.
- `apps/bots-dsh/src/client/sidebar.js` — o row (rail estreito) mostra `Not installed · motivo` no lugar da linha ociosa, e o `aria-label` diz o mesmo.
- `apps/bots-dsh/src/client/mark.js` + `styles.js` — novo estado `not-installed`, com badge/mark neutro (cinza tracejado, nunca o vermelho de `failed`), precedendo `alert`, trabalho e `failed`.
- `apps/bots-dsh/src/client/left-bar.js` + `left-bar-status.js` + `left-bar-css.js` — a barra larga (a sidebar nova) ganhou o status `not-installed`, com a palavra "Not installed" e um mark tracejado próprio.
- `apps/bots-dsh/src/client/details-drawer.js` — o painel do Bot repete `Not installed · motivo`.
- `apps/bots-dsh/src/client/i18n.js` — `Not installed` no dicionário chinês.
- `apps/locale-pt-br-dsh/src/client/locales/pt-BR/omni-ui.json` — `Not installed` → `Não instalado`.
- `apps/bots-dsh/client.js`, `client.pane.js` e `apps/locale-pt-br-dsh/client.js` — bundles gerados reconstruídos e commitados.
- Testes: `test/not-installed.test.js`, `test/bot-mark.test.js`, `test/sidebar-main-row.test.js`, `test/left-bar-status.test.js`.

O caso normal não mudou: um Bot instalado e ocioso continua `idle` (testes existentes e os novos cobrem isso).

## Gate — suíte completa (saída real)

Comando:

```
cd apps/bots-dsh && bun run test
```

Resultado:

```
ℹ tests 5393
ℹ pass 5245
ℹ fail 0
ℹ skipped 148
test-guard: complete run: plan 1..5232, 5232 top-level results, 5393 tests (5245 pass, 0 fail, 0 cancelled, 148 skipped, 0 todo), 392 files
EXIT:0
```

## Gate — lint (saída real)

Comando:

```
cd apps/bots-dsh && bun run lint
```

Resultado:

```
Found 137 warnings and 0 errors.
Finished in 61ms on 851 files with 97 rules using 32 threads.
EXIT:0
```

Os 137 warnings são os pré-existentes do pacote (avisos não falham no gate do repo).

## Gate — locale pt-BR (saída real)

```
cd apps/locale-pt-br-dsh && node --test test/coverage.test.js test/copy.test.js
ℹ tests 6
ℹ pass 6
ℹ fail 0
```

## Bundles

```
cd apps/bots-dsh && node scripts/build-client.mjs --check
# bots-dsh bundles current
cd apps/locale-pt-br-dsh && node scripts/build-client.mjs --check
# pt-BR bundle current
```

## CI

- **Conventional commits: FAIL.** O check acusou `9794d9e30 has a line over 100 characters` e `1db807835 has a line over 100 characters` (este último é o commit do #1430, que veio junto por a branch ser empilhada). Conforme a instrução do wish, **não houve amend nem force-push**; fica registrado aqui.
- `bots-dsh (plugin tests)` e `locale-pt-br-dsh (plugin tests)`: o locale passou; o bots-dsh ainda estava pendente quando este relatório foi escrito.
- O restante dos checks estava verde ou pendente no momento da escrita; o link do PR tem o estado ao vivo.

## Onde parei / o que falta

Nada de implementação: o gate local está verde e o PR está aberto contra `dev`, sem merge. O único vermelho é o `Conventional commits`, por linhas >100 no corpo de dois commits (um deles herdado do #1430), mantido sem reescrita de histórico como pedido.
