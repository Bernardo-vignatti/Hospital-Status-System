# Status dos Sistemas — Hospital

> ⚠️ **README provisório.** Atualizado a partir do estado atual do código
> (workflows, scripts e Cloudflare Worker) em 22/07/2026, principalmente
> para corrigir a descrição do fluxo de Issue: hoje ele passa por uma
> **fila de mudanças pendentes** (`data/pending-changes.json`), e não
> mais por aplicação/commit direto em `data/status.json`. Revise antes
> de considerar definitivo — em especial contatos/CODEOWNERS e o link do
> site publicado, que não é possível confirmar só a partir do código.

Painel público e estático de status da infraestrutura crítica do hospital
(gerador, oxigênio, rede, prontuário eletrônico, elevadores, climatização,
água). Sem login ou senha no navegador de propósito — qualquer pessoa pode
consultar. A segurança de **quem pode mudar o status** vem do próprio
GitHub: login, 2FA e permissões de colaborador (quem pode abrir uma Issue
no repositório).

O site (puro HTML/CSS/JS, sem frameworks) faz polling de `data/status.json`
a cada ~30 segundos e atualiza a interface sozinho, sem precisar de F5.

## Estrutura

```
index.html                              → lista de serviços (lê config/services.json e data/status.json, faz polling a cada ~30s)
servico.html                            → página de detalhe de UM serviço (servico.html?id=<id>), ver seção "Página de detalhes"
assets/css/common.css                   → estilos compartilhados por index.html e servico.html
assets/js/common.js                     → lógica compartilhada (status, disponibilidade, datas, tooltip do histórico)
config/services.json                    → fonte única: id, nome, url e enabled de cada serviço
data/status.json                        → updatedAt + histórico (até 30 registros) de cada serviço (fonte da verdade do status atual)
data/pending-changes.json               → fila de mudanças pendentes vindas de Issue, ainda não aplicadas ao ciclo
scripts/check-http.js                   → ciclo local (~5 min, fallback manual): checagem HTTP, heartbeat ou aplica fila, para TODOS os serviços
scripts/apply-status-change.js          → lê uma Issue e ENFILEIRA a mudança em data/pending-changes.json (não escreve status.json)
scripts/validate.js                     → valida o schema de status.json/pending-changes.json e a consistência com services.json
scripts/lib/history.js                  → utilitário compartilhado (adicionar registro ao histórico + cortar em 30)
scripts/lib/pending.js                  → utilitário compartilhado para ler/gravar/consumir a fila de mudanças pendentes
cloudflare-worker/                      → Worker com Cron Trigger (~5 min) que roda o ciclo de verdade, via GitHub Contents API
cloudflare-worker/src/index.js          → mesma lógica de check-http.js, lendo/gravando status.json e pending-changes.json remotamente
cloudflare-worker/wrangler.toml         → config do Worker (cron, owner/repo/branch do GitHub)
.github/ISSUE_TEMPLATE/status-update.yml→ formulário usado para reportar mudanças de status
.github/workflows/auto-check.yml        → hoje só com gatilho manual (workflow_dispatch) — fallback caso o Worker fique indisponível
.github/workflows/update-status.yml     → dispara ao abrir Issue → apply-status-change.js → registra na fila + fecha a Issue
.github/workflows/validate-status.yml   → valida status.json/services.json em PR e push
assets/hospital-fatima-logo.png         → logo do hospital, usada no topo das duas páginas
assets/screenshots/                     → capturas de tela usadas neste README
CODEOWNERS                              → vestigial (ver "Configuração pendente"), LICENSE → licença do repositório
```

## Página de detalhes de cada serviço

Além da lista (`index.html`), cada serviço tem sua própria página de status:
clicando em qualquer card da lista, o usuário é levado para
`servico.html?id=<id>` (ex.: `servico.html?id=site`), que mostra só os dados
daquele serviço.

<p align="center">
  <img src="assets/screenshots/lista-servicos.png" alt="Lista de serviços" width="270">
  &nbsp;&nbsp;
  <img src="assets/screenshots/detalhe-servico.png" alt="Página de detalhe de um serviço" width="270">
</p>

**Fluxo de navegação:** lista de serviços → clique no card → página de
detalhe do serviço → link "← Voltar" retorna à lista. Não há novidade de
back-end aqui: as duas páginas leem os mesmos `config/services.json` e
`data/status.json`, com o mesmo polling de ~30s — a página de detalhe só
filtra tudo para um único `id`, então ela nunca fica fora de sincronia com o
resto do sistema.

