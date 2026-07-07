export const config = { runtime: 'edge' };

// ── Fiel Limpeza — Edge function de captura de leads ───────────────
// Grava no Google Sheets mapeando PELO NOME DA COLUNA (lê a linha 1 da
// planilha a cada request). Reordenar/renomear colunas não quebra o
// envio: header que não casa com o fieldMap é gravado em branco, sem erro.
// NÃO envia CAPI — o Apps Script (sheets-setup-fiel.gs) faz isso via onChange.

const SPREADSHEET_ID  = process.env.SPREADSHEET_ID;
const SHEET_NAME      = 'Leads';
const SHEET_RANGE     = (a1) => encodeURIComponent(`'${SHEET_NAME}'!${a1}`);
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);

function getCorsHeaders(origin) {
  const allowed = ALLOWED_ORIGINS.length === 0 || ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': allowed || '*',
    'Access-Control-Allow-Headers': 'content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Vary': 'Origin',
  };
}

async function getAccessToken(serviceAccountKey) {
  const key = JSON.parse(serviceAccountKey);

  const base64UrlEncode = (obj) => {
    const base64 = btoa(JSON.stringify(obj));
    return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  };

  const now = Math.floor(Date.now() / 1000);
  const headerEncoded  = base64UrlEncode({ alg: 'RS256', typ: 'JWT' });
  const payloadEncoded = base64UrlEncode({
    iss:   key.client_email,
    scope: 'https://www.googleapis.com/auth/spreadsheets',
    aud:   'https://oauth2.googleapis.com/token',
    exp:   now + 3600,
    iat:   now,
  });

  const signatureInput = `${headerEncoded}.${payloadEncoded}`;

  const pemContents = key.private_key
    .replace('-----BEGIN PRIVATE KEY-----', '')
    .replace('-----END PRIVATE KEY-----', '')
    .replace(/\s/g, '');

  const binaryKey = Uint8Array.from(atob(pemContents), c => c.charCodeAt(0));
  const cryptoKey = await crypto.subtle.importKey(
    'pkcs8', binaryKey,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false, ['sign']
  );

  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5', cryptoKey,
    new TextEncoder().encode(signatureInput)
  );

  const signatureBase64 = btoa(String.fromCharCode(...new Uint8Array(signature)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

  const jwt = `${signatureInput}.${signatureBase64}`;

  const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt,
    }),
  });

  const tokenData = await tokenResponse.json();
  if (!tokenResponse.ok) throw new Error(`Token error: ${tokenData.error_description}`);
  return tokenData.access_token;
}

function formatPhone(raw) {
  let d = (raw || '').replace(/\D/g, '');
  if (d.startsWith('55') && d.length >= 12) d = d.slice(2);
  if (d.startsWith('0')) d = d.slice(1);
  if (d.length === 10) d = d.slice(0, 2) + '9' + d.slice(2);
  return '+55' + d;
}

const MESES = ['Janeiro','Fevereiro','Março','Abril','Maio','Junho','Julho','Agosto','Setembro','Outubro','Novembro','Dezembro'];

function getLocalDate() {
  const now    = new Date();
  const offset = -3;
  const local  = new Date(now.getTime() + (offset * 60 + now.getTimezoneOffset()) * 60000);
  const pad    = n => String(n).padStart(2, '0');
  return {
    iso: `${local.getFullYear()}-${pad(local.getMonth()+1)}-${pad(local.getDate())}T${pad(local.getHours())}:${pad(local.getMinutes())}:${pad(local.getSeconds())}-03:00`,
    br:  `${pad(local.getDate())}/${pad(local.getMonth()+1)}/${local.getFullYear()} ${pad(local.getHours())}:${pad(local.getMinutes())}`,
    mes: `${MESES[local.getMonth()]}/${local.getFullYear()}`,
  };
}

