// api/asaas-checkout.js
// Cria cliente + assinatura no Asaas e salva no Supabase
// POST /api/asaas-checkout
// Body (PIX):    { user_id, nome, email, cpf, valor, ciclo, billingType:'PIX' }
// Body (Cartão): { user_id, nome, email, cpf, valor, ciclo, billingType:'CREDIT_CARD',
//                  creditCard:{holderName,number,expiryMonth,expiryYear,ccv},
//                  creditCardHolderInfo:{name,email,cpfCnpj,postalCode,addressNumber,phone},
//                  remoteIp }

const ASAAS_BASE = 'https://api.asaas.com/v3';
const ASAAS_KEY  = process.env.ASAAS_API_KEY;
const SUPA_URL   = process.env.SUPABASE_URL;
const SUPA_KEY   = process.env.SUPABASE_SERVICE_KEY;

// ── Pacotes de créditos extras (preço e quantidade definidos SÓ aqui) ──
const PACOTES = {
  p50:  { quantidade: 50,  valor: 13.90, descricao: 'ANT Capital — Pacote +50 créditos do Assistente' },
  p100: { quantidade: 100, valor: 27.90, descricao: 'ANT Capital — Pacote +100 créditos do Assistente' },
};

function hojeBrasil() {
  // Data de hoje no fuso de São Paulo (YYYY-MM-DD), exigida pelo Asaas
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date());
}

