// api/asaas-status.js
// Verifica se o usuário tem assinatura ativa no Supabase
// GET /api/asaas-status?user_id=xxx
// Retorna: { ativo: true|false, status: 'ACTIVE'|'PENDING'|'OVERDUE'|'CANCELLED'|null }

const SUPA_URL = process.env.SUPABASE_URL;
const SUPA_KEY = process.env.SUPABASE_SERVICE_KEY;

// IDs de usuários que sempre têm acesso (consultores / você mesmo)
const USUARIOS_ISENTOS = [
  'c52e0d58-27f5-46f3-bbae-06fb9a47171f'  // Rodrigo — consultor
];

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Método não permitido' });
  }

  const { user_id } = req.query;

  if (!user_id) {
    return res.status(400).json({ error: 'user_id é obrigatório' });
  }

  // Consultores sempre têm acesso — sem verificação
  if (USUARIOS_ISENTOS.includes(user_id)) {
    return res.status(200).json({ ativo: true, status: 'ISENTO', isento: true });
  }

  try {
    const resp = await fetch(
      `${SUPA_URL}/rest/v1/assinaturas?user_id=eq.${user_id}&select=status,proximo_vencimento,valor`,
      {
        headers: {
          'apikey': SUPA_KEY,
          'Authorization': `Bearer ${SUPA_KEY}`
        }
      }
    );

    const data = await resp.json();

    if (!data || data.length === 0) {
      // Sem registro — nunca assinou
      return res.status(200).json({ ativo: false, status: null });
    }

    const assinatura = data[0];
    const ativo = assinatura.status === 'ACTIVE';

    return res.status(200).json({
      ativo,
      status: assinatura.status,
      proximo_vencimento: assinatura.proximo_vencimento,
      valor: assinatura.valor
    });

  } catch (err) {
    console.error('[asaas-status] Erro:', err);
    // Em caso de erro de rede/Supabase, libera acesso para não travar usuário
    return res.status(200).json({ ativo: true, status: 'ERRO_VERIFICACAO', erro: true });
  }
}
