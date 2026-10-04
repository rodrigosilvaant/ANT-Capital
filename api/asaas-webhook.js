// api/asaas-webhook.js
// Recebe notificações do Asaas e atualiza o status da assinatura no Supabase
// POST /api/asaas-webhook
// Configure no painel Asaas: Configurações → Notificações → Webhook → URL deste endpoint

const SUPA_URL  = process.env.SUPABASE_URL;
const SUPA_KEY  = process.env.SUPABASE_SERVICE_KEY;
// Opcional mas recomendado: valide o token secreto do webhook
const WEBHOOK_TOKEN = process.env.ASAAS_WEBHOOK_TOKEN || 'whsec_EABcJNTrDu1AMTL6CNQ15aEmTCt_B_zCbT257JPtIt0';

// Mapeamento de eventos Asaas → status interno
const MAPA_STATUS = {
  // Assinatura
  'SUBSCRIPTION_CREATED':   'PENDING',
  'SUBSCRIPTION_RENEWED':   'ACTIVE',
  'SUBSCRIPTION_CANCELLED':   'CANCELLED',
  'SUBSCRIPTION_DELETED':     'CANCELLED',
  'SUBSCRIPTION_INACTIVATED': 'CANCELLED',
  // Cobranças
  'PAYMENT_CONFIRMED':      'ACTIVE',
  'PAYMENT_RECEIVED':       'ACTIVE',
  'PAYMENT_OVERDUE':        'OVERDUE',
  'PAYMENT_DELETED':        null,       // ignora
  'PAYMENT_RESTORED':       'ACTIVE',
  'PAYMENT_REFUNDED':       'CANCELLED',
  'PAYMENT_CHARGEBACK_REQUESTED': 'OVERDUE',
  'PAYMENT_CHARGEBACK_DISPUTE':   'OVERDUE',
};

const EVENTOS_PAGO = ['PAYMENT_CONFIRMED', 'PAYMENT_RECEIVED'];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Método não permitido' });
  }

  // Validação do token (se configurado)
  if (WEBHOOK_TOKEN) {
    const tokenRecebido = req.headers['asaas-access-token'] || req.query.token;
    if (tokenRecebido !== WEBHOOK_TOKEN) {
      console.warn('[webhook] Token inválido recebido:', tokenRecebido);
      return res.status(401).json({ error: 'Token inválido' });
    }
  }

  const evento = req.body;
  const tipoEvento = evento?.event;

  console.log('[webhook] Evento recebido:', tipoEvento, JSON.stringify(evento).slice(0, 300));

  // ── Compra de pacote de créditos (cobrança avulsa) ─────────────────────
  const refPagamento = evento?.payment?.externalReference || '';
  if (refPagamento.startsWith('creditos:')) {
    if (EVENTOS_PAGO.includes(tipoEvento) && evento.payment?.id) {
      try {
        const r = await supaRpc('_confirmar_compra_creditos', { p_payment_id: evento.payment.id });
        console.log('[webhook] Créditos:', JSON.stringify(r));
      } catch (e) {
        console.error('[webhook] Erro ao confirmar créditos:', e.message);
        return res.status(500).json({ error: 'Erro ao confirmar créditos' });
      }
    }
    return res.status(200).json({ ok: true, tipo: 'creditos' });
  }

  // Ignora eventos que não gerenciam status de assinatura
  const novoStatus = MAPA_STATUS[tipoEvento];
  if (novoStatus === undefined) {
    return res.status(200).json({ ok: true, ignorado: true, evento: tipoEvento });
  }
  if (novoStatus === null) {
    return res.status(200).json({ ok: true, ignorado: true });
  }

  // Extrai identificadores do payload
  const payment     = evento.payment     || {};
  const subscription = evento.subscription || {};

  // O externalReference foi definido como user_id no checkout
  const externalRef = payment.externalReference
    || subscription.externalReference
    || null;

  // ID da assinatura no Asaas
  const asaas_subscription_id = payment.subscription
    || subscription.id
    || null;

  if (!externalRef && !asaas_subscription_id) {
    console.warn('[webhook] Nenhum identificador encontrado no payload');
    return res.status(200).json({ ok: true, aviso: 'sem identificador' });
  }

  try {
    // Monta filtro de busca: por user_id (externalReference) ou por subscription_id
    let filtro = externalRef
      ? `user_id=eq.${externalRef}`
      : `asaas_subscription_id=eq.${asaas_subscription_id}`;

    // Monta payload de atualização
    const update = { status: novoStatus, updated_at: new Date().toISOString() };

    // Se pagamento confirmado, atualiza próximo vencimento
    if (novoStatus === 'ACTIVE' && payment.dueDate) {
      const proxDt = new Date(payment.dueDate);
      proxDt.setMonth(proxDt.getMonth() + 1);
      update.proximo_vencimento = proxDt.toISOString().split('T')[0];
    }

    // Se temos o subscription_id e ainda não estava salvo, atualiza também
    if (asaas_subscription_id) {
      update.asaas_subscription_id = asaas_subscription_id;
    }

    const patchRes = await fetch(
      `${SUPA_URL}/rest/v1/assinaturas?${filtro}`,
      {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'apikey': SUPA_KEY,
          'Authorization': `Bearer ${SUPA_KEY}`,
          'Prefer': 'return=minimal'
        },
        body: JSON.stringify(update)
      }
    );

    if (!patchRes.ok) {
      const err = await patchRes.text();
      console.error('[webhook] Erro ao atualizar Supabase:', err);
      return res.status(500).json({ error: 'Erro ao atualizar banco', detalhes: err });
    }

    console.log(`[webhook] Status atualizado → ${novoStatus} (filtro: ${filtro})`);

    // ── Mensalidade paga: renova os créditos do plano (uma vez por pagamento)
    if (EVENTOS_PAGO.includes(tipoEvento) && payment.id) {
      try {
        let userId = UUID_RE.test(externalRef || '') ? externalRef : null;
        if (!userId && asaas_subscription_id) {
          const r = await fetch(`${SUPA_URL}/rest/v1/assinaturas?asaas_subscription_id=eq.${asaas_subscription_id}&select=user_id`, {
            headers: { apikey: SUPA_KEY, Authorization: `Bearer ${SUPA_KEY}` }
          });
          if (r.ok) userId = (await r.json())[0]?.user_id || null;
        }
        if (userId) {
          const rc = await supaRpc('_renovar_creditos', { p_user_id: userId, p_referencia: payment.id });
          console.log('[webhook] Renovação de créditos:', JSON.stringify(rc));
        }
      } catch (e) {
        // Não derruba o webhook: o status da assinatura já foi atualizado
        console.error('[webhook] Erro ao renovar créditos:', e.message);
      }
    }

    return res.status(200).json({ ok: true, status: novoStatus });

  } catch (err) {
    console.error('[webhook] Erro inesperado:', err);
    return res.status(500).json({ error: err.message });
  }
}
