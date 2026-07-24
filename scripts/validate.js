// Valida o schema de data/status.json e sua consistência com
// config/services.json (fonte única de id/nome/url dos serviços).

const fs = require('fs');
const path = require('path');
const { MAX_HISTORY } = require('./lib/history');

const STATUS_FILE = path.join(__dirname, '..', 'data', 'status.json');
const CONFIG_FILE = path.join(__dirname, '..', 'config', 'services.json');
const PENDING_FILE = path.join(__dirname, '..', 'data', 'pending-changes.json');
const VALID_STATUS = ['up', 'down', 'maint', 'unknown'];

function fail(msg) {
  console.error('❌ Falha na validação: ' + msg);
  process.exit(1);
}

function readJson(file, label) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (e) {
    fail(`não foi possível ler ${label} (${e.message})`);
  }
  try {
    return JSON.parse(raw);
  } catch (e) {
    fail(`${label}: JSON inválido (${e.message})`);
  }
}

const config = readJson(CONFIG_FILE, 'config/services.json');
const data = readJson(STATUS_FILE, 'data/status.json');

if (!Array.isArray(config.services) || config.services.length === 0) {
  fail('config/services.json: "services" precisa ser uma lista não vazia');
}

const configIds = new Set();
config.services.forEach((s, i) => {
  const ctx = `config/services.json services[${i}]`;
  if (!s.id || typeof s.id !== 'string') fail(`${ctx}: "id" ausente ou inválido`);
  if (configIds.has(s.id)) fail(`${ctx}: "id" duplicado`);
  configIds.add(s.id);
  if (!s.name || typeof s.name !== 'string') fail(`${ctx}: "name" ausente ou inválido`);
  if (typeof s.enabled !== 'boolean') fail(`${ctx}: "enabled" precisa ser booleano`);
  if (s.enabled && !s.url) fail(`${ctx}: "enabled" é true mas "url" está vazia`);
});

if (!data.updatedAt || isNaN(Date.parse(data.updatedAt))) {
  fail('data/status.json: "updatedAt" ausente ou não é uma data válida');
}
if (!Array.isArray(data.services) || data.services.length === 0) {
  fail('data/status.json: "services" precisa ser uma lista não vazia');
}

const seenIds = new Set();
data.services.forEach((s, i) => {
  const ctx = `data/status.json services[${i}] (${s.id || 'sem id'})`;
  if (!s.id || typeof s.id !== 'string') fail(`${ctx}: "id" ausente ou inválido`);
  if (seenIds.has(s.id)) fail(`${ctx}: "id" duplicado`);
  seenIds.add(s.id);
  if (!configIds.has(s.id)) fail(`${ctx}: "id" não existe em config/services.json`);

  if (!Array.isArray(s.history) || s.history.length === 0) fail(`${ctx}: "history" precisa ser uma lista não vazia`);
  if (s.history.length > MAX_HISTORY) fail(`${ctx}: "history" tem mais de ${MAX_HISTORY} registros (${s.history.length})`);
  if (s.status !== undefined) fail(`${ctx}: campo "status" não deve mais existir (o status atual é sempre o último item de "history")`);

  s.history.forEach((h, j) => {
    const hctx = `${ctx} history[${j}]`;
    if (typeof h !== 'object' || h === null) fail(`${hctx}: precisa ser um objeto {status, checkedAt, responseTime}`);
    if (!VALID_STATUS.includes(h.status)) fail(`${hctx}: "status" inválido "${h.status}" (esperado: ${VALID_STATUS.join(', ')})`);
    if (!h.checkedAt || isNaN(Date.parse(h.checkedAt))) fail(`${hctx}: "checkedAt" ausente ou inválido`);
    if (h.responseTime != null && typeof h.responseTime !== 'number') {
      fail(`${hctx}: "responseTime" precisa ser número ou null`);
    }
  });
});

configIds.forEach((id) => {
  if (!seenIds.has(id)) fail(`config/services.json define "${id}" mas ele não existe em data/status.json`);
});

