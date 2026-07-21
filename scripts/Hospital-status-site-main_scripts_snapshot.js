// Snapshot diário: registra, para cada serviço, um retrato do status atual
// no histórico (data/status.json → services[].history). É este script (e
// não check-http.js) que faz o histórico crescer, mantendo-o compacto
// (1 registro por dia) mesmo com checagens automáticas a cada 5 minutos.

const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', 'data', 'status.json');
const MAX_HISTORY = 7; // mantém apenas os 7 registros mais recentes

const data = JSON.parse(fs.readFileSync(FILE, 'utf8'));
const now = new Date().toISOString();

data.services.forEach((s) => {
  s.history.push({
    status: s.status,
    checkedAt: now,
    // Se o serviço tem checagem HTTP automática, reaproveita a última
    // latência medida por check-http.js; senão fica null (serviço manual).
    responseTime: typeof s.lastResponseTime === 'number' ? s.lastResponseTime : null,
  });

  if (s.history.length > MAX_HISTORY) {
    s.history = s.history.slice(s.history.length - MAX_HISTORY);
  }
});

data.updatedAt = now;
fs.writeFileSync(FILE, JSON.stringify(data, null, 2) + '\n');
console.log(`✅ Snapshot registrado para ${data.services.length} serviços (histórico: últimos ${MAX_HISTORY} registros).`);
