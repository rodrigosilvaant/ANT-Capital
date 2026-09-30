// api/chat.js — Vercel Serverless Function
// Rota: POST /api/chat
// Recebe: { mensagem, historico[] }
// Retorna: { resposta }

const Anthropic = require('@anthropic-ai/sdk');
const { createClient } = require('@supabase/supabase-js');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const sb = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY // chave de serviço (não a publishable)
);

module.exports = async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ erro: 'Método não permitido' });

  try {
    const { mensagem, historico = [] } = req.body;
    if (!mensagem) return res.status(400).json({ erro: 'Mensagem obrigatória' });

    // Identificar cliente pelo token JWT do Supabase
    const authHeader = req.headers.authorization || '';
    const token = authHeader.replace('Bearer ', '');
    if (!token) return res.status(401).json({ erro: 'Token não fornecido' });

    const { data: { user }, error: authErr } = await sb.auth.getUser(token);
    if (authErr || !user) return res.status(401).json({ erro: 'Usuário não autenticado' });

    const clienteId = user.id;

    // Buscar prompt personalizado do cliente
    const { data: promptRow } = await sb
      .from('prompt_agente')
      .select('prompt_text')
      .eq('client_id', clienteId)
      .single();

    // Verificar se agente está ativo
    const { data: diagRow } = await sb
      .from('diagnostico_essencial')
      .select('ativo')
      .eq('client_id', clienteId)
      .single();

    if (!diagRow?.ativo) {
      return res.status(403).json({ erro: 'Agente não ativado para este cliente' });
    }

    const systemPrompt = promptRow?.prompt_text ||
      'Você é o Assistente ANT, planejador financeiro pessoal da ANT Capital. Seja próximo, humano e encorajador. Use linguagem simples e seja breve.';

    // Montar histórico para a API (últimas 10 trocas)
    const messages = [
      ...historico.slice(-10).map(m => ({
        role: m.role,
        content: m.content
      })),
      { role: 'user', content: mensagem }
    ];

    // Chamar API da Anthropic
    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1024,
      system: systemPrompt,
      messages
    });

    const resposta = response.content[0]?.text || 'Não consegui processar sua mensagem.';
    const tokensUsados = response.usage?.input_tokens + response.usage?.output_tokens || 0;

    return res.status(200).json({ resposta, tokens: tokensUsados });

  } catch (err) {
    console.error('Erro no chat:', err);
    return res.status(500).json({ erro: 'Erro interno', detalhe: err.message });
  }
};
