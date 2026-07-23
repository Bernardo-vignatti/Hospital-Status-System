/*
 * Hospital Status System — lógica compartilhada
 *
 * Tudo que index.html e servico.html têm em comum vive aqui: os 4 estados
 * possíveis, o cálculo de disponibilidade, formatação de datas, leitura de
 * config/services.json + data/status.json e o tooltip do histórico.
 *
 * Nada de framework/bundler — só um objeto global (window.HSS), no mesmo
 * espírito "HTML/CSS/JS puro" do restante do projeto.
 */
(function (window) {
  'use strict';

  const STATUS_META = {
    up:      { label: 'Operante',    cls: 'up' },
    down:    { label: 'Inoperante',  cls: 'down' },
    maint:   { label: 'Manutenção',  cls: 'maint' },
    unknown: { label: 'Desconhecido', cls: 'unknown' },
  };

  // Ciclo real de atualização de dados (Cloudflare Worker, ver README —
  // seção "Automático"). Usado para estimar a próxima atualização; o
  // polling do próprio navegador (30s) só serve para *perceber* essa
  // mudança mais cedo, não define o ritmo real dos dados.
  const DATA_CYCLE_MS = 5 * 60 * 1000;

  function meta(status) {
    return STATUS_META[status] || STATUS_META.unknown;
  }

  function fmtDateTime(iso) {
    const d = new Date(iso);
    return d.toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }

  function fmtTime(iso) {
    const d = new Date(iso);
    return d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }

  // Disponibilidade calculada sobre os segmentos com resultado conhecido
  // (up/down/maint). "Manutenção" conta como indisponível (down) para fins
  // de %, pois o serviço está de fato fora do ar para o usuário nesse
  // período. "Desconhecido" continua fora da conta — não é uma medição,
  // é ausência de dado.
  //
  // `windowMs`, se informado, restringe o cálculo aos registros cujo
  // `checkedAt` caia dentro da janela [agora - windowMs, agora]. Como o
  // histórico guarda no máximo 30 registros (ver README, "Timeline
  // sincronizada"), janelas maiores que a cobertura real do histórico
  // simplesmente usam todos os registros disponíveis dentro do período —
  // e, se não houver nenhum, o resultado é `null` (sem dado), nunca um
  // número inventado.
  function computeUptime(history, windowMs) {
    let records = history;
    if (typeof windowMs === 'number') {
      const cutoff = Date.now() - windowMs;
      records = history.filter(h => new Date(h.checkedAt).getTime() >= cutoff);
    }
    const known = records.filter(h => h.status === 'up' || h.status === 'down' || h.status === 'maint');
    if (known.length === 0) return null;
    const upCount = known.filter(h => h.status === 'up').length;
    return { pct: Math.round((upCount / known.length) * 100), known: known.length };
  }

  // Cobertura real do histórico em ms (do registro mais antigo ao mais
  // recente) — usado para avisar quando uma janela (ex.: 90 dias) é maior
  // que os dados que o sistema realmente guarda até agora.
  function historyCoverageMs(history) {
    if (!history || history.length === 0) return 0;
    const first = new Date(history[0].checkedAt).getTime();
    const last = new Date(history[history.length - 1].checkedAt).getTime();
    return Math.max(0, last - first);
  }

  function barsHtml(history) {
    return history.map((h) => {
      const hm = meta(h.status);
      return `<div class="bar ${hm.cls}" data-status="${h.status}" data-checked="${h.checkedAt}" data-response="${h.responseTime == null ? '' : h.responseTime}"></div>`;
    }).join('');
  }

  // Liga hover/toque num container que tenha `.bar` dentro, mostrando o
  // tooltip compartilhado (`#tooltip`, precisa existir na página).
  function wireHistoryTooltips(containerEl) {
    const tooltipEl = document.getElementById('tooltip');
    if (!tooltipEl || !containerEl) return;
    let tappedBar = null;

    function showTooltip(bar, x, y) {
      const m = meta(bar.dataset.status);
      const rt = bar.dataset.response;
      const rtLine = rt ? `<br>${rt} ms` : '';
      tooltipEl.innerHTML = `<b>${m.label}</b><br>${fmtDateTime(bar.dataset.checked)}${rtLine}`;
      tooltipEl.style.left = x + 'px';
      tooltipEl.style.top = y + 'px';
      tooltipEl.classList.add('visible');
    }
    function hideTooltip() { tooltipEl.classList.remove('visible'); }

    containerEl.addEventListener('mouseover', (e) => {
      const bar = e.target.closest('.bar');
      if (!bar) return;
      const rect = bar.getBoundingClientRect();
      showTooltip(bar, rect.left + rect.width / 2, rect.top);
    });
    containerEl.addEventListener('mouseout', (e) => {
      if (e.target.closest('.bar')) hideTooltip();
    });
    containerEl.addEventListener('click', (e) => {
      const bar = e.target.closest('.bar');
      if (!bar) { tappedBar?.classList.remove('tapped'); tappedBar = null; hideTooltip(); return; }
      if (tappedBar === bar) { bar.classList.remove('tapped'); tappedBar = null; hideTooltip(); return; }
      tappedBar?.classList.remove('tapped');
      bar.classList.add('tapped');
      tappedBar = bar;
      const rect = bar.getBoundingClientRect();
      showTooltip(bar, rect.left + rect.width / 2, rect.top);
    });
  }

  async function loadServiceInfo() {
    const res = await fetch('./config/services.json', { cache: 'no-store' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const config = await res.json();
    const byId = {};
    config.services.forEach(s => { byId[s.id] = { id: s.id, name: s.name, url: s.url }; });
    return byId;
  }

  async function loadStatus() {
    const res = await fetch('./data/status.json?t=' + Date.now(), { cache: 'no-store' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return res.json();
  }

  // Rótulo relativo tipo "há 2 minutos" a partir de uma Date.
  function relativeLabel(date) {
    const diffSec = Math.max(0, Math.round((Date.now() - date.getTime()) / 1000));
    if (diffSec < 5) return 'agora mesmo';
    if (diffSec < 60) return `há ${diffSec} segundos`;
    if (diffSec < 3600) return `há ${Math.floor(diffSec / 60)} minuto(s)`;
    return 'há ' + date.toLocaleString('pt-BR');
  }

  // Contagem regressiva até a próxima atualização estimada do ciclo real
  // de dados (~5 min, ver README). Nunca é negativa; quando o ciclo já
  // deveria ter passado, mostra uma mensagem de "a qualquer momento" em
  // vez de contar em negativo — o tick seguinte do polling vai atualizar
  // `lastUpdatedAtDate` e reiniciar a contagem sozinho.
  function nextUpdateLabel(lastUpdatedAtDate) {
    if (!lastUpdatedAtDate) return '—';
    const elapsed = Date.now() - lastUpdatedAtDate.getTime();
    const remainingMs = DATA_CYCLE_MS - elapsed;
    if (remainingMs <= 0) return 'a qualquer momento';
    const totalSec = Math.round(remainingMs / 1000);
    const min = Math.floor(totalSec / 60);
    const sec = totalSec % 60;
    if (min <= 0) return `em ${sec}s`;
    return `em ${min}min ${String(sec).padStart(2, '0')}s`;
  }

  window.HSS = {
    STATUS_META,
    DATA_CYCLE_MS,
    meta,
    fmtDateTime,
    fmtTime,
    computeUptime,
    historyCoverageMs,
    barsHtml,
    wireHistoryTooltips,
    loadServiceInfo,
    loadStatus,
    relativeLabel,
    nextUpdateLabel,
  };
})(window);
