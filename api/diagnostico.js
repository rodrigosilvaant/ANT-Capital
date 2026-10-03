// Confere o login (token do Supabase) e se o usuário tem papel de consultor.
async function validarConsultor(req) {
  const SUPA_URL = process.env.SUPABASE_URL;
  const SUPA_KEY = process.env.SUPABASE_SERVICE_KEY;
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!token) return { ok: false, status: 401, erro: 'Login necessário' };
  if (!SUPA_URL || !SUPA_KEY) return { ok: false, status: 500, erro: 'Supabase não configurado no Vercel' };

  try {
    const userRes = await fetch(`${SUPA_URL}/auth/v1/user`, {
      headers: { apikey: SUPA_KEY, Authorization: `Bearer ${token}` }
    });
    if (!userRes.ok) return { ok: false, status: 401, erro: 'Sessão inválida. Entre novamente.' };
    const user = await userRes.json();

    const perfilRes = await fetch(
      `${SUPA_URL}/rest/v1/profiles?id=eq.${encodeURIComponent(user.id)}&select=role`,
      { headers: { apikey: SUPA_KEY, Authorization: `Bearer ${SUPA_KEY}` } }
    );
    const perfil = perfilRes.ok ? await perfilRes.json() : [];
    if (perfil[0]?.role !== 'consultor') {
      return { ok: false, status: 403, erro: 'Apenas o consultor pode gerar diagnósticos' };
    }
    return { ok: true, userId: user.id };
  } catch (e) {
    return { ok: false, status: 500, erro: 'Falha ao validar acesso' };
  }
}

export default async function handler(req, res) {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Método não permitido' });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'ANTHROPIC_API_KEY não configurada no Vercel' });
  }

  // ── Só o consultor logado pode usar esta API ─────────────────────────
  const consultor = await validarConsultor(req);
  if (!consultor.ok) {
    return res.status(consultor.status).json({ error: consultor.erro });
  }

  try {
    // Leitura explícita do body
    let body = req.body;
    if (!body || typeof body === 'string') {
      const raw = await new Promise((resolve, reject) => {
        let data = '';
        req.on('data', chunk => { data += chunk.toString(); });
        req.on('end', () => resolve(data));
        req.on('error', reject);
      });
      try { body = JSON.parse(raw); } catch(e) {
        return res.status(400).json({ error: 'Body inválido: ' + raw.slice(0, 100) });
      }
    }

    if (!body.messages) {
      return res.status(400).json({ error: 'Campo messages ausente no body', received: Object.keys(body) });
    }

    const payload = {
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1500,
      system: body.system || '',
      messages: body.messages
    };

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify(payload)
    });

    const data = await response.json();

    if (!response.ok) {
      return res.status(response.status).json({
        error: data.error?.message || 'Erro Anthropic',
        type: data.error?.type,
        status: response.status
      });
    }

    return res.status(200).json(data);

  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}
