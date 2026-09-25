// ── Planilha de leads com UMA ABA POR MÊS ───────────────────────────
// Usado por api/leads.js (LP B2B) e api/revenda.js (/distribuidor).
// Arquivo com "_" na frente: a Vercel não publica como rota.
//
// Regra (padrões técnicos da agência, §4.1): o comercial separa os leads em
// abas mensais e reorganiza a planilha à vontade. O site NÃO pode depender
// do nome de uma aba fixa: em 21/09/2026 a aba "Leads" virou "AGOSTO" e a
// LP B2B passou 3 dias sem gravar lead nenhum.
//
// Como funciona:
// - Cada lead vai para a aba do mês corrente (horário de Brasília). A aba é
//   reconhecida pelo NOME: "SETEMBRO", "Setembro 2026", "SET/2026",
//   "Setembro de 2026", "09/2026", "2026-09"... (sem diferença de maiúscula
//   ou acento). Aba só com o mês, sem ano, conta como ANO_ABAS_SEM_ANO.
// - Se a aba do mês não existe, é criada DUPLICANDO a aba do mês mais
//   recente (formatação, validação de Status, largura das colunas), sem os
//   leads, sem critério de filtro e visível. Fica em primeiro, "OUTUBRO 2026".
// - O lead entra na LINHA 2 (mais recente em cima), nunca no fim: não colide
//   com resumo manual embaixo dos dados.
// - Só grava numa aba cuja linha 1 é mesmo um cabeçalho de leads.
// - Rede de segurança: se qualquer coisa falhar, o lead vai para a aba
//   "LEADS CONTINGÊNCIA" (criada se preciso) e o health-check passa a avisar.
//   O lead não se perde por causa de mudança na planilha.

const MESES_ABA = ['JANEIRO', 'FEVEREIRO', 'MARÇO', 'ABRIL', 'MAIO', 'JUNHO',
  'JULHO', 'AGOSTO', 'SETEMBRO', 'OUTUBRO', 'NOVEMBRO', 'DEZEMBRO'];
const semAcento = s => s.normalize('NFD').replace(/[̀-ͯ]/g, '');
const MESES_NORM = MESES_ABA.map(semAcento);
const MESES_CURTOS = MESES_NORM.map(m => m.slice(0, 3)); // JAN FEV MAR ABR MAI JUN JUL AGO SET OUT NOV DEZ
export const ANO_ABAS_SEM_ANO = 2026;
export const ABA_CONTINGENCIA = 'LEADS CONTINGÊNCIA';
const CABECALHO_CONTINGENCIA = ['Data ISO', 'Nome', 'Telefone', 'Email', 'Empresa / Loja', 'CNPJ', 'Motivo da contingência', 'Dados completos (JSON)'];

const API = 'https://sheets.googleapis.com/v4/spreadsheets';

// Mês e ano correntes no horário de Brasília (UTC-3, sem horário de verão).
export function mesAnoBR(agora = new Date()) {
  const l = new Date(agora.getTime() - 3 * 3600 * 1000);
  return { mes: l.getUTCMonth(), ano: l.getUTCFullYear() };
}

const anoValido = n => n >= 2024 && n <= 2099;

// "SETEMBRO" -> {mes: 8, ano: 2026}; "Outubro 2026" / "OUT/26" / "10/2026" -> {mes: 9, ano: 2026}; outro nome -> null
export function lerNomeAba(titulo) {
  const p = semAcento(String(titulo || '')).toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim()
    .split(' ').filter(t => t && t !== 'DE');
  if (!p.length || p.length > 2) return null;
  const ano = t => { const n = +t; const a = t.length === 2 ? 2000 + n : n; return /^(\d{2}|\d{4})$/.test(t) && anoValido(a) ? a : null; };
  // Numérico: "09/2026" ou "2026-09"
  if (p.length === 2 && /^\d+$/.test(p[0]) && /^\d+$/.test(p[1])) {
    const [a, b] = p[0].length === 4 ? [p[1], p[0]] : [p[0], p[1]];
    const mes = +a - 1, an = ano(b);
    return a.length <= 2 && mes >= 0 && mes < 12 && an ? { mes, ano: an } : null;
  }
  let mes = MESES_NORM.indexOf(p[0]);
  if (mes < 0) mes = MESES_CURTOS.indexOf(p[0]);
  if (mes < 0) return null;
  if (p.length === 1) return { mes, ano: ANO_ABAS_SEM_ANO };
  const an = ano(p[1]);
  return an ? { mes, ano: an } : null;
}

export const nomeAbaDoMes = ({ mes, ano }) => `${MESES_ABA[mes]} ${ano}`;

