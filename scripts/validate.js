// Valida o schema de data/status.json e sua consistência com
// config/services.json (fonte única de id/nome/url dos serviços).

const fs = require('fs');
const path = require('path');
const { MAX_HISTORY } = require('./lib/history');

const STATUS_FILE = path.join(__dirname, '..', 'data', 'status.json');
const CONFIG_FILE = path.join(__dirname, '..', 'config', 'services.json');
const VALID_STATUS = ['up', 'down', 'unknown'];

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

console.log(`✅ data/status.json e config/services.json são válidos (${data.services.length} serviços).`);
