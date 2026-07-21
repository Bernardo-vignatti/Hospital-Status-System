// Checagem automática por HTTP para sistemas digitais (ex.: rede, prontuário).
//
// Lê config/services.json. Para cada serviço com "enabled": true e uma "url"
// preenchida, faz uma requisição, mede a latência (ms) e classifica:
//   - resposta OK e rápida  -> "ok"
//   - resposta OK mas lenta -> "warn"
//   - erro ou timeout       -> "down"
//
// Atualiza status/lastCheckedAt/lastResponseTime em tempo (quase) real a
// cada execução (a cada 5 min via auto-check.yml). Não escreve no
// "history" — isso é feito uma vez por dia por scripts/snapshot.js, para
// manter o histórico compacto.
//
// Serviços sem URL configurada (enabled=false) são ignorados e continuam
// dependentes de report manual via Issue.

const fs = require('fs');
const path = require('path');

const STATUS_FILE = path.join(__dirname, '..', 'data', 'status.json');
const CONFIG_FILE = path.join(__dirname, '..', 'config', 'services.json');

const TIMEOUT_MS = 8000;
const SLOW_THRESHOLD_MS = 3000;

async function checkOne(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const start = Date.now();
  try {
    const res = await fetch(url, { method: 'GET', signal: controller.signal });
    const responseTime = Date.now() - start;
    if (!res.ok) return { status: 'down', responseTime };
    return { status: responseTime > SLOW_THRESHOLD_MS ? 'warn' : 'ok', responseTime };
  } catch (e) {
    return { status: 'down', responseTime: Date.now() - start };
  } finally {
    clearTimeout(timeout);
  }
}

async function main() {
  const config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  const data = JSON.parse(fs.readFileSync(STATUS_FILE, 'utf8'));

  const active = config.services.filter((cfg) => cfg.enabled && cfg.url);
  if (active.length === 0) {
    console.log('ℹ️  Nenhum serviço com checagem automática habilitada em config/services.json.');
    return;
  }

  let changed = false;
  const now = new Date().toISOString();

  for (const cfg of active) {
    const service = data.services.find((s) => s.id === cfg.id);
    if (!service) {
      console.warn(`⚠️  "${cfg.id}" está em config/services.json mas não em data/status.json.`);
      continue;
    }

    const { status: newStatus, responseTime } = await checkOne(cfg.url);

    if (service.status !== newStatus) {
      console.log(`${cfg.name}: ${service.status} → ${newStatus} (${responseTime}ms)`);
    } else {
      console.log(`${cfg.name}: sem mudança de status (${newStatus}, ${responseTime}ms)`);
    }

    service.status = newStatus;
    service.lastCheckedAt = now;
    service.lastResponseTime = responseTime;
    changed = true;
  }

  if (changed) {
    data.updatedAt = now;
    fs.writeFileSync(STATUS_FILE, JSON.stringify(data, null, 2) + '\n');
    console.log('✅ status.json atualizado.');
  }
}

main();