// Decide onde gravar. abas = [{sheetId, title, index, rowCount, ...}]
// -> { alvo } se a aba do mês existe, ou { criar: {nome, modelo} } se precisa criar.
export function planejar(abas, agora = new Date()) {
  const atual = mesAnoBR(agora);
  const chave = x => x.ano * 12 + x.mes;
  const mensais = abas
    .filter(a => a.title !== ABA_CONTINGENCIA)
    .map(a => ({ ...a, periodo: lerNomeAba(a.title) }))
    .filter(a => a.periodo);

  const doMes = mensais.filter(a => chave(a.periodo) === chave(atual)).sort((a, b) => a.index - b.index);
  if (doMes.length) return { alvo: doMes[0], duplicadas: doMes.slice(1).map(a => a.title) };

  // Modelo: a aba mensal mais recente que não seja do futuro; senão a mais
  // recente de todas; senão a primeira aba da planilha (planilha nova).
  const porRecencia = [...mensais].sort((a, b) => chave(b.periodo) - chave(a.periodo) || a.index - b.index);
  const modelo = porRecencia.find(a => chave(a.periodo) <= chave(atual))
    || porRecencia[0]
    || [...abas].filter(a => a.title !== ABA_CONTINGENCIA).sort((a, b) => a.index - b.index)[0];
  if (!modelo) throw new Error('PLANILHA_SEM_ABAS');
  return { criar: { nome: nomeAbaDoMes(atual), modelo }, duplicadas: [] };
}

const espera = ms => new Promise(r => setTimeout(r, ms));

// Chamada à API com 2 novas tentativas para 429 / 5xx (quota ou instabilidade do Google).
async function chamar(fetchImpl, url, token, opts = {}) {
  for (let tentativa = 0; ; tentativa++) {
    const res = await fetchImpl(url, {
      ...opts,
      headers: { Authorization: `Bearer ${token}`, ...(opts.body ? { 'Content-Type': 'application/json' } : {}) },
    });
    if (res.ok) return res.json();
    const corpo = await res.text().catch(() => '');
    if ((res.status === 429 || res.status >= 500) && tentativa < 2) { await espera(400 * 3 ** tentativa); continue; }
    const e = new Error(`SHEETS(${res.status}) ${corpo.slice(0, 300)}`);
    e.status = res.status; e.corpo = corpo;
    throw e;
  }
}

export async function listarAbas(fetchImpl, planilhaId, token) {
  const d = await chamar(fetchImpl, `${API}/${planilhaId}?fields=sheets.properties,sheets.basicFilter.range`, token);
  return (d.sheets || []).map(s => ({
    sheetId: s.properties.sheetId ?? 0,
    title: s.properties.title,
    index: s.properties.index ?? 0,
    hidden: !!s.properties.hidden,
    rowCount: s.properties.gridProperties?.rowCount ?? 1000,
    frozen: s.properties.gridProperties?.frozenRowCount ?? 0,
    temFiltro: !!s.basicFilter,
  }));
}

const intervalo = (titulo, a1) => encodeURIComponent(`'${titulo.replace(/'/g, "''")}'!${a1}`);

export async function lerCabecalho(fetchImpl, planilhaId, token, titulo) {
  const d = await chamar(fetchImpl, `${API}/${planilhaId}/values/${intervalo(titulo, '1:1')}`, token);
  return (d.values?.[0] || []).map(h => String(h).toLowerCase().trim());
}

// A linha 1 é mesmo um cabeçalho de leads? Precisa ter "nome" e mais 2 colunas conhecidas.
function cabecalhoDeLeads(cabecalho, conhecidas) {
  const set = new Set(cabecalho.filter(Boolean));
  return set.has('nome') && conhecidas.filter(c => set.has(c)).length >= 3;
}

// id novo de aba: inteiro positivo de 31 bits
function novoSheetId() {
  const b = new Uint32Array(1);
  crypto.getRandomValues(b);
  return (b[0] % 2000000000) + 1000;
}

const batch = (fetchImpl, planilhaId, token, requests) =>
  chamar(fetchImpl, `${API}/${planilhaId}:batchUpdate`, token, { method: 'POST', body: JSON.stringify({ requests }) });

