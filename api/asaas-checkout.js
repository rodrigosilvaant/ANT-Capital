// api/asaas-checkout.js
// Cria cliente + assinatura no Asaas e salva no Supabase
// POST /api/asaas-checkout
// Body: { user_id, nome, email, cpf, valor, ciclo }

const ASAAS_BASE = 'https://api.asaas.com/v3';
const ASAAS_KEY  = process.env.ASAAS_API_KEY;
const SUPA_URL   = process.env.SUPABASE_URL;
const SUPA_KEY   = process.env.SUPABASE_SERVICE_KEY;

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Método não permitido' });
  }

  const { user_id, nome, email, cpf, valor = 47.90, ciclo = 'MONTHLY' } = req.body;

  if (!user_id || !nome || !email || !cpf) {
    return res.status(400).json({ error: 'Campos obrigatórios: user_id, nome, email, cpf' });
  }

  const headers = {
    'Content-Type': 'application/json',
    'access_token': ASAAS_KEY,
    'User-Agent': 'ANTCapital/1.0'
  };

  try {
    // ── 1. Criar cliente no Asaas ──────────────────────────────────────────
    const clienteRes = await fetch(`${ASAAS_BASE}/customers`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        name: nome,
        email: email,
        cpfCnpj: cpf.replace(/\D/g, ''),
        notificationDisabled: false
      })
    });

    const clienteData = await clienteRes.json();

    if (!clienteRes.ok || clienteData.errors) {
      console.error('[Asaas] Erro ao criar cliente:', clienteData);
      return res.status(500).json({
        error: 'Erro ao criar cliente no Asaas',
        detalhes: clienteData.errors || clienteData
      });
    }

    const asaas_customer_id = clienteData.id;

    // ── 2. Criar assinatura ────────────────────────────────────────────────
    // Próximo vencimento = amanhã (Asaas precisa de data futura)
    const amanha = new Date();
    amanha.setDate(amanha.getDate() + 1);
    const proxVenc = amanha.toISOString().split('T')[0]; // YYYY-MM-DD

    const assinaturaRes = await fetch(`${ASAAS_BASE}/subscriptions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        customer: asaas_customer_id,
        billingType: 'UNDEFINED',   // Cliente escolhe: boleto, pix ou cartão
        value: valor,
        nextDueDate: proxVenc,
        cycle: ciclo,
        description: 'ANT Capital — Plano Mensal de Planejamento Financeiro',
        externalReference: user_id  // liga ao user_id do Supabase
      })
    });

    const assinaturaData = await assinaturaRes.json();

    if (!assinaturaRes.ok || assinaturaData.errors) {
      console.error('[Asaas] Erro ao criar assinatura:', assinaturaData);
      return res.status(500).json({
        error: 'Erro ao criar assinatura no Asaas',
        detalhes: assinaturaData.errors || assinaturaData
      });
    }

    const asaas_subscription_id = assinaturaData.id;

    // ── 3. Buscar link de pagamento da primeira cobrança ───────────────────
    // A assinatura gera automaticamente uma cobrança — buscamos o invoiceUrl
    let linkPagamento = null;
    try {
      const cobRes = await fetch(
        `${ASAAS_BASE}/subscriptions/${asaas_subscription_id}/payments?limit=1`,
        { headers }
      );
      const cobData = await cobRes.json();
      if (cobData.data && cobData.data.length > 0) {
        linkPagamento = cobData.data[0].invoiceUrl;
      }
    } catch (e) {
      console.warn('[Asaas] Não foi possível obter o link da cobrança:', e.message);
    }

    // ── 4. Salvar no Supabase ──────────────────────────────────────────────
    const supaRes = await fetch(`${SUPA_URL}/rest/v1/assinaturas`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': SUPA_KEY,
        'Authorization': `Bearer ${SUPA_KEY}`,
        'Prefer': 'resolution=merge-duplicates'  // upsert por user_id
      },
      body: JSON.stringify({
        user_id,
        asaas_customer_id,
        asaas_subscription_id,
        status: 'PENDING',
        valor,
        ciclo,
        proximo_vencimento: proxVenc
      })
    });

    if (!supaRes.ok) {
      const supaErr = await supaRes.text();
      console.error('[Supabase] Erro ao salvar assinatura:', supaErr);
      // Não bloqueia — assinatura foi criada no Asaas; log para revisão manual
    }

    // ── 5. Retornar sucesso com link de pagamento ──────────────────────────
    return res.status(200).json({
      ok: true,
      asaas_customer_id,
      asaas_subscription_id,
      linkPagamento,
      mensagem: linkPagamento
        ? 'Assinatura criada! Redirecionando para o pagamento...'
        : 'Assinatura criada! Você receberá o link de pagamento por e-mail.'
    });

  } catch (err) {
    console.error('[asaas-checkout] Erro inesperado:', err);
    return res.status(500).json({ error: 'Erro interno do servidor', detalhes: err.message });
  }
}