// data/pending-changes.json: fila de mudanças manuais ainda não aplicadas
// pelo ciclo de auto-check. Opcional (pode não existir ainda em repos
// antigos), mas se existir precisa ter o formato certo.
if (fs.existsSync(PENDING_FILE)) {
  const pending = readJson(PENDING_FILE, 'data/pending-changes.json');
  if (typeof pending.changes !== 'object' || pending.changes === null || Array.isArray(pending.changes)) {
    fail('data/pending-changes.json: "changes" precisa ser um objeto');
  }
  Object.entries(pending.changes).forEach(([serviceId, change]) => {
    const ctx = `data/pending-changes.json changes["${serviceId}"]`;
    if (!configIds.has(serviceId)) fail(`${ctx}: id não existe em config/services.json`);
    if (typeof change !== 'object' || change === null) fail(`${ctx}: precisa ser um objeto {status, requestedAt, issueNumber}`);
    if (!VALID_STATUS.includes(change.status)) fail(`${ctx}: "status" inválido "${change.status}"`);
    if (!change.requestedAt || isNaN(Date.parse(change.requestedAt))) fail(`${ctx}: "requestedAt" ausente ou inválido`);
    if (change.issueNumber != null && typeof change.issueNumber !== 'number') fail(`${ctx}: "issueNumber" precisa ser número ou null`);
  });
}


// ---------------------------------------------------------------------
// Consistência entre o formulário de Issue e config/services.json.
//
// Por que isso existe: as opções do dropdown em
// .github/ISSUE_TEMPLATE/status-update.yml são texto estático. Se alguém
// renomear um serviço em config/services.json (ou acrescentar um novo) e
// esquecer do formulário, a atualização via Issue passa a falhar EM
// SILÊNCIO para aquele serviço — a pessoa reporta "gerador inoperante" e
// o painel continua verde. Este check quebra o CI nesse caso.
// Parsing simples de linhas (sem dependência externa, roda em Node puro).
// ---------------------------------------------------------------------
const TEMPLATE_FILE = path.join(
  __dirname, '..', '.github', 'ISSUE_TEMPLATE', 'status-update.yml'
);

function normalizeLabel(str) {
  return String(str)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function readDropdownOptions(lines, fieldId) {
  const idIdx = lines.findIndex((l) => l.trim() === `id: ${fieldId}`);
  if (idIdx === -1) return null;
  const optIdx = lines.findIndex((l, i) => i > idIdx && l.trim() === 'options:');
  if (optIdx === -1) return null;
  const options = [];
  for (let i = optIdx + 1; i < lines.length; i++) {
    const m = lines[i].match(/^\s+-\s+(.+?)\s*$/);
    if (!m) break;
    options.push(m[1].replace(/^["']|["']$/g, ''));
  }
  return options;
}

if (fs.existsSync(TEMPLATE_FILE)) {
  const lines = fs.readFileSync(TEMPLATE_FILE, 'utf8').split('\n');
  const templateSystems = readDropdownOptions(lines, 'sistema');

  if (!templateSystems || templateSystems.length === 0) {
    fail('não consegui ler as opções do dropdown "sistema" em .github/ISSUE_TEMPLATE/status-update.yml');
  }

  const configNames = new Map(
    config.services.map((s) => [normalizeLabel(s.name), s.name])
  );

  templateSystems.forEach((opt) => {
    if (!configNames.has(normalizeLabel(opt))) {
      fail(
        `ISSUE_TEMPLATE oferece "${opt}", que não corresponde a nenhum "name" em ` +
        `config/services.json. Isso faria a atualização via Issue falhar em silêncio. ` +
        `Nomes válidos: ${config.services.map((s) => s.name).join(' | ')}`
      );
    }
  });

  const templateSet = new Set(templateSystems.map(normalizeLabel));
  config.services.forEach((s) => {
    if (!templateSet.has(normalizeLabel(s.name))) {
      fail(
        `o serviço "${s.name}" existe em config/services.json mas não aparece no ` +
        `dropdown de .github/ISSUE_TEMPLATE/status-update.yml — ninguém conseguiria ` +
        `reportar mudança de status dele.`
      );
    }
  });

  const statusOptions = readDropdownOptions(lines, 'status');
  const VALID_LABELS = ['operante', 'inoperante', 'manutencao', 'desconhecido'];
  (statusOptions || []).forEach((opt) => {
    if (!VALID_LABELS.includes(normalizeLabel(opt))) {
      fail(`ISSUE_TEMPLATE oferece o status "${opt}", que scripts/apply-status-change.js não sabe traduzir.`);
    }
  });
}

console.log(`✅ status.json, services.json e o formulário de Issue estão consistentes (${data.services.length} serviços).`);
