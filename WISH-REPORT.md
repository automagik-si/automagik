# Wish report — não mostrar "Messaged X" quando o host recusou

- **PR:** https://github.com/automagik-si/automagik/pull/1447 (base `dev`, sem merge)
- **Branch:** `wish/nao-mostrar-messaged-x-quando-o-host-rec`
- **Commit da correção:** `ee7b1c26` — `fix(bots-dsh): show the host refusal instead of "Messaged" when a message was not sent`
- **Base do PR:** `origin/dev` = `7a1a7a9162dbaf30b788610d6e923ae4f9a20c9e`
- **Repo:** `/mnt/ai/automagik` (trabalhado só na cópia/worktree; o checkout compartilhado não foi alterado)

## Mudança de comportamento (antes -> depois)

**Antes:** uma recusa do host devolvida como resultado normal do `message_bot`
(`No Bot named X…`, `Not sent: X is waiting for the result of the work you are doing…`,
mensagem longa, forward de imagem, `request_id` expirado) aparecia no chat como
**"Messaged X"**, como se a mensagem tivesse saído.
**Depois:** a linha mostra a própria recusa do host (o `reason` publicado em
`call.meta`), e só um envio real continua mostrando **"Messaged X"**.

## O que mudou

- `apps/bots-dsh/src/host/tools.js`
  - `message_bot` passa a declarar um `output` próprio (`messageOutput`) cujo schema
    aceita `string` (envio) **ou** `{ text, sent: false, reason }` (recusa).
  - `render` devolve exatamente o mesmo texto que o Bot lia antes; o envio continua
    devolvendo a mesma string, sem mudança no contrato de sucesso.
  - `presentationMeta` publica `{ sent: true }` no envio e `{ sent: false, reason }`
    na recusa; a decisão é estruturada, não por prefixo de string.
  - Todas as recusas que retornavam texto normal foram marcadas: Bot inexistente,
    mensagem para si mesmo, mensagem vazia, `request_id` longo/expirado, mais de 4
    imagens, forward de imagem, imagem não encontrada, mensagem longa demais e o Bot
    que espera o resultado do trabalho em andamento.
  - Recusas que já eram `throw` (`request_id` conflitante/incerto/readonly, membro
    fora do grupo, trabalho já chamado no grupo) continuam falhando como antes: já
    apareciam como falha, nunca como "Messaged X".
- `apps/bots-dsh/src/client/cells.js`
  - O case `message_bot` lê `call.meta.sent === false` e desenha o motivo do host na
    linha de erro; sem esse sinal, um envio segue desenhando `Messaged X`. O
    fallback `Couldn't message {name}` fica para erros sem o sinal.
- `apps/bots-dsh/client.js`
  - Bundle gerado novamente com `bun run build` (commitado, como o AGENTS.md manda).
- Testes:
  - `apps/bots-dsh/test/tool-cells.test.js` — teste de cliente (red primeiro):
    recusa direta e dentro de programa PTC mostram o motivo e não "Messaged";
    envio com `sent: true` continua "Messaged".
  - `apps/bots-dsh/test/bot-messages.test.js` — testes de host: a recusa do Bot que
    espera o resultado carrega `sent:false` + `reason` e renderiza o mesmo texto;
    um envio continua string e publica `{ sent: true }`.
  - Ajustes de asserção (`.text` / `.sent`) em `own-keys`, `request-id` e
    `upload-access`, que comparavam o resultado antigo (string) das recusas.

## Evidência do red (antes da correção, saída real)

Comando:

```sh
cd apps/bots-dsh
node --import ./test/harness-resolve.mjs --test --test-timeout=120000 \
  test/tool-cells.test.js test/bot-messages.test.js
```

Saída (trecho real):

```text
test at test/bot-messages.test.js:649:1
✖ a message_bot refusal carries the host's reason as a result the chat can tell from a sent one (16.145305ms)
  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:

  'string' !== 'object'

      at TestContext.<anonymous> (file:///.../apps/bots-dsh/test/bot-messages.test.js:656:10)
  ...

test at test/tool-cells.test.js:316:1
✖ a message_bot refusal shows the host's reason instead of "Messaged" (0.647048ms)
  AssertionError [ERR_ASSERTION]: The input was expected to not match the regular expression /Messaged/. Input:

  'MessagedWriter'

      at TestContext.<anonymous> (file:///.../apps/bots-dsh/test/tool-cells.test.js:320:10)

ℹ tests 126
ℹ pass 124
ℹ fail 2
```

## Suíte completa (saída real, depois da correção)

Comando (dentro de `apps/bots-dsh`, como o gate do repo manda):

```sh
bun run test
```

Saída final real:

```text
ℹ tests 5386
ℹ suites 23
ℹ pass 5238
ℹ fail 0
ℹ cancelled 0
ℹ skipped 148
ℹ todo 0
ℹ duration_ms 32344.332964
test-guard: complete run: plan 1..5225, 5225 top-level results, 5386 tests (5238 pass, 0 fail, 0 cancelled, 148 skipped, 0 todo), 391 files
```

O `test-guard` confirma o plano 1..5225 com 5225 resultados top-level; a suíte
inteira do pacote passou.

## Lint (saída real)

Comando:

```sh
bun run lint
```

Saída final real:

```text
Found 137 warnings and 0 errors.
Finished in 75ms on 849 files with 97 rules using 32 threads.
```

Os 137 warnings são pré-existentes (nenhum vem das linhas alteradas) e o lint não
tem erros.

## Publicação

- Branch enviada: `wish/nao-mostrar-messaged-x-quando-o-host-rec` (`git push upstream HEAD:...`).
- PR #1447 aberto contra `dev`, estado `OPEN`, `mergeable: MERGEABLE`.
- Sem merge, sem amend, sem force-push, sem push em `main`, sem alteração de outra branch.

## Observação sobre a base

O worktree foi semeado em `26d6b8bfe620` (“Genie starts here”), que neste clone é um
**commit raiz de árvore vazia** — não havia código do projeto nele. Para implementar
o wish, a branch foi baseada no `origin/dev` real (`7a1a7a91…`, de
`/mnt/ai/automagik` → GitHub), sem tocar no checkout compartilhado. O PR sai contra
`dev` a partir dessa base atual.
