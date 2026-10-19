// api/planejador.js — Painel do planejador para o card "Seu planejador"
//
// GET /api/planejador  (com login) → { painel resumido, alertas, checkup }
//   402 SEM_ASSINATURA quando o cliente não tem assinatura ativa.
// Os cálculos são feitos no servidor (_motor.js), com os dados do próprio usuário.

import motor from './_motor.js';

const SUPA_URL = process.env.SUPABASE_URL;
const SUPA_KEY = process.env.SUPABASE_SERVICE_KEY;
const USUARIOS_ISENTOS = ['c52e0d58-27f5-46f3-bbae-06fb9a47171f'];

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
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET') return res.status(405).json({ erro: 'Método não permitido' });
  try {
    const user = await usuarioDoToken(req);
    if (!user?.id) return res.status(401).json({ erro: 'Usuário não autenticado' });
    if (!(await temAcesso(user.id))) return res.status(402).json({ erro: 'Assinatura necessária', codigo: 'SEM_ASSINATURA' });

    const p = motor.calcularPainel(await motor.carregarDados(user.id));
    return res.status(200).json({
      tem_dados: p.tem_dados,
      gerado_em: p.gerado_em, mes: p.mes, nome_mes: p.nome_mes, dia: p.dia, dias_no_mes: p.dias_no_mes,
      meses_historico: p.meses_historico,
      mes_atual: p.mes_atual,
      medias: p.medias,
      acima_do_normal: p.acima_do_normal,
      orcamento: p.orcamento,
      reserva: p.reserva,
      metas: p.metas,
      dividas_resumo: { total_parcelas: p.dividas_resumo.total_parcelas, comprometimento_renda: p.dividas_resumo.comprometimento_renda, saldo_devedor_total: p.dividas_resumo.saldo_devedor_total },
      alertas: p.alertas,
      checkup: p.dia <= 7 ? p.checkup_mes_anterior : null,
    });
  } catch (err) {
    console.error('[planejador] Erro:', err);
    return res.status(500).json({ erro: 'Erro interno' });
  }
}
