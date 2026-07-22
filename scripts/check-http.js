// Checagem automática por HTTP para sistemas digitais (ex.: rede, prontuário).
//
// Lê config/services.json. Para cada serviço com "enabled": true e uma
// "url" preenchida, faz uma requisição, mede a latência (ms) e classifica
// em um dos 3 estados possíveis:
//   - resposta HTTP ok  -> "up"          (Operante)
//   - erro ou timeout   -> "down"        (Inoperante)
//
// Cada execução adiciona UM novo segmento ao histórico do serviço (a
// verificação em si), mantendo só os 30 mais recentes — é assim que a
// barra de histórico do site é alimentada em tempo real.
//
// Serviços sem URL configurada (enabled=false) são ignorados e continuam
// dependentes de report manual via Issue.

const fs = require('fs');
const path = require('path');
const { pushHistoryEntry, currentStatus } = require('./lib/history');

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

  const active = config.services.filter((cfg) => cfg.enabled && cfg.url);
  if (active.length === 0) {
    console.log('ℹ️  Nenhum serviço com checagem automática habilitada em config/services.json.');
    return;
  }

  const now = new Date().toISOString();

  for (const cfg of active) {
    const service = data.services.find((s) => s.id === cfg.id);
    if (!service) {
      console.warn(`⚠️  "${cfg.id}" está em config/services.json mas não em data/status.json.`);
      continue;
    }

    const before = currentStatus(service);
    const { status, responseTime } = await checkOne(cfg.url);

    pushHistoryEntry(service, { status, checkedAt: now, responseTime });

    console.log(
      before === status
        ? `${cfg.name}: sem mudança (${status}, ${responseTime}ms)`
        : `${cfg.name}: ${before} → ${status} (${responseTime}ms)`
    );
  }

  data.updatedAt = now;
  fs.writeFileSync(STATUS_FILE, JSON.stringify(data, null, 2) + '\n');
  console.log('✅ status.json atualizado.');
}

main();
