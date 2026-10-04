// api/chat.js — Vercel Serverless Function
// GET  /api/chat  → { assinatura_ativa, modo: 'personalizado' | 'inicial' }
// POST /api/chat  → { resposta, tokens, modo, creditos }
//   402 SEM_ASSINATURA | 402 SEM_CREDITOS
//   Recebe: { mensagem, historico[], dadosFinanceiros }
//
// Modelo híbrido:
//   - Quem tem assinatura ativa já usa o assistente no "modo inicial"
//     (orientação padrão da ANT + dados que o cliente lança no app).
//   - Depois do diagnóstico, o consultor ativa o agente e o assistente
//     passa a usar o prompt personalizado do cliente ("modo personalizado").

const Anthropic = require('@anthropic-ai/sdk');
const { createClient } = require('@supabase/supabase-js');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const sb = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY // chave de serviço (não a publishable)
);

// Usuários com acesso liberado sem assinatura (consultor)
const USUARIOS_ISENTOS = ['c52e0d58-27f5-46f3-bbae-06fb9a47171f'];

const LIMITE_MENSAGEM = 2000;   // caracteres por mensagem
const LIMITE_HISTORICO = 10;    // mensagens anteriores enviadas à IA

const PROMPT_MODO_INICIAL = `Você é o Assistente ANT, da ANT Capital, consultoria de planejamento financeiro de Rodrigo Silva.

Este cliente assinou recentemente e ainda não fez o diagnóstico com o Rodrigo. Por isso você está no MODO INICIAL: você conhece apenas os dados que o cliente registrou no app, e ainda não conhece os objetivos, o perfil e as prioridades dele.

Como agir:
- Use linguagem formal, mas com palavras simples, para que quem não entende de finanças compreenda. Seja breve, prático e encorajador.
- Baseie suas respostas nos dados financeiros reais do cliente, quando eles existirem. Nunca invente números. Se faltarem dados, oriente o cliente a registrar receitas e despesas no app.
- Ajude com: organização do orçamento, controle de gastos, reserva de emergência, priorização e negociação de dívidas e criação de hábitos financeiros.
- Não recomende produtos de investimento específicos (ações, fundos, títulos, corretoras ou bancos) e não dê orientação jurídica ou tributária.
- Quando o assunto depender de conhecer os objetivos e o perfil do cliente (como investir, decisões grandes, plano de longo prazo), explique que o diagnóstico com o Rodrigo vai personalizar essa orientação e convide-o a agendar pelo botão "Agendar diagnóstico", no topo do chat. Faça esse convite só quando for relevante, não em toda resposta.`;

async function identificarUsuario(req) {
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!token) return null;
  const { data, error } = await sb.auth.getUser(token);
  if (error || !data?.user) return null;
  return data.user;
}

async function verificarAcesso(userId) {
  if (USUARIOS_ISENTOS.includes(userId)) return { ativa: true, consultor: true };

  const [perfil, assinatura, essencial] = await Promise.all([
    sb.from('profiles').select('role').eq('id', userId).maybeSingle(),
    sb.from('assinaturas').select('status').eq('user_id', userId).maybeSingle(),
    sb.from('assinaturas_essencial').select('status').eq('client_id', userId).maybeSingle(),
  ]);

  const consultor = perfil.data?.role === 'consultor';
  const ativa = consultor
    || assinatura.data?.status === 'ACTIVE'
    || essencial.data?.status === 'ativa';
  return { ativa, consultor };
}

// Créditos: 1 crédito = 1 pergunta. O consultor não consome créditos.
async function resumoCreditos(userId) {
  await sb.rpc('_garantir_saldo', { p_user_id: userId });
  const { data } = await sb.rpc('_resumo_creditos', { p_user_id: userId });
  return data || null;
}

async function buscarAgente(userId) {
  const [diag, prompt] = await Promise.all([
    sb.from('diagnostico_essencial').select('ativo').eq('client_id', userId).maybeSingle(),
    sb.from('prompt_agente').select('prompt_text').eq('client_id', userId).maybeSingle(),
  ]);
  const personalizado = !!diag.data?.ativo && !!prompt.data?.prompt_text;
  return {
    modo: personalizado ? 'personalizado' : 'inicial',
    prompt: personalizado ? prompt.data.prompt_text : PROMPT_MODO_INICIAL,
  };
}

