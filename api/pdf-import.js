// api/pdf-import.js — Lê a fatura do cartão (texto do PDF) com IA
// POST (com login e assinatura ativa) { pdfText, mesReferencia } → { transacoes[] }
//   401 sem login · 402 SEM_ASSINATURA (recurso do plano: cada leitura usa IA)

const SUPA_URL = process.env.SUPABASE_URL;
const SUPA_KEY = process.env.SUPABASE_SERVICE_KEY;
const USUARIOS_ISENTOS = ['c52e0d58-27f5-46f3-bbae-06fb9a47171f'];
const LIMITE_TEXTO = 200000; // caracteres recebidos (só os 12.000 primeiros vão para a IA)

async function usuarioDoToken(req) {
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!token) return null;
  const r = await fetch(`${SUPA_URL}/auth/v1/user`, { headers: { apikey: SUPA_KEY, Authorization: `Bearer ${token}` } });
  return r.ok ? r.json() : null;
}
async function ler(tabela, filtro) {
  const r = await fetch(`${SUPA_URL}/rest/v1/${tabela}?${filtro}`, { headers: { apikey: SUPA_KEY, Authorization: `Bearer ${SUPA_KEY}` } });
  return r.ok ? r.json() : [];
}
async function temAcesso(userId) {
  if (USUARIOS_ISENTOS.includes(userId)) return true;
  const [perfil, assin, ess] = await Promise.all([
    ler('profiles', `select=role&id=eq.${userId}`),
    ler('assinaturas', `select=status&user_id=eq.${userId}`),
    ler('assinaturas_essencial', `select=status&client_id=eq.${userId}`),
  ]);
  return perfil[0]?.role === 'consultor' || assin[0]?.status === 'ACTIVE' || ess[0]?.status === 'ativa';
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', 'https://app.antcapital.com.br');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Método não permitido' });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'ANTHROPIC_API_KEY não configurada' });

  try {
    const user = await usuarioDoToken(req);
    if (!user?.id) return res.status(401).json({ error: 'Faça login novamente para importar a fatura.' });
    if (!(await temAcesso(user.id))) {
      return res.status(402).json({ error: 'A leitura de fatura em PDF faz parte do plano ANT Capital.', codigo: 'SEM_ASSINATURA' });
    }

    let body = req.body;
    if (!body || typeof body === 'string') {
      try { body = JSON.parse(body || '{}'); } catch { body = {}; }
    }

    const { pdfText, mesReferencia } = body;
    if (!pdfText) return res.status(400).json({ error: 'Texto do PDF não fornecido' });
    if (typeof pdfText !== 'string' || pdfText.length > LIMITE_TEXTO) return res.status(413).json({ error: 'Fatura grande demais. Envie um arquivo menor.' });

    const anoAtual = new Date().getFullYear();
    const mesAtual = String(new Date().getMonth() + 1).padStart(2, '0');
    const mesRef = mesReferencia || `${anoAtual}-${mesAtual}`;

    const prompt = `Você é um extrator de transações financeiras de faturas de cartão de crédito brasileiras.

Analise o texto da fatura abaixo e extraia TODAS as transações de compras e pagamentos.
Retorne APENAS um JSON válido, sem markdown, sem explicações, sem texto extra.

Formato obrigatório:
{"transacoes":[{"descricao":"string","valor":number,"data":"YYYY-MM-DD","tipo":"despesa","categoria":"string"}]}

Regras:
- Compras e lançamentos = tipo "despesa", valor positivo
- Pagamentos recebidos e créditos = tipo "receita", valor positivo  
- Se a data não tiver ano, use o ano de ${mesRef.split('-')[0]}
- Se a data não tiver mês, use o mês ${mesRef.split('-')[1]}
- Para "categoria", classifique como: Alimentação, Transporte, Saúde, Lazer, Compras, Assinatura, Educação, Viagem, Outros
- Ignore: totais, subtotais, encargos, juros, IOF, tarifas do próprio cartão, saldo devedor
- Inclua parcelamentos (ex: "01/12" = parcela 1 de 12)
- Limpe a descrição removendo códigos internos mas mantendo o nome do estabelecimento

Texto da fatura:
${pdfText.substring(0, 12000)}`;

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 4096,
        messages: [{ role: 'user', content: prompt }]
      })
    });

    if (!response.ok) {
      const err = await response.json();
      return res.status(response.status).json({ error: err.error?.message || 'Erro na API Anthropic' });
    }

    const data = await response.json();
    const text = data.content?.[0]?.text || '';

    // Parse JSON from response
    const clean = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    let parsed;
    try {
      parsed = JSON.parse(clean);
    } catch {
      // Try to extract JSON from the text
      const match = clean.match(/\{[\s\S]*\}/);
      if (match) parsed = JSON.parse(match[0]);
      else return res.status(500).json({ error: 'Não foi possível interpretar a fatura. Tente novamente.' });
    }

    return res.status(200).json(parsed);

  } catch (err) {
    return res.status(500).json({ error: err.message || 'Erro interno' });
  }
}
