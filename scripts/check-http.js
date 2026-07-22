// Atualização automática de status a cada 5 minutos, para TODOS os serviços.
//
// Lê config/services.json. Para cada serviço:
//   - "enabled": true e "url" preenchida  -> a URL é válida para checagem
//     automática: faz uma requisição HTTP real, mede a latência (ms) e
//     classifica em "up" (resposta ok) ou "down" (erro/timeout).
//   - "enabled": false (ou sem "url")     -> a URL não é usada (ou não
//     existe); o serviço permanece em modo manual (só muda de status via
//     Issue), mas AINDA ASSIM ganha um novo registro a cada execução,
//     repetindo o último status conhecido (heartbeat) — assim a barra de
//     histórico do site nunca fica "parada no tempo".
//
// Cada execução adiciona UM novo segmento ao histórico de CADA serviço
// (checagem real ou heartbeat), mantendo só os 30 mais recentes.

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

  const now = new Date().toISOString();

  for (const cfg of config.services) {
    const service = data.services.find((s) => s.id === cfg.id);
    if (!service) {
      console.warn(`⚠️  "${cfg.id}" está em config/services.json mas não em data/status.json.`);
      continue;
    }

    const before = currentStatus(service);

    if (cfg.enabled && cfg.url) {
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
  console.log('✅ status.json atualizado.');
}

main();