async function supaRpc(nome, args) {
  const r = await fetch(`${SUPA_URL}/rest/v1/rpc/${nome}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: SUPA_KEY, Authorization: `Bearer ${SUPA_KEY}` },
    body: JSON.stringify(args)
  });
  const txt = await r.text();
  if (!r.ok) throw new Error(`[supabase] ${nome}: ${txt}`);
  return txt ? JSON.parse(txt) : null;
}

async function usuarioDoToken(req) {
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!token) return null;
  const r = await fetch(`${SUPA_URL}/auth/v1/user`, { headers: { apikey: SUPA_KEY, Authorization: `Bearer ${token}` } });
  if (!r.ok) return null;
  return r.json();
}

// ── Compra avulsa de créditos ────────────────────────────────────────────
async function comprarCreditos(req, res) {
  const user = await usuarioDoToken(req);
  if (!user?.id) return res.status(401).json({ error: 'Faça login novamente para comprar créditos.' });

  const { pacote, nome, email, cpf, billingType = 'PIX', creditCard, creditCardHolderInfo, remoteIp } = req.body;
  const p = PACOTES[pacote];
  if (!p) return res.status(400).json({ error: 'Pacote inválido.' });
  if (!nome || !email || !cpf) return res.status(400).json({ error: 'Campos obrigatórios: nome, email, cpf' });

  const ehCartao = billingType === 'CREDIT_CARD';
  if (ehCartao) {
    if (!creditCard?.holderName || !creditCard?.number || !creditCard?.expiryMonth || !creditCard?.expiryYear || !creditCard?.ccv) {
      return res.status(400).json({ error: 'Dados do cartão incompletos.' });
    }
    if (!creditCardHolderInfo?.name || !creditCardHolderInfo?.cpfCnpj || !creditCardHolderInfo?.postalCode || !creditCardHolderInfo?.addressNumber) {
      return res.status(400).json({ error: 'Dados do titular do cartão incompletos.' });
    }
    if (!remoteIp) return res.status(400).json({ error: 'IP do cliente não informado.' });
  }

  const headers = { 'Content-Type': 'application/json', access_token: ASAAS_KEY, 'User-Agent': 'ANTCapital/1.0' };

  try {
    // 1. Só assinante ativo compra créditos (os créditos só funcionam com o plano)
    const supaGet = async (q) => {
      const r = await fetch(`${SUPA_URL}/rest/v1/${q}`, { headers: { apikey: SUPA_KEY, Authorization: `Bearer ${SUPA_KEY}` } });
      return r.ok ? r.json() : [];
    };
    const [assin, essencial] = await Promise.all([
      supaGet(`assinaturas?user_id=eq.${user.id}&select=status,asaas_customer_id`),
      supaGet(`assinaturas_essencial?client_id=eq.${user.id}&select=status`)
    ]);
    const ativo = assin[0]?.status === 'ACTIVE' || essencial[0]?.status === 'ativa';
    if (!ativo) {
      return res.status(403).json({ error: 'Os créditos extras são exclusivos para assinantes com o plano ativo.' });
    }

    // 2. Reaproveita o cliente do Asaas da assinatura; se não houver, cria
    let customerId = assin[0]?.asaas_customer_id || null;
    if (!customerId) {
      const cr = await fetch(`${ASAAS_BASE}/customers`, {
        method: 'POST', headers,
        body: JSON.stringify({ name: nome, email, cpfCnpj: String(cpf).replace(/\D/g, ''), notificationDisabled: false })
      });
      const cd = await cr.json();
      if (!cr.ok || cd.errors) {
        return res.status(500).json({ error: cd.errors?.[0]?.description || 'Erro ao criar cliente no Asaas' });
      }
      customerId = cd.id;
    }

    // 3. Cria a cobrança avulsa
    const body = {
      customer: customerId,
      billingType: ehCartao ? 'CREDIT_CARD' : 'PIX',
      value: p.valor,
      dueDate: hojeBrasil(),
      description: p.descricao,
      externalReference: `creditos:${user.id}:${pacote}`
    };
    if (ehCartao) {
      body.creditCard = {
        holderName: creditCard.holderName,
        number: String(creditCard.number).replace(/\D/g, ''),
        expiryMonth: String(creditCard.expiryMonth).padStart(2, '0'),
        expiryYear: String(creditCard.expiryYear),
        ccv: creditCard.ccv
      };
      body.creditCardHolderInfo = {
        name: creditCardHolderInfo.name,
        email: creditCardHolderInfo.email || email,
        cpfCnpj: String(creditCardHolderInfo.cpfCnpj).replace(/\D/g, ''),
        postalCode: String(creditCardHolderInfo.postalCode).replace(/\D/g, ''),
        addressNumber: creditCardHolderInfo.addressNumber,
        phone: String(creditCardHolderInfo.phone || '').replace(/\D/g, '') || undefined
      };
      body.remoteIp = remoteIp;
    }
    const pr = await fetch(`${ASAAS_BASE}/payments`, { method: 'POST', headers, body: JSON.stringify(body) });
    const pd = await pr.json();
    if (!pr.ok || pd.errors) {
      console.error('[Asaas] Erro ao criar cobrança de créditos:', pd);
      return res.status(500).json({ error: pd.errors?.[0]?.description || 'Erro ao processar pagamento.' });
    }

    // 4. Registra a compra; cartão aprovado já libera os créditos
    await supaRpc('_registrar_compra_creditos', {
      p_user_id: user.id, p_pacote: pacote, p_quantidade: p.quantidade, p_valor: p.valor, p_payment_id: pd.id
    });
    let creditos = null;
    const aprovado = ['CONFIRMED', 'RECEIVED'].includes(pd.status);
    if (aprovado) creditos = await supaRpc('_confirmar_compra_creditos', { p_payment_id: pd.id });

    return res.status(200).json({
      ok: true,
      tipo: 'creditos',
      pacote,
      quantidade: p.quantidade,
      pagamentoImediato: aprovado,
      linkPagamento: aprovado ? null : (pd.invoiceUrl || null),
      creditos,
      mensagem: aprovado
        ? `Pagamento aprovado! +${p.quantidade} créditos adicionados.`
        : 'Cobrança gerada! Os créditos entram assim que o pagamento for confirmado.'
    });
  } catch (err) {
    console.error('[asaas-checkout] Erro na compra de créditos:', err);
    return res.status(500).json({ error: 'Erro interno ao comprar créditos' });
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Método não permitido' });
  }

  // Compra de pacote de créditos (cobrança avulsa)
  if (req.body?.tipo === 'creditos') {
    return comprarCreditos(req, res);
  }

  const {
    user_id, nome, email, cpf,
    valor = 79.90, ciclo = 'MONTHLY',
    billingType = 'UNDEFINED',
    creditCard,
    creditCardHolderInfo,
    remoteIp
  } = req.body;

  if (!user_id || !nome || !email || !cpf) {
    return res.status(400).json({ error: 'Campos obrigatórios: user_id, nome, email, cpf' });
  }

  // Validação extra para cartão
  if (billingType === 'CREDIT_CARD') {
    if (!creditCard || !creditCard.holderName || !creditCard.number ||
        !creditCard.expiryMonth || !creditCard.expiryYear || !creditCard.ccv) {
      return res.status(400).json({ error: 'Dados do cartão incompletos.' });
    }
    if (!creditCardHolderInfo || !creditCardHolderInfo.name || !creditCardHolderInfo.cpfCnpj ||
        !creditCardHolderInfo.postalCode || !creditCardHolderInfo.addressNumber) {
      return res.status(400).json({ error: 'Dados do titular do cartão incompletos.' });
    }
    if (!remoteIp) {
      return res.status(400).json({ error: 'IP do cliente não informado.' });
    }
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

    // Monta o body da assinatura conforme o método de pagamento
    const assinaturaBody = {
      customer: asaas_customer_id,
      billingType: billingType === 'CREDIT_CARD' ? 'CREDIT_CARD' : 'UNDEFINED',
      value: valor,
      nextDueDate: proxVenc,
      cycle: ciclo,
      description: 'ANT Capital — Plano Mensal de Planejamento Financeiro',
      externalReference: user_id  // liga ao user_id do Supabase
    };

    // Adiciona dados do cartão quando necessário
    if (billingType === 'CREDIT_CARD') {
      assinaturaBody.creditCard = {
        holderName:  creditCard.holderName,
        number:      creditCard.number.replace(/\D/g, ''),
        expiryMonth: String(creditCard.expiryMonth).padStart(2, '0'),
        expiryYear:  String(creditCard.expiryYear),
        ccv:         creditCard.ccv
      };
      assinaturaBody.creditCardHolderInfo = {
        name:          creditCardHolderInfo.name,
        email:         creditCardHolderInfo.email || email,
        cpfCnpj:       creditCardHolderInfo.cpfCnpj.replace(/\D/g, ''),
        postalCode:    creditCardHolderInfo.postalCode.replace(/\D/g, ''),
        addressNumber: creditCardHolderInfo.addressNumber,
        phone:         (creditCardHolderInfo.phone || '').replace(/\D/g, '') || undefined
      };
      assinaturaBody.remoteIp = remoteIp;
    }

    const assinaturaRes = await fetch(`${ASAAS_BASE}/subscriptions`, {
      method: 'POST',
      headers,
      body: JSON.stringify(assinaturaBody)
    });

    const assinaturaData = await assinaturaRes.json();

    if (!assinaturaRes.ok || assinaturaData.errors) {
      console.error('[Asaas] Erro ao criar assinatura:', assinaturaData);

      // Extrai mensagem amigável dos erros do Asaas
      let mensagemErro = 'Erro ao processar pagamento.';
      if (assinaturaData.errors && assinaturaData.errors.length > 0) {
        const primeiro = assinaturaData.errors[0];
        mensagemErro = primeiro.description || primeiro.code || mensagemErro;
      }

      return res.status(500).json({
        error: mensagemErro,
        detalhes: assinaturaData.errors || assinaturaData
      });
    }

    const asaas_subscription_id = assinaturaData.id;

    // ── 3. Para PIX/UNDEFINED: buscar link de pagamento da 1ª cobrança ─────
    let linkPagamento = null;
    let pagamentoImediato = false;

    if (billingType === 'CREDIT_CARD') {
      // Cartão: pagamento já processado imediatamente, não precisa de link
      pagamentoImediato = true;
    } else {
      // PIX/Undefined: busca o link de pagamento gerado
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
    }

    // ── 4. Salvar no Supabase ──────────────────────────────────────────────
    const statusInicial = pagamentoImediato ? 'ACTIVE' : 'PENDING';

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
        status: statusInicial,
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

    // ── 5. Retornar sucesso ────────────────────────────────────────────────
    return res.status(200).json({
      ok: true,
      asaas_customer_id,
      asaas_subscription_id,
      pagamentoImediato,
      linkPagamento,
      mensagem: pagamentoImediato
        ? 'Assinatura ativada com sucesso! Seu acesso foi liberado.'
        : linkPagamento
          ? 'Assinatura criada! Redirecionando para o pagamento...'
          : 'Assinatura criada! Você receberá o link de pagamento por e-mail.'
    });

  } catch (err) {
    console.error('[asaas-checkout] Erro inesperado:', err);
    return res.status(500).json({ error: 'Erro interno do servidor', detalhes: err.message });
  }
}
