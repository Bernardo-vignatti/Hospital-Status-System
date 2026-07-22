// Utilitário compartilhado para manipular o histórico de verificações de
// um serviço. Usado por check-http.js, apply-status-change.js e
// snapshot.js para evitar duplicar a lógica de "adicionar e cortar em 30".

const MAX_HISTORY = 30; // segmentos exibidos na barra de histórico do site

/**
 * Adiciona uma nova verificação ao final do histórico (mais recente =
 * última posição, exibida à direita na UI) e mantém só os últimos
 * MAX_HISTORY registros.
 */
function pushHistoryEntry(service, { status, checkedAt, responseTime = null }) {
  service.history.push({ status, checkedAt, responseTime });
  if (service.history.length > MAX_HISTORY) {
    service.history = service.history.slice(service.history.length - MAX_HISTORY);
  }
}

/** Status "atual" de um serviço = a verificação mais recente do histórico. */
function currentStatus(service) {
  return service.history[service.history.length - 1].status;
}

module.exports = { MAX_HISTORY, pushHistoryEntry, currentStatus };
