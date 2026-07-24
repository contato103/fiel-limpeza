export const config = { runtime: 'edge' };

// ── Fiel Limpeza — verificação de existência de CNPJ ───────────────
// Confirma que o CNPJ existe de fato na Receita (via BrasilAPI, dados
// abertos). Usado pela LP e pelo Typebot só para BARRAR CPF / pessoa
// física — não grava nada, não enriquece.
//
// Regra fail-closed com uma exceção deliberada: só devolve ok:"nao"
// quando TEMOS CERTEZA (dígito verificador não fecha, ou a Receita diz
// 404). Se a BrasilAPI cair/der timeout, devolve ok:"sim" — timeout não
// é prova de CPF, e bloquear por causa de API fora do ar perderia lead
// real (o dígito verificador já é o filtro duro e local).

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'content-type',
  'Cache-Control': 'no-store',
};

const json = (obj) =>
  new Response(JSON.stringify(obj), {
    headers: { 'content-type': 'application/json', ...CORS },
  });

function digitoValido(d) {
  if (d.length !== 14 || /^(\d)\1{13}$/.test(d)) return false;
  const dv = (base) => {
    let peso = base.length - 7, soma = 0;
    for (const c of base) { soma += (+c) * peso; peso = peso === 2 ? 9 : peso - 1; }
    const resto = soma % 11;
    return resto < 2 ? 0 : 11 - resto;
  };
  return dv(d.slice(0, 12)) === +d[12] && dv(d.slice(0, 13)) === +d[13];
}

export default async function handler(req) {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

  const url = new URL(req.url);
  const d = (url.searchParams.get('n') || '').replace(/\D/g, '').slice(0, 14);

  // 1. Dígito verificador: filtro local, sem gastar request na Receita.
  if (!digitoValido(d)) return json({ ok: 'nao', reason: 'digito' });

  // 2. Existência real na Receita.
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 4500);
    const r = await fetch(`https://brasilapi.com.br/api/cnpj/v1/${d}`, {
      signal: ctrl.signal,
      headers: { 'User-Agent': 'fiel-lp/1.0' },
    });
    clearTimeout(t);

    if (r.status === 404) return json({ ok: 'nao', reason: 'nao_encontrado' });
    if (!r.ok) return json({ ok: 'sim', reason: 'erro_upstream' }); // fail-open
    return json({ ok: 'sim' });
  } catch {
    return json({ ok: 'sim', reason: 'erro_upstream' }); // timeout/rede: fail-open
  }
}