async function criarAbaDoMes(fetchImpl, planilhaId, token, { nome, modelo }) {
  const sheetId = novoSheetId();
  const requests = [
    { duplicateSheet: { sourceSheetId: modelo.sheetId, insertSheetIndex: 0, newSheetId: sheetId, newSheetName: nome } },
    // Visível mesmo que o modelo esteja oculto.
    { updateSheetProperties: { properties: { sheetId, hidden: false }, fields: 'hidden' } },
  ];
  // Filtro do mês anterior vem com os critérios; um critério ativo poderia
  // esconder os leads novos. Mantém os botões de filtro, sem critério.
  if (modelo.temFiltro) {
    requests.push({ clearBasicFilter: { sheetId } }, { setBasicFilter: { filter: { range: { sheetId } } } });
  }
  // Some com os leads copiados do modelo. Fica o cabeçalho + 1 linha vazia
  // (o Sheets não deixa apagar todas as linhas não congeladas, e é dessa
  // linha que as próximas herdam formatação e a lista de Status).
  // Com mais de 1 linha congelada, mantém as congeladas + 1.
  const manter = Math.max(2, (modelo.frozen || 0) + 1);
  if (modelo.rowCount > manter) {
    requests.push({ deleteDimension: { range: { sheetId, dimension: 'ROWS', startIndex: manter, endIndex: modelo.rowCount } } });
  }
  const ate = Math.min(manter, modelo.rowCount);
  if (ate > 1) {
    requests.push({ repeatCell: { range: { sheetId, startRowIndex: 1, endRowIndex: ate }, cell: {}, fields: 'userEnteredValue,note' } });
  }
  await batch(fetchImpl, planilhaId, token, requests);
  return { sheetId, title: nome, index: 0, rowCount: ate, frozen: modelo.frozen || 0 };
}

// Grava `campos` ({'nome da coluna em minúsculas': valor}) na aba do mês.
// Lança erro se não conseguir (quem chama decide a contingência).
export async function gravarNoMes({ planilhaId, token, campos, agora = new Date(), fetchImpl = fetch }) {
  const conhecidas = Object.keys(campos);
  let abas = await listarAbas(fetchImpl, planilhaId, token);
  let plano = planejar(abas, agora);
  let alvo = plano.alvo, criada = false;

  if (!alvo) {
    const cabModelo = await lerCabecalho(fetchImpl, planilhaId, token, plano.criar.modelo.title);
    if (!cabecalhoDeLeads(cabModelo, conhecidas)) throw new Error(`MODELO_SEM_CABECALHO_DE_LEADS "${plano.criar.modelo.title}"`);
    try {
      alvo = await criarAbaDoMes(fetchImpl, planilhaId, token, plano.criar);
      criada = true;
    } catch (e) {
      // Dois leads chegando juntos no dia 1º: o outro criou a aba primeiro.
      if (e.status !== 400) throw e;
      abas = await listarAbas(fetchImpl, planilhaId, token);
      plano = planejar(abas, agora);
      if (!plano.alvo) throw e;
      alvo = plano.alvo;
    }
  }

  const cabecalho = await lerCabecalho(fetchImpl, planilhaId, token, alvo.title);
  if (!cabecalhoDeLeads(cabecalho, conhecidas)) throw new Error(`SEM_CABECALHO_DE_LEADS na aba "${alvo.title}"`);

  // Texto puro (equivale ao RAW do append): "=IMPORTXML(...)" vira texto, "+55..." não vira número.
  const values = cabecalho.map(h => {
    const v = campos[h];
    return v === undefined || v === null || v === '' ? {} : { userEnteredValue: { stringValue: String(v) } };
  });

  // Tudo no MESMO batchUpdate (atômico: dois leads simultâneos não se sobrescrevem).
  const sid = alvo.sheetId;
  const requests = [];
  if (alvo.rowCount > 1) {
    requests.push(
      { insertDimension: { range: { sheetId: sid, dimension: 'ROWS', startIndex: 1, endIndex: 2 }, inheritFromBefore: false } },
      // Garante a lista de Status (validação) igual à da linha de baixo.
      { copyPaste: { source: { sheetId: sid, startRowIndex: 2, endRowIndex: 3 }, destination: { sheetId: sid, startRowIndex: 1, endRowIndex: 2 }, pasteType: 'PASTE_DATA_VALIDATION' } },
    );
  } else {
    requests.push({ appendDimension: { sheetId: sid, dimension: 'ROWS', length: 1 } });
  }
  requests.push(
    // Nunca nasce oculta, mesmo que a linha de baixo esteja.
    { updateDimensionProperties: { range: { sheetId: sid, dimension: 'ROWS', startIndex: 1, endIndex: 2 }, properties: { hiddenByUser: false }, fields: 'hiddenByUser' } },
    { updateCells: { start: { sheetId: sid, rowIndex: 1, columnIndex: 0 }, rows: [{ values }], fields: 'userEnteredValue' } },
  );
  await batch(fetchImpl, planilhaId, token, requests);
  return { aba: alvo.title, criada };
}

