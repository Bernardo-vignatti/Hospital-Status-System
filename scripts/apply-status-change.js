// Lê o corpo de uma Issue criada a partir do formulário "status-update.yml"
// e interpreta qual sistema e status foram escolhidos.
//
// IMPORTANTE (arquitetura de relógio único): este script NUNCA escreve em
// data/status.json e NUNCA avança a timeline. Ele só registra a mudança
// desejada em data/pending-changes.json (fila de mudanças pendentes). A
// timeline só avança dentro do ciclo de ~5 min do auto-check.yml, que é
// quem de fato lê essa fila, aplica a mudança e faz o serviço avançar
// junto com todos os outros no mesmo tick — assim uma Issue, que pode
// chegar a qualquer momento e sofrer o atraso natural da API/eventos do
// GitHub, nunca reinicia, adianta ou atrasa o ciclo global.
//
// O workflow que chama este script (update-status.yml) faz commit e push
// diretos da fila assim que a Issue é criada (sem Pull Request: a
// aprovação já aconteceu no momento em que alguém com acesso ao
// repositório preencheu e enviou o formulário).

const fs = require('fs');
const path = require('path');
const { currentStatus } = require('./lib/history');
const { readPending, writePending, queueChange, effectiveStatus } = require('./lib/pending');

const STATUS_FILE = path.join(__dirname, '..', 'data', 'status.json');
const CONFIG_FILE = path.join(__dirname, '..', 'config', 'services.json');

const STATUS_LABEL_TO_CODE = {
  Operante: 'up',
  Inoperante: 'down',
  Manutenção: 'maint',
  Desconhecido: 'unknown',
};

function extractField(body, label) {
  const lines = body.split('\n');
  const idx = lines.findIndex((l) => l.trim() === `### ${label}`);
  if (idx === -1) return null;
  for (let i = idx + 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line === '') continue;
    if (line.startsWith('### ')) return null;
    if (line === '_No response_') return null;
    return line;
  }
  return null;
}

function setOutput(name, value) {
  if (process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
  }
}

function main() {
  const body = process.env.ISSUE_BODY || '';
  const issueNumber = process.env.ISSUE_NUMBER || null;

  const sistemaLabel = extractField(body, 'Sistema');
  const statusLabel = extractField(body, 'Novo status');

  const config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  const serviceConfig = sistemaLabel
    ? config.services.find((s) => s.name === sistemaLabel)
    : null;
  const statusCode = statusLabel ? STATUS_LABEL_TO_CODE[statusLabel] : null;

  if (!serviceConfig || !statusCode) {
    console.error(
      `Não consegui interpretar o formulário (sistema="${sistemaLabel}", status="${statusLabel}").`
    );
    setOutput('changed', 'false');
    return;
  }

  const data = JSON.parse(fs.readFileSync(STATUS_FILE, 'utf8'));
  const service = data.services.find((s) => s.id === serviceConfig.id);

  if (!service) {
    console.error(`Serviço "${serviceConfig.id}" existe em config/services.json mas não em data/status.json.`);
    setOutput('changed', 'false');
    return;
  }

  const pending = readPending();
  const current = effectiveStatus(pending, service.id, currentStatus(service));

  if (current === statusCode) {
    console.log(`"${serviceConfig.name}" já está (ou já vai ficar, por mudança pendente) como "${statusCode}". Nada a fazer.`);
    setOutput('changed', 'false');
    return;
  }

  queueChange(pending, service.id, {
    status: statusCode,
    requestedAt: new Date().toISOString(),
    issueNumber: issueNumber ? Number(issueNumber) : null,
  });
  writePending(pending);

  console.log(`📝 "${serviceConfig.name}" → "${statusCode}" registrado na fila. Será aplicado no próximo ciclo de atualização.`);
  setOutput('changed', 'true');
  setOutput('service_name', serviceConfig.name);
  setOutput('status_label', statusLabel);
}

main();