// ── Meta CAPI (Lead) server-side ───────────────────────────────────
// Enviado no submit, com dedup pelo mesmo event_id do pixel do navegador.
async function sha256(str) {
  if (!str) return '';
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(str)));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}
function normName(name) {
  return (name || '').toLowerCase().trim()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z\s]/g, '').trim();
}
function normCity(city) {
  return (city || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z]/g, '');
}
function phoneForMeta(raw) {           // só dígitos com DDI, SEM '+' (ex: 5547999990000)
  let d = (raw || '').replace(/\D/g, '');
  if (d.startsWith('0')) d = d.slice(1);
  if (d.startsWith('55')) return (d.length >= 12 && d.length <= 13) ? d : '';
  if (d.length === 11) return '55' + d;
  return '';
}

async function sendLeadCAPI(d, ip, geo) {
  const PIXEL = process.env.META_PIXEL_ID;
  const TOKEN = process.env.META_ACCESS_TOKEN;
  if (!PIXEL || !TOKEN) return { skipped: 'no_creds' };

  const phone = phoneForMeta(d.phone);
  const nameParts = normName(d.name).split(/\s+/);
  const fn = d.first_name ? normName(d.first_name) : (nameParts[0] || '');
  const ln = d.last_name  ? normName(d.last_name)  : (nameParts.slice(1).join(' ') || '');

  const ud = { country: [await sha256('br')] };
  const email = (d.email || '').toLowerCase().trim();
  if (email)        ud.em = [await sha256(email)];
  if (phone)        ud.ph = [await sha256(phone)];
  if (fn)           ud.fn = [await sha256(fn)];
  if (ln)           ud.ln = [await sha256(ln)];
  if (d.event_id)   ud.external_id = [d.event_id];
  if (d.cidade)     ud.ct = [await sha256(normCity(d.cidade))];
  if (geo.region_code) ud.st = [await sha256(geo.region_code.toLowerCase().slice(0, 2))];
  if (geo.postal) { const zp = geo.postal.replace(/\D/g, '').slice(0, 8); if (zp.length === 8) ud.zp = [await sha256(zp)]; }
  if (ip)           ud.client_ip_address = ip;
  if (d.user_agent) ud.client_user_agent = d.user_agent;
  if (d.fbc)        ud.fbc = d.fbc;
  if (d.fbp)        ud.fbp = d.fbp;

  // Precisa de pelo menos um identificador forte
  if (!ud.ph && !ud.em && !ud.fbp && !ud.fbc) return { skipped: 'no_identifiers' };

  const payload = {
    data: [{
      event_name:       'Lead',
      event_time:       Math.floor(Date.now() / 1000),
      event_id:         d.event_id || undefined,
      action_source:    'website',
      event_source_url: d.page_url || undefined,
      user_data:        ud,
    }],
  };
  if (process.env.META_TEST_CODE) payload.test_event_code = process.env.META_TEST_CODE;

  const res = await fetch(`https://graph.facebook.com/v19.0/${PIXEL}/events`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + TOKEN },
    body:    JSON.stringify(payload),
  });
  return { status: res.status };
}

