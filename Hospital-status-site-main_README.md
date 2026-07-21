# Status dos Sistemas — Hospital

Painel público e estático de status da infraestrutura crítica do hospital
(gerador, oxigênio, rede, prontuário eletrônico, elevadores, climatização,
água). Não existe login ou painel com senha no navegador de propósito — a
ideia é que qualquer pessoa possa consultar. A segurança de **quem pode
mudar o status** vem do próprio GitHub: login, 2FA e permissões de
colaborador (quem pode abrir uma Issue no repositório).

O site verifica `data/status.json` automaticamente a cada ~30 segundos e
atualiza a interface sozinho, sem precisar de F5.

## Estrutura

```
index.html                       → o site em si (lê config/services.json e data/status.json)
config/services.json             → fonte única: id, nome e URL de checagem de cada serviço
data/status.json                 → status atual, latência e histórico de cada sistema
scripts/snapshot.js              → registra o status do dia no histórico (diário)
scripts/validate.js              → valida o schema de status.json e services.json
scripts/apply-status-change.js   → interpreta a Issue de mudança de status
scripts/check-http.js            → checagem automática por HTTP (status + latência)
.github/ISSUE_TEMPLATE/          → formulário usado para reportar mudanças
.github/workflows/               → automações (Actions)
```

## Como o status muda

Ninguém edita `data/status.json` na mão. Existem dois caminhos, e em
**nenhum dos dois há Pull Request** — a mudança vai direto para o `main`
assim que a automação a valida:

### 1. Sistemas físicos (gerador, oxigênio, elevadores, climatização, água)

Esses sistemas não têm um sensor/API que o GitHub consiga consultar, então
a mudança continua vindo de uma pessoa — só que por um formulário, não por
edição direta de arquivo:

1. Abra uma **Issue** usando o template **"🔧 Atualizar status de um
   sistema"** (aba *Issues* → *New issue*).
2. Escolha o sistema e o novo status.
3. O workflow `update-status.yml` lê a Issue, aplica a mudança em
   `data/status.json` e faz **commit e push diretos** — o site já reflete
   a mudança em segundos.
4. A Issue é comentada e fechada automaticamente confirmando o resultado.

Isso elimina erro de digitação/formatação no JSON. A segurança vem de quem
pode abrir uma Issue no repositório (colaboradores autorizados).

### 2. Sistemas digitais (rede/internet, prontuário eletrônico)

Para esses dois, dá para checar automaticamente por HTTP — mas isso só
funciona se existir uma **URL pública** que reflita se o sistema está no
ar (ex.: a tela de login do prontuário, um endpoint de "health check" da
rede). Como isso ainda não está configurado, essa checagem está **pronta
mas desligada**.

**Para ativar quando tiver a URL**, edite `config/services.json`:

```json
{ "id": "prontuario", "name": "Prontuário Eletrônico (PEP)", "url": "https://prontuario.suaintranet.com.br/health", "enabled": true }
```

A partir daí, o workflow `auto-check.yml` roda **a cada 5 minutos** (o
mínimo suportado pelo GitHub Actions), faz a checagem, mede o tempo de
resposta (latência, em ms) e atualiza `data/status.json` sozinho:

- responde rápido e com sucesso → `ok`
- responde, mas devagar (>3s) ou com erro HTTP → `warn`
- não responde / timeout → `down`

**Importante:** os workflows do GitHub Actions rodam em servidores da
própria GitHub, fora da rede do hospital. Só é possível checar
automaticamente algo que tenha um endereço **acessível pela internet
pública**. Se `rede`/`prontuário` só existirem dentro da rede interna sem
nada exposto, não dá para checar de fora — nesse caso, um pequeno agente
rodando dentro da rede do hospital que reporta o status para o
repositório seria uma alternativa.

Enquanto a checagem automática de um sistema estiver desligada, ele
continua no modo manual (Issue) normalmente.

## Snapshot diário e histórico

Todo dia às 03h (`daily-snapshot.yml`), o status atual de cada sistema é
adicionado ao histórico (`history`) usado nas barrinhas de disponibilidade
do site, mantendo apenas os **7 registros mais recentes**. Cada registro
tem o formato:

```json
{ "status": "ok", "checkedAt": "2026-07-21T18:43:12Z", "responseTime": 153 }
```

`responseTime` vem da última checagem HTTP automática (`check-http.js`);
para sistemas sem checagem HTTP, fica `null`. Os campos `lastCheckedAt` e
`lastResponseTime` de cada serviço em `data/status.json` são atualizados
em tempo quase real a cada execução do `auto-check.yml` (a cada 5 min),
independentemente do snapshot diário.

## Como publicar (GitHub Pages)

1. Crie um repositório no GitHub (pode ser privado ou público).
2. Suba estes arquivos e faça o primeiro commit.
3. Em **Settings → Pages**, escolha a branch `main` e a pasta raiz (`/`)
   como fonte.
4. O site fica disponível em `https://<seu-usuario>.github.io/<repo>/`.

## Adicionando um novo serviço

1. Acrescente um item em `config/services.json` (`id`, `name`, `url`,
   `enabled`).
2. Acrescente o item correspondente (mesmo `id`) em `data/status.json`,
   com `status`, `lastCheckedAt`, `lastResponseTime` e um `history` inicial
   (pode ser um único registro).
3. Rode `node scripts/validate.js` localmente para conferir antes de
   commitar — ele valida que os dois arquivos batem.

## Configuração pendente

- **`CODEOWNERS`**: este arquivo era usado quando as mudanças passavam por
  Pull Request. Hoje o fluxo de Issue faz commit direto, então
  `CODEOWNERS` não é mais aplicado automaticamente por nenhum workflow —
  pode ser removido, ou mantido apenas como referência de quem são os
  responsáveis pelo sistema.
- **`config/services.json`**: preencher `url` + `enabled: true` quando
  houver um endpoint público para rede/prontuário.
