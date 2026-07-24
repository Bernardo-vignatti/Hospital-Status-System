// Worker que substitui scripts/check-http.js + scripts/run-cycle.sh.
//
// Roda via Cron Trigger (ver wrangler.toml) e faz, a cada tick, exatamente
// o que o ciclo local fazia — só que lendo/escrevendo os arquivos do repo
// via GitHub Contents API em vez de `git`/filesystem local:
//
//   1. Lê config/services.json (config estática dos serviços).
//   2. Lê data/status.json e data/pending-changes.json (+ seus `sha`).
//   3. Para cada serviço, na ordem de prioridade original:
//        a) mudança pendente na fila -> aplica e marca como consumida
//        b) enabled+url -> checagem HTTP real
//        c) senão -> heartbeat (repete o último status)
//   4. Escreve data/status.json (commit direto, com retry se o `sha`
//      ficar desatualizado).
//   5. Remove da fila só as chaves realmente consumidas neste tick,
//      relendo a fila na hora de gravar (retry com merge) — para nunca
//      apagar uma mudança nova que uma Issue tenha enfileirado entre o
//      passo 2 e agora.
//
// index.html, config/services.json e data/status.json continuam sendo
// servidos como sempre pelo GitHub Pages; este Worker só é responsável
// por manter data/status.json e data/pending-changes.json atualizados.

// Comparação de segredo em tempo constante. Comparar strings com `!==`
// vazaria informação por tempo de resposta (o motor pára no primeiro
// byte diferente). Como SHA-256 sempre produz 32 bytes, os dois lados
// têm o mesmo tamanho e o laço abaixo roda sempre inteiro.
async function sha256(str) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return new Uint8Array(digest);
}