export default async function handler(req) {
  const origin = req.headers.get('origin') || '';
  const corsHeaders = getCorsHeaders(origin);

  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });

  // Health-check (read-only): valida token + leitura dos headers da aba — sem gravar nem CAPI.
  // GET /api/leads?health=1  -> 200 {ok:true} se consegue ler a planilha; 500 caso contrário.
  if (req.method === 'GET' && new URL(req.url).searchParams.get('health') === '1') {
    try {
      const token = await getAccessToken(process.env.GOOGLE_CREDENTIALS);
      const hr = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values/${SHEET_RANGE('1:1')}`, { headers: { 'Authorization': `Bearer ${token}` } });
      if (!hr.ok) return new Response(JSON.stringify({ ok: false, stage: 'headers', status: hr.status, sheet: SHEET_NAME }), { status: 500, headers: { 'Content-Type': 'application/json' } });
      const hd = await hr.json();
      const columns = (hd.values?.[0] || []).length;
      return new Response(JSON.stringify({ ok: true, sheet: SHEET_NAME, columns }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    } catch (e) {
      return new Response(JSON.stringify({ ok: false, stage: 'token', error: String(e && e.message || e) }), { status: 500, headers: { 'Content-Type': 'application/json' } });
    }
  }

  if (req.method !== 'POST')   return new Response('Method Not Allowed', { status: 405, headers: corsHeaders });

  try {
    const d    = await req.json();
    const utms = d.utms || {};

    const ip = req.headers.get('x-forwarded-for')?.split(',')[0].trim()
            || req.headers.get('x-real-ip')
            || '';

    let geo = { city: '', region_code: '', postal: '' };
    if (ip) {
      try {
        const geoRes = await fetch(`https://ipapi.co/${ip}/json/`, {
          headers: { 'User-Agent': 'fiel-limpeza/1.0' }
        });
        if (geoRes.ok) {
          const g = await geoRes.json();
          geo = {
            city:        g.city        || '',
            region_code: (g.region_code || '').toLowerCase(),
            postal:      (g.postal      || '').replace(/\D/g, '').substring(0, 8),
          };
        }
      } catch (_) {}
    }

    const ts = getLocalDate();

    // ── Mapa por NOME DE COLUNA (chave = header em lowercase/trim) ──
    // Cidade vem do FORM (o cliente digita); Estado/CEP vêm do geo por IP.
    const fieldMap = {
      'mês':          ts.mes,
      'data':         ts.br,
      'nome':         d.name      || '',
      'email':        (d.email    || '').toLowerCase().trim(),
      'empresa':      d.empresa   || '',
      'cnpj':         d.cnpj      || '',
      'telefone':     formatPhone(d.phone),
      'cidade':       d.cidade    || '',
      'serviço':      d.servico   || '',
      'mensagem':     d.mensagem  || '',
      'status':       '',
      'utm_source':   utms.utm_source   || '',
      'utm_medium':   utms.utm_medium   || '',
      'utm_campaign': utms.utm_campaign || '',
      'utm_term':     utms.utm_term     || '',
      'utm_content':  utms.utm_content  || '',
      'event id':     d.event_id  || '',
      'fbclid':       d.fbclid    || '',
      'gclid':        d.gclid     || '',
      'gbraid':       d.gbraid    || '',
      'wbraid':       d.wbraid    || '',
      'ttclid':       d.ttclid    || '',
      'msclkid':      d.msclkid   || '',
      'fbp':          d.fbp       || '',
      'fbc':          d.fbc       || '',
      'primeiro nome': d.first_name || '',
      'sobrenome':    d.last_name  || '',
      'pagina':       d.page_url   || '',
      'referencia':   d.referrer   || '',
      'idioma':       d.language   || '',
      'resolucao':    d.screen     || '',
      'fuso horario': d.timezone   || '',
      'ip':           ip,
      'navegador':    d.user_agent || '',
      'estado':       geo.region_code,
      'cep':          geo.postal,
      'data iso':     ts.iso,
    };

    let token;
    try {
      token = await getAccessToken(process.env.GOOGLE_CREDENTIALS);
    } catch (tokenErr) {
      throw new Error(`TOKEN_FAIL: ${tokenErr.message}`);
    }

    const headersUrl = `https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values/${SHEET_RANGE('1:1')}`;
    const headersRes = await fetch(headersUrl, {
      headers: { 'Authorization': `Bearer ${token}` },
    });
    if (!headersRes.ok) throw new Error(`HEADERS_FAIL(${headersRes.status})`);

    const headersData = await headersRes.json();
    const headers = (headersData.values?.[0] || []).map(h => h.toLowerCase().trim());

    // Monta a linha na ORDEM ATUAL dos cabeçalhos da planilha.
    const row = headers.map(h => fieldMap[h] ?? '');

    const appendUrl = `https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values/${SHEET_RANGE('A:A')}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`;
    const res = await fetch(appendUrl, {
      method:  'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body:    JSON.stringify({ values: [row] }),
    });

    if (!res.ok) {
      const err = await res.json();
      throw new Error(`SHEETS_FAIL(${res.status}): ${JSON.stringify(err)}`);
    }

    // Lead gravado no Sheets. Dispara o CAPI Lead (dedup com o pixel via event_id; não bloqueia se falhar).
    try { await sendLeadCAPI(d, ip, geo); } catch (e) { console.error('[leads] capi:', e && e.message || e); }

    return new Response(JSON.stringify({ success: true }), {
      status:  200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });

  } catch (err) {
    console.error('[leads] internal error:', err);
    return new Response(JSON.stringify({ success: false, error: 'Internal error' }), {
      status:  500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
}
