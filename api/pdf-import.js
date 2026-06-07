export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Método não permitido' });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'ANTHROPIC_API_KEY não configurada' });

  try {
    let body = req.body;
    if (!body || typeof body === 'string') {
      try { body = JSON.parse(body || '{}'); } catch { body = {}; }
    }

    const { pdfText, mesReferencia } = body;
    if (!pdfText) return res.status(400).json({ error: 'Texto do PDF não fornecido' });

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
