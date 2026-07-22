// Utilitário compartilhado para a fila de mudanças manuais pendentes
// (data/pending-changes.json).
//
// Por que essa fila existe: o sistema tem um único "relógio" global de
// atualização — o ciclo de ~5 min do auto-check.yml, que é o ÚNICO lugar
// que escreve data/status.json e portanto avança a timeline. Uma Issue
// pode ser aberta a qualquer momento (não respeita o ciclo), então ela
// nunca escreve status.json diretamente: ela só registra a intenção de
// mudança aqui. No próximo tick do ciclo, check-http.js lê essa fila,
// aplica cada mudança pendente (em vez de fazer heartbeat/checagem HTTP
// para aquele serviço) e limpa a entrada consumida.
//
// Isso garante que:
//   - a mudança fica registrada imediatamente (nada se perde, mesmo que
//     o próximo ciclo demore por causa do atraso natural do agendamento
//     do GitHub Actions);
//   - a timeline só se move no tick do ciclo — nunca fora dele — então o
//     ciclo nunca é reiniciado, adiantado ou atrasado por uma Issue;
//   - todos os serviços continuam avançando juntos, com o mesmo
//     "checkedAt", independente de quando a Issue foi processada.

const fs = require('fs');
const path = require('path');

const PENDING_FILE = path.join(__dirname, '..', '..', 'data', 'pending-changes.json');

function readPending() {
  try {
    const raw = fs.readFileSync(PENDING_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed.changes !== 'object' || parsed.changes === null) {
      return { changes: {} };
    }
    return parsed;
  } catch (e) {
    // Arquivo ainda não existe ou está corrompido: fila vazia.
    return { changes: {} };
  }
}

function writePending(pending) {
  fs.writeFileSync(PENDING_FILE, JSON.stringify(pending, null, 2) + '\n');
}

/**
 * Registra (ou substitui) a mudança pendente para um serviço. Se já
 * houver uma mudança pendente para o mesmo serviço (Issue anterior ainda
 * não consumida pelo ciclo), a mais recente vence.
 */
function queueChange(pending, serviceId, { status, requestedAt, issueNumber }) {
  pending.changes[serviceId] = { status, requestedAt, issueNumber };
}

/** Status "efetivo" de um serviço para fins de comparação: a mudança
 * pendente ainda não aplicada, se houver, senão o status atual real. */
function effectiveStatus(pending, serviceId, currentRealStatus) {
  const p = pending.changes[serviceId];
  return p ? p.status : currentRealStatus;
}

module.exports = { PENDING_FILE, readPending, writePending, queueChange, effectiveStatus };
