// Lê o corpo de uma Issue criada a partir do formulário "status-update.yml",
// interpreta qual sistema e status foram escolhidos, e aplica a mudança em
// data/status.json. Não mexe no "history" (isso é papel do snapshot.js
// diário) — apenas atualiza o status atual e lastCheckedAt do serviço.
//
// O workflow que chama este script (update-status.yml) faz commit e push
// diretos assim que a Issue é criada, sem necessidade de Pull Request: a
// aprovação já aconteceu no momento em que alguém com acesso ao repositório
// preencheu e enviou o formulário da Issue.

const fs = require('fs');
const path = require('path');

const STATUS_FILE = path.join(__dirname, '..', 'data', 'status.json');
const CONFIG_FILE = path.join(__dirname, '..', 'config', 'services.json');

const STATUS_LABEL_TO_CODE = {
  Operacional: 'ok',
  Degradado: 'warn',
  Indisponível: 'down',
  'Em manutenção': 'maint',
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

  if (service.status === statusCode) {
    console.log(`"${serviceConfig.name}" já estava como "${statusCode}". Nada a fazer.`);
    setOutput('changed', 'false');
    return;
  }

  const now = new Date().toISOString();
  service.status = statusCode;
  service.lastCheckedAt = now;
  data.updatedAt = now;
  fs.writeFileSync(STATUS_FILE, JSON.stringify(data, null, 2) + '\n');

  console.log(`✅ "${serviceConfig.name}" atualizado para "${statusCode}".`);
  setOutput('changed', 'true');
  setOutput('service_name', serviceConfig.name);
  setOutput('status_label', statusLabel);
}

main();