// Última defesa: grava na aba fixa de contingência (cria se não existir), sem
// depender de cabeçalho nem de mês. Colunas fixas + JSON completo do lead.
async function gravarContingencia({ planilhaId, token, campos, motivo, fetchImpl }) {
  const linha = [
    campos['data iso'] || new Date().toISOString(),
    campos['nome'] || '', campos['telefone'] || '', campos['email'] || '',
    campos['empresa'] || campos['loja'] || '', campos['cnpj'] || '',
    String(motivo).slice(0, 300), JSON.stringify(campos).slice(0, 45000),
  ];
  const append = () => chamar(fetchImpl,
    `${API}/${planilhaId}/values/${intervalo(ABA_CONTINGENCIA, 'A:A')}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`,
    token, { method: 'POST', body: JSON.stringify({ values: [linha] }) });
  try {
    await append();
  } catch (e) {
    if (e.status !== 400) throw e; // 400 = a aba não existe ainda
    await batch(fetchImpl, planilhaId, token, [{ addSheet: { properties: { title: ABA_CONTINGENCIA, tabColor: { red: 0.9, green: 0.2, blue: 0.2 } } } }]).catch(err => { if (err.status !== 400) throw err; });
    await chamar(fetchImpl, `${API}/${planilhaId}/values/${intervalo(ABA_CONTINGENCIA, 'A1')}?valueInputOption=RAW`, token,
      { method: 'PUT', body: JSON.stringify({ values: [CABECALHO_CONTINGENCIA] }) }).catch(() => {});
    await append();
  }
}

// O que os endpoints chamam: aba do mês; se falhar, contingência; se falhar também, erro.
// Devolve {aba, criada, contingencia}.
export async function gravarLead({ planilhaId, token, campos, agora = new Date(), fetchImpl = fetch }) {
  try {
    return { ...(await gravarNoMes({ planilhaId, token, campos, agora, fetchImpl })), contingencia: false };
  } catch (erro) {
    // Log com os dados: recuperável pelos logs da Vercel mesmo se a contingência falhar.
    console.error('[planilha] falhou na aba do mês, indo para a contingência:', erro.message, JSON.stringify(campos));
    await gravarContingencia({ planilhaId, token, campos, motivo: erro.message, fetchImpl });
    return { aba: ABA_CONTINGENCIA, criada: false, contingencia: true, erro: erro.message };
  }
}

// Health-check SÓ DE LEITURA: onde o próximo lead cairia e o que está estranho.
// `esperadas` = colunas que a rota preenche (em minúsculas).
export async function diagnosticar({ planilhaId, token, esperadas = [], agora = new Date(), fetchImpl = fetch }) {
  const abas = await listarAbas(fetchImpl, planilhaId, token);
  const plano = planejar(abas, agora);
  const ref = plano.alvo || plano.criar.modelo;
  const cabecalho = await lerCabecalho(fetchImpl, planilhaId, token, ref.title);
  const set = new Set(cabecalho.filter(Boolean));
  const faltando = esperadas.filter(c => !set.has(c));
  const avisos = [];
  const problemas = [];
  if (!cabecalhoDeLeads(cabecalho, esperadas.length ? esperadas : [...set])) problemas.push(`a linha 1 da aba "${ref.title}" não é um cabeçalho de leads`);
  if (faltando.length) avisos.push(`colunas não encontradas no cabeçalho (vão chegar vazias): ${faltando.join(', ')}`);
  if (plano.alvo && plano.alvo.hidden) avisos.push(`a aba do mês "${plano.alvo.title}" está oculta`);
  if (plano.duplicadas.length) avisos.push(`mais de uma aba para este mês; o site usa "${plano.alvo.title}" e ignora: ${plano.duplicadas.join(', ')}`);
  const cont = abas.find(a => a.title === ABA_CONTINGENCIA);
  let emContingencia = 0;
  if (cont) {
    const d = await chamar(fetchImpl, `${API}/${planilhaId}/values/${intervalo(ABA_CONTINGENCIA, 'A2:A')}`, token);
    emContingencia = (d.values || []).filter(r => r[0]).length;
    if (emContingencia) problemas.push(`${emContingencia} lead(s) na aba "${ABA_CONTINGENCIA}": mover para a aba do mês e apagar de lá`);
  }
  return {
    ok: problemas.length === 0,
    aba_do_mes: plano.alvo ? plano.alvo.title : plano.criar.nome,
    sera_criada: !plano.alvo,
    modelo: plano.alvo ? null : plano.criar.modelo.title,
    colunas: set.size,
    leads_em_contingencia: emContingencia,
    problemas, avisos,
    abas: [...abas].sort((a, b) => a.index - b.index).map(a => a.title),
  };
}
