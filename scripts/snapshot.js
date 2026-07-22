// "Heartbeat" diário: garante que TODO serviço ganhe pelo menos um novo
// segmento no histórico por dia, mesmo os que não têm checagem HTTP
// automática (gerador, elevadores, etc.) e só mudam de status via Issue.
// Sem isso, um serviço manual que nunca teve uma Issue aberta ficaria com
// a barra de histórico "parada no tempo".
//
// Repete o último status conhecido do serviço (não reavalia nada sozinho
// — quem decide o status real de um sistema físico é sempre uma Issue ou
// uma checagem HTTP).

const fs = require('fs');
const path = require('path');
const { pushHistoryEntry, currentStatus } = require('./lib/history');

const FILE = path.join(__dirname, '..', 'data', 'status.json');

const data = JSON.parse(fs.readFileSync(FILE, 'utf8'));
const now = new Date().toISOString();

data.services.forEach((s) => {
  pushHistoryEntry(s, { status: currentStatus(s), checkedAt: now, responseTime: null });
});

data.updatedAt = now;
fs.writeFileSync(FILE, JSON.stringify(data, null, 2) + '\n');
console.log(`✅ Heartbeat diário registrado para ${data.services.length} serviços.`);