Na página de detalhe:

- **Estado atual** — nome do serviço, status colorido (mesmas 4 cores/estados
  do restante do site) e há quanto tempo está nesse estado.
- **Histórico** — a mesma barra de verificações da lista, só que maior, com
  tooltip ao tocar/passar o mouse mostrando horário exato (e tempo de
  resposta, quando disponível).
- **Disponibilidade** — cartões com o percentual de uptime em 24h, 7 dias,
  30 dias e 90 dias, calculados sobre o histórico real do serviço (mesma
  regra de `up`/`down`/`maint` descrita em ["Disponibilidade
  (%)"](#disponibilidade-)). Como o histórico guarda só os **30 registros
  mais recentes** (ver ["Timeline sincronizada"](#timeline-sincronizada-histórico)),
  janelas mais longas (30/90 dias) mostram "—" em vez de um número até que o
  sistema acumule dado real cobrindo esse período — nunca um valor estimado.

O design é propositalmente minimalista: poucas palavras, hierarquia clara
(estado → histórico → disponibilidade) e o mesmo espaçamento generoso do
restante do site, para o status ficar claro num único olhar em qualquer
tamanho de tela (celular, tablet, notebook ou monitor grande).

**Arquitetura:** `index.html` e `servico.html` compartilham
`assets/css/common.css` (visual) e `assets/js/common.js` (cálculo de
disponibilidade, formatação de datas/horas, leitura dos JSONs e tooltip do
histórico) — a lógica não é duplicada entre as duas páginas, só reutilizada.

## Fluxo completo

Existem **duas formas** de um status mudar, e em **nenhuma delas há Pull
Request** — tudo vai direto para o `main` assim que a automação valida.
As duas convergem no mesmo ciclo de ~5 minutos, que é o único momento em
que `data/status.json` é escrito e a timeline de **todos** os serviços
avança junto (ver ["Timeline sincronizada"](#timeline-sincronizada-histórico)):

- a **checagem automática** (Cloudflare Worker) roda esse ciclo a cada
  tick, verificando serviços com URL pública;
- uma **Issue** não escreve `status.json` diretamente — ela só registra a
  intenção de mudança em `data/pending-changes.json` (fila), que o
  próximo tick do ciclo lê e consome. Isso existe para que o sistema
  tenha um único "relógio": uma Issue pode chegar a qualquer momento,
  mas nunca reinicia, adianta ou atrasa o cronograma de 5 minutos.

```mermaid
flowchart TD
    F["🧑 Issue aberta<br/>(status-update.yml)"] --> G["update-status.yml"]
    G --> H["apply-status-change.js"]
    H --> P["data/pending-changes.json<br/>(fila — commit direto, sem PR)"]

    A["⏱️ Cron a cada 5 min<br/>(Cloudflare Worker)"] --> B["mesma lógica de check-http.js"]
    P -.->|"lida no próximo tick"| B
    B -->|"há mudança pendente"| Q["Consome a fila:<br/>aplica o status enfileirado"]
    B -->|"sem pendência,<br/>enabled:true + url"| C["Checagem HTTP real<br/>(up/down + latência)"]
    B -->|"sem pendência,<br/>enabled:false"| D["Heartbeat<br/>(repete o status atual)"]
    Q --> E["data/status.json<br/>+1 registro em TODOS os serviços"]
    C --> E
    D --> E

    E --> J["commit + push direto via<br/>GitHub Contents API (sem PR)"]
    J --> K["GitHub Pages"]
    K --> L["index.html faz polling<br/>a cada ~30s e atualiza a UI"]
```

### 1. Automático — todos os serviços, a cada 5 minutos (Cloudflare Worker)

O ciclo de atualização de ~5 min roda **fora do GitHub Actions**, num
**Cloudflare Worker** (pasta `/cloudflare-worker`) com **Cron Trigger**,
100% online e de graça no plano Free — sem VPS, Raspberry Pi ou PC
pessoal ligado. Motivo: o agendador interno do GitHub Actions
(`schedule:`) não garante pontualidade em intervalos curtos como `*/5
* * * *` — na prática o intervalo real observado variou de ~15 min a
mais de 1h de silêncio total, sem gerar nenhum erro visível. O Cron
Trigger da Cloudflare (mínimo de 1 min) não sofre desse problema.

O Worker faz, a cada tick, exatamente a mesma lógica que
`scripts/check-http.js` fazia localmente — só que lendo/escrevendo
`data/status.json` e `data/pending-changes.json` via **GitHub Contents
API** em vez de arquivo local + `git`:

- Se houver uma **mudança manual pendente** (registrada por uma Issue,
  ver seção 2) → aplica esse status e consome a entrada da fila.
- Senão, `enabled: true` **e** `url` preenchida → checagem HTTP real
  (latência + `up`/`down`).
- Senão → *heartbeat*: repete o último status conhecido.

**Configuração (uma vez só):**

1. Crie uma conta gratuita na [Cloudflare](https://dash.cloudflare.com/sign-up)
   (não precisa cartão de crédito para o plano Free de Workers).
2. No GitHub, crie um **Personal Access Token fine-grained** (Settings →
   Developer settings → Fine-grained tokens) limitado a este repositório,
   com permissão **Contents: Read and write**.
3. Na pasta `cloudflare-worker/`, rode:
   ```
   npm install
   npx wrangler login
   npx wrangler secret put GITHUB_TOKEN        # cole o token do passo 2
   npx wrangler secret put MANUAL_TRIGGER_SECRET  # qualquer string, só pra testes manuais
   npx wrangler deploy
   ```
4. Pronto — o Worker já fica rodando no Cron Trigger de 5 em 5 min.
   Para testar sem esperar o próximo tick:
   ```
   curl -X POST https://hospital-status-cycle.<seu-subdomínio>.workers.dev/run \
     -H "Authorization: Bearer <o MANUAL_TRIGGER_SECRET que você definiu>"
   ```
5. Para acompanhar logs em tempo real: `npx wrangler tail`.

**Para ativar a checagem HTTP** quando houver uma URL pública, edite
`config/services.json` normalmente (`enabled: true` + `url`) e dê push —
o Worker lê a config a cada tick, sem precisar redeploy.

> **Importante:** só é possível checar automaticamente algo com endereço
> **acessível pela internet pública** — o Worker roda na rede da
> Cloudflare, então serviços só acessíveis pela rede interna do
> hospital (sem nada exposto publicamente) continuam precisando de
> atualização manual via Issue (seção 2).

**Fallback manual:** `auto-check.yml` continua existindo no GitHub
Actions, só com gatilho manual (`workflow_dispatch`, sem `schedule`) —
aba *Actions* → `auto-check.yml` → *Run workflow*. Serve de rede de
segurança se o Worker ficar indisponível (token expirado, conta
suspensa, etc.).

### 2. Manual — via Issue (fila de pendências)

Sistemas físicos (gerador, oxigênio, elevadores, climatização, água) não
têm sensor/API pública para o GitHub consultar, então a mudança de status
continua vindo de uma pessoa — só que por formulário, não por edição
direta do JSON, e não é aplicada instantaneamente:

1. Abra uma **Issue** usando o template **"🔧 Atualizar status de um
   sistema"** (aba *Issues* → *New issue*).
2. Escolha o sistema e o novo status (**Operante**, **Inoperante**,
   **Manutenção** ou **Desconhecido**).
3. O workflow `update-status.yml` lê a Issue e chama
   `apply-status-change.js`, que **não escreve em `data/status.json`** —
   ele só registra a mudança em `data/pending-changes.json` (a fila) e
   faz **commit e push diretos** dessa fila (sem Pull Request).
4. A Issue é comentada (avisando que a mudança entrou na fila e será
   aplicada no próximo ciclo, em até ~5 min) e fechada automaticamente.
5. No **próximo tick** do ciclo automático (seção 1), o Worker lê a fila,
   aplica o status enfileirado a esse serviço — e só então o site
   reflete a mudança, junto com o avanço da timeline de todos os demais
   serviços.

Esse desenho existe para manter um **relógio único**: como uma Issue pode
ser aberta a qualquer momento, ela nunca escreve diretamente na timeline
nem a faz avançar fora de hora — ela só entra na fila, e quem avança a
timeline é sempre o ciclo de ~5 min.

A segurança vem de quem pode abrir uma Issue no repositório (colaboradores
autorizados); o formulário elimina erro de digitação/formatação no JSON.

## Estados possíveis

Cada serviço tem exatamente um de 4 estados, sempre igual ao último item
do seu `history`:

| Estado | Código | Cor | Como é definido |
|---|---|---|---|
| Operante | `up` | 🟢 verde | Checagem HTTP com sucesso, ou reportado via Issue |
| Inoperante | `down` | 🔴 vermelho | Checagem HTTP com erro/timeout, ou reportado via Issue |
| Manutenção | `maint` | 🟡 amarelo | Só via Issue — sinaliza indisponibilidade planejada |
| Desconhecido | `unknown` | ⚪ cinza | Só via Issue — ausência de dado confiável |

`maint` e `unknown` só são atribuídos manualmente, nunca por
`check-http.js` (uma checagem HTTP real só pode resultar em `up` ou
`down`). No **cálculo de disponibilidade** (ver abaixo), `maint` conta
como indisponibilidade (o serviço está de fato fora do ar nesse
período); só `unknown` fica de fora da conta, por ser ausência de dado
confiável em vez de uma medição.

## Timeline sincronizada (histórico)

Cada serviço guarda os **30 registros mais recentes** em `history` (mais
antigo primeiro, mais recente por último — é essa última posição que
aparece na ponta direita da barra no site). Cada registro:

```json
{ "status": "up", "checkedAt": "2026-07-22T18:43:12Z", "responseTime": 153 }
```

**Toda atualização — automática ou manual — avança a timeline de TODOS os
serviços na mesma execução, com o mesmo `checkedAt`:**

- o serviço que teve mudança real (checagem HTTP ou Issue) grava esse novo
  estado;
- todos os demais gravam um registro repetindo o estado em que já
  estavam (heartbeat).

Isso garante que as barras de histórico de todos os cards fiquem sempre
com o mesmo número de posições, sincronizadas entre si — nunca uma barra
"atrasada" em relação às outras.

`responseTime` vem da checagem HTTP mais recente; para heartbeats e
mudanças manuais via Issue, fica `null`.

### Disponibilidade (%)

Calculada sobre os registros `up`/`down`/`maint` dentre os 30 — `maint`
entra no denominador e conta como indisponibilidade (não como sucesso),
já que o serviço está de fato fora do ar nesse período. Só `unknown`
fica fora da conta, por ser ausência de medição confiável, não uma
falha. Se não houver nenhum registro `up`/`down`/`maint`, o site mostra
"sem dados suficientes" em vez de 0%. O valor exibido é arredondado
para um número inteiro (sem casas decimais) e colorido conforme o
estado atual do serviço.

## Como publicar (GitHub Pages)

1. Crie um repositório no GitHub (pode ser privado ou público).
2. Suba estes arquivos e faça o primeiro commit **na branch padrão**
   (`main`) — GitHub só dispara `schedule` de workflows para arquivos
   presentes na branch padrão.
3. Em **Settings → Actions → General → Workflow permissions**, confirme
   "Read and write permissions" (o workflow já declara
   `permissions: contents: write`, mas vale checar no repo).
4. Em **Settings → Pages**, escolha a branch `main` e a pasta raiz (`/`)
   como fonte.
5. O site fica disponível em `https://<seu-usuário>.github.io/<repo>/`.

## Adicionando um novo serviço

1. Acrescente um item em `config/services.json` (`id`, `name`, `url`,
   `enabled`).
2. Acrescente o item correspondente (mesmo `id`) em `data/status.json`,
   com um `history` inicial (pode ser um único registro, ex.:
   `{"status":"up","checkedAt":"<agora em ISO 8601>","responseTime":null}`).
3. Rode `node scripts/validate.js` localmente para conferir antes de
   commitar — ele valida que os dois arquivos batem e que todo `status`
   usado é um dos 4 estados válidos.

Não é preciso nenhum passo extra para a página de detalhe: o card na lista e
`servico.html?id=<id>` já funcionam para o novo serviço assim que os dois
arquivos acima forem atualizados, porque ambas as páginas leem os mesmos
`config/services.json`/`data/status.json` em vez de ter algo hardcoded por
serviço.

## Configuração pendente

- **`CODEOWNERS`**: vestigial — o fluxo de Issue faz commit direto, então
  este arquivo não é mais aplicado por nenhum workflow. Pode ser removido
  ou mantido só como referência de responsáveis pelo sistema.
- **`config/services.json`**: preencher `url` + `enabled: true` quando
  houver um endpoint público para `rede` e/ou `prontuário` — os únicos
  dois que fazem sentido checar por HTTP (os demais são físicos).