async function secretMatches(provided, expected) {
  if (typeof provided !== 'string' || typeof expected !== 'string' || expected.length === 0) {
    return false;
  }
  const [a, b] = await Promise.all([sha256(provided), sha256(expected)]);
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

const MAX_HISTORY = 30;
const TIMEOUT_MS = 8000;
const VALID_STATUS = ['up', 'down', 'maint', 'unknown'];

function ghHeaders(env) {
  return {
    Authorization: `Bearer ${env.GITHUB_TOKEN}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'hospital-status-worker',
  };
}

function ghUrl(env, path) {
  return `https://api.github.com/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/contents/${path}?ref=${env.GITHUB_BRANCH}`;
}

// Decodifica base64 (com quebras de linha, como o GitHub retorna) em UTF-8.
function b64ToUtf8(b64) {
  const bin = atob(b64.replace(/\n/g, ''));
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder('utf-8').decode(bytes);
}

function utf8ToB64(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  bytes.forEach((b) => (bin += String.fromCharCode(b)));
  return btoa(bin);
}

async function ghGetJson(env, path) {
  const res = await fetch(ghUrl(env, path), { headers: ghHeaders(env) });
  if (!res.ok) {
    throw new Error(`GET ${path} falhou: HTTP ${res.status} ${await res.text()}`);
  }
  const file = await res.json();
  return { json: JSON.parse(b64ToUtf8(file.content)), sha: file.sha };
}

async function ghPutJson(env, path, jsonValue, sha, message) {
  const body = {
    message,
    content: utf8ToB64(JSON.stringify(jsonValue, null, 2) + '\n'),
    sha,
    branch: env.GITHUB_BRANCH,
  };
  const res = await fetch(ghUrl(env, path).split('?')[0], {
    method: 'PUT',
    headers: { ...ghHeaders(env), 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (res.status === 409 || res.status === 422) return { ok: false, conflict: true };
  if (!res.ok) throw new Error(`PUT ${path} falhou: HTTP ${res.status} ${await res.text()}`);
  return { ok: true };
}

function pushHistoryEntry(service, entry) {
  service.history.push(entry);
  if (service.history.length > MAX_HISTORY) {
    service.history = service.history.slice(service.history.length - MAX_HISTORY);
  }
}

function currentStatus(service) {
  return service.history[service.history.length - 1].status;
}

async function checkOne(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const start = Date.now();
  try {
    const res = await fetch(url, { method: 'GET', signal: controller.signal });
    return { status: res.ok ? 'up' : 'down', responseTime: Date.now() - start };
  } catch (e) {
    return { status: 'down', responseTime: Date.now() - start };
  } finally {
    clearTimeout(timeout);
  }
}

// Validação leve (equivalente ao essencial de scripts/validate.js) antes
// de gravar, pra nunca commitar um status.json quebrado no repo.
function assertValidStatus(data, config) {
  const configIds = new Set(config.services.map((s) => s.id));
  if (!Array.isArray(data.services) || data.services.length === 0) {
    throw new Error('data/status.json inválido: "services" vazio');
  }
  for (const s of data.services) {
    if (!configIds.has(s.id)) throw new Error(`serviço "${s.id}" não existe em config/services.json`);
    if (!Array.isArray(s.history) || s.history.length === 0) {
      throw new Error(`serviço "${s.id}": history vazio`);
    }
    for (const h of s.history) {
      if (!VALID_STATUS.includes(h.status)) throw new Error(`status inválido: ${h.status}`);
      if (!h.checkedAt || isNaN(Date.parse(h.checkedAt))) throw new Error(`checkedAt inválido em "${s.id}"`);
    }
  }
}

async function runCycle(env) {
  const log = [];

  const { json: config } = await ghGetJson(env, 'config/services.json');
  const { json: statusData, sha: statusSha } = await ghGetJson(env, 'data/status.json');
  const { json: pendingData } = await ghGetJson(env, 'data/pending-changes.json');

  const now = new Date().toISOString();
  const consumed = [];

  for (const cfg of config.services) {
    const service = statusData.services.find((s) => s.id === cfg.id);
    if (!service) {
      log.push(`⚠️  "${cfg.id}" está em services.json mas não em status.json.`);
      continue;
    }

    const before = currentStatus(service);
    const queued = pendingData.changes[cfg.id];

    if (queued) {
      pushHistoryEntry(service, { status: queued.status, checkedAt: now, responseTime: null });
      log.push(`${cfg.name}: mudança manual aplicada (${before} → ${queued.status}, Issue #${queued.issueNumber ?? '?'})`);
      consumed.push(cfg.id);
    } else if (cfg.enabled && cfg.url) {
      const { status, responseTime } = await checkOne(cfg.url);
      pushHistoryEntry(service, { status, checkedAt: now, responseTime });
      log.push(before === status
        ? `${cfg.name}: sem mudança (${status}, ${responseTime}ms)`
        : `${cfg.name}: ${before} → ${status} (${responseTime}ms)`);
    } else {
      pushHistoryEntry(service, { status: before, checkedAt: now, responseTime: null });
      log.push(`${cfg.name}: heartbeat (${before})`);
    }
  }

  statusData.updatedAt = now;
  assertValidStatus(statusData, config);

  // 1) grava status.json (só este Worker escreve nele -> sem conflito
  //    externo esperado, mas tenta de novo se o sha mudar por overlap).
  let statusOk = false;
  let currentStatusSha = statusSha;
  for (let attempt = 0; attempt < 3 && !statusOk; attempt++) {
    const result = await ghPutJson(env, 'data/status.json', statusData, currentStatusSha, `chore: ciclo de status ${now}`);
    if (result.ok) { statusOk = true; break; }
    const refetch = await ghGetJson(env, 'data/status.json');
    currentStatusSha = refetch.sha;
  }
  if (!statusOk) throw new Error('Não consegui gravar data/status.json após 3 tentativas (conflito de sha).');

  // 2) remove da fila só as chaves consumidas, relendo a fila na hora
  //    (uma Issue pode ter enfileirado algo novo entre o passo inicial e agora).
  if (consumed.length > 0) {
    let pendingOk = false;
    for (let attempt = 0; attempt < 3 && !pendingOk; attempt++) {
      const fresh = await ghGetJson(env, 'data/pending-changes.json');
      let changed = false;
      for (const id of consumed) {
        if (fresh.json.changes[id]) { delete fresh.json.changes[id]; changed = true; }
      }
      if (!changed) { pendingOk = true; break; }
      const result = await ghPutJson(env, 'data/pending-changes.json', fresh.json, fresh.sha, `chore: consome mudanças aplicadas (${consumed.join(', ')})`);
      if (result.ok) { pendingOk = true; break; }
    }
    if (!pendingOk) log.push('⚠️  Não consegui atualizar pending-changes.json (vai tentar de novo no próximo tick).');
  }

  log.push('✅ status.json atualizado.');
  return log;
}

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(
      runCycle(env)
        .then((log) => console.log(log.join('\n')))
        .catch((err) => console.error('Erro no ciclo:', err))
    );
  },

  // Endpoint HTTP só para teste manual (dispara o mesmo ciclo do cron).
  //
  // Endurecido: (1) comparação do segredo em tempo constante,
  // (2) nenhuma rota responde nada identificável — qualquer coisa que
  // não seja um POST /run autenticado recebe 404 puro, para o Worker não
  // anunciar sua existência nem a qual sistema pertence,
  // (3) erros internos não são devolvidos ao cliente (ficam no
  // `wrangler tail`), para não vazar detalhe da API do GitHub.
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const notFound = new Response('Not found', { status: 404 });

    if (url.pathname !== '/run' || request.method !== 'POST') return notFound;

    const auth = request.headers.get('Authorization') || '';
    const provided = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    if (!(await secretMatches(provided, env.MANUAL_TRIGGER_SECRET || ''))) {
      // 404 em vez de 401: quem não tem o segredo nem descobre que a
      // rota existe.
      return notFound;
    }

    try {
      const log = await runCycle(env);
      return new Response(log.join('\n'), { status: 200 });
    } catch (err) {
      console.error('Erro no ciclo manual:', err);
      return new Response('Erro interno. Veja `npx wrangler tail`.', { status: 500 });
    }
  },
};