module.exports = async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ erro: 'Método não permitido' });
  }

  try {
    const user = await identificarUsuario(req);
    if (!user) return res.status(401).json({ erro: 'Usuário não autenticado' });

    const acesso = await verificarAcesso(user.id);

    // ── GET: status do assistente (usado pelo app para mostrar o aviso certo)
    if (req.method === 'GET') {
      if (!acesso.ativa) return res.status(200).json({ assinatura_ativa: false, modo: null });
      const { modo } = await buscarAgente(user.id);
      const creditos = acesso.consultor ? { ilimitado: true } : await resumoCreditos(user.id);
      return res.status(200).json({ assinatura_ativa: true, modo, consultor: acesso.consultor, creditos });
    }

    // ── POST: conversa
    if (!acesso.ativa) {
      return res.status(402).json({ erro: 'Assinatura necessária', codigo: 'SEM_ASSINATURA' });
    }

    const { mensagem, historico = [], dadosFinanceiros = '' } = req.body || {};
    if (!mensagem || typeof mensagem !== 'string') {
      return res.status(400).json({ erro: 'Mensagem obrigatória' });
    }

    // Desconta 1 crédito ANTES de chamar a IA (operação atômica no banco)
    let consumo = null;
    if (!acesso.consultor) {
      const { data: c, error: ec } = await sb.rpc('_consumir_credito', { p_user_id: user.id });
      if (ec) {
        console.error('[chat] Erro ao consumir crédito:', ec);
        return res.status(500).json({ erro: 'Não foi possível verificar seus créditos' });
      }
      if (!c?.ok) {
        const { ok, origem, ...creditos } = c || {};
        return res.status(402).json({ erro: 'Seus créditos acabaram', codigo: 'SEM_CREDITOS', creditos });
      }
      consumo = c;
    }

    const { modo, prompt } = await buscarAgente(user.id);
    const systemPrompt = prompt + (typeof dadosFinanceiros === 'string' ? dadosFinanceiros : '');

    // Histórico: só mensagens válidas de usuário/assistente, começando pelo usuário
    let anteriores = (Array.isArray(historico) ? historico : [])
      .filter(m => (m?.role === 'user' || m?.role === 'assistant') && typeof m.content === 'string' && m.content.trim())
      .slice(-LIMITE_HISTORICO)
      .map(m => ({ role: m.role, content: m.content.slice(0, LIMITE_MENSAGEM) }));
    while (anteriores.length && anteriores[0].role !== 'user') anteriores.shift();
    // O app já inclui a mensagem atual no histórico: evita enviá-la duas vezes
    const ultimaAnterior = anteriores[anteriores.length - 1];
    if (ultimaAnterior?.role === 'user' && ultimaAnterior.content.trim() === mensagem.trim().slice(0, LIMITE_MENSAGEM)) {
      anteriores.pop();
    }

    // A API exige alternância user/assistant: junta mensagens seguidas do mesmo papel
    const messages = [];
    for (const m of [...anteriores, { role: 'user', content: mensagem.slice(0, LIMITE_MENSAGEM) }]) {
      const ultima = messages[messages.length - 1];
      if (ultima && ultima.role === m.role) ultima.content += '\n\n' + m.content;
      else messages.push({ ...m });
    }

    let response;
    try {
      response = await anthropic.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1024,
        system: systemPrompt,
        messages
      });
    } catch (errIA) {
      // A IA falhou: devolve o crédito, o cliente não paga por erro
      if (consumo) await sb.rpc('_estornar_credito', { p_user_id: user.id, p_origem: consumo.origem });
      throw errIA;
    }

    const resposta = response.content[0]?.text || 'Não consegui processar sua mensagem.';
    const tokensUsados = (response.usage?.input_tokens || 0) + (response.usage?.output_tokens || 0);

    let creditos = { ilimitado: true };
    if (consumo) { const { ok, origem, ...resto } = consumo; creditos = resto; }

    return res.status(200).json({ resposta, tokens: tokensUsados, modo, creditos });

  } catch (err) {
    console.error('Erro no chat:', err);
    return res.status(500).json({ erro: 'Erro interno' });
  }
};
