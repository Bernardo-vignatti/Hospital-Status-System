// Ciclo único de atualização (~5 min, via auto-check.yml). Este é o ÚNICO
// script que escreve data/status.json — ou seja, o único que avança a
// timeline. Para cada serviço, na ordem de prioridade abaixo:
//
//   1. Mudança manual pendente (data/pending-changes.json, gravada por
//      apply-status-change.js quando uma Issue é processada) -> aplica
//      esse status e CONSOME a entrada da fila. Uma mudança manual vence
//      mesmo para serviços com checagem HTTP automática habilitada,
//      porque "maint"/"unknown" só existem via Issue (nunca resultam de
//      uma checagem HTTP real).
//   2. "enabled": true e "url" preenchida -> checagem HTTP real: mede a
//      latência (ms) e classifica em "up" (resposta ok) ou "down"
//      (erro/timeout).
//   3. Caso contrário -> heartbeat: repete o último status conhecido,
//      sem checagem HTTP, mantendo o serviço em modo manual.
//
// Cada execução adiciona UM novo segmento ao histórico de CADA serviço,
// todos com o mesmo "checkedAt" — a fila é sempre esvaziada ao final,
// então uma Issue processada entre dois ciclos nunca cria um segmento
// "extra" fora de cadência: ela só é refletida no próximo tick regular.

const fs = require('fs');
const path = require('path');
const { pushHistoryEntry, currentStatus } = require('./lib/history');
const { readPending, writePending } = require('./lib/pending');

const STATUS_FILE = path.join(__dirname, '..', 'data', 'status.json');
const CONFIG_FILE = path.join(__dirname, '..', 'config', 'services.json');

const TIMEOUT_MS = 8000;

async function checkOne(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const start = Date.now();
  try {
    const res = await fetch(url, { method: 'GET', signal: controller.signal });
    const responseTime = Date.now() - start;
    return { status: res.ok ? 'up' : 'down', responseTime };
  } catch (e) {
    return { status: 'down', responseTime: Date.now() - start };
  } finally {
    clearTimeout(timeout);
  }
}

async function main() {
  const config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  const data = JSON.parse(fs.readFileSync(STATUS_FILE, 'utf8'));
  const pending = readPending();

  const now = new Date().toISOString();

  for (const cfg of config.services) {
    const service = data.services.find((s) => s.id === cfg.id);
    if (!service) {
      console.warn(`⚠️  "${cfg.id}" está em config/services.json mas não em data/status.json.`);
      continue;
    }

    const before = currentStatus(service);
    const queued = pending.changes[cfg.id];

    if (queued) {
      pushHistoryEntry(service, { status: queued.status, checkedAt: now, responseTime: null });
      console.log(
        `${cfg.name}: mudança manual aplicada (${before} → ${queued.status}, via Issue #${queued.issueNumber ?? '?'})`
      );
      delete pending.changes[cfg.id];
    } else if (cfg.enabled && cfg.url) {
      const { status, responseTime } = await checkOne(cfg.url);
      pushHistoryEntry(service, { status, checkedAt: now, responseTime });
      console.log(
        before === status
          ? `${cfg.name}: sem mudança (${status}, ${responseTime}ms)`
          : `${cfg.name}: ${before} → ${status} (${responseTime}ms)`
      );
    } else {
      pushHistoryEntry(service, { status: before, checkedAt: now, responseTime: null });
      console.log(`${cfg.name}: heartbeat (${before}, sem checagem HTTP — modo manual)`);
    }
  }

  data.updatedAt = now;
  fs.writeFileSync(STATUS_FILE, JSON.stringify(data, null, 2) + '\n');
  writePending(pending);
  console.log('✅ status.json atualizado e fila de mudanças pendentes processada.');
}

main();
