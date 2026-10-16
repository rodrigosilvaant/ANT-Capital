// api/lembretes.js — Lembretes de contas a pagar (notificação no celular + e-mail)
//
// GET  /api/lembretes            → tarefa diária (Vercel Cron, 08h de Brasília)
//                                  exige Authorization: Bearer CRON_SECRET
// GET  /api/lembretes?vapid=1    → chave pública para o app ativar as notificações
// POST /api/lembretes {acao:'teste'} (com login) → envia uma notificação de teste
//
// Variáveis no Vercel:
//   VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, CRON_SECRET  (obrigatórias)
//   RESEND_API_KEY, EMAIL_REMETENTE                   (opcionais — e-mail)

import webpush from 'web-push';

const SUPA_URL = process.env.SUPABASE_URL;
const SUPA_KEY = process.env.SUPABASE_SERVICE_KEY;
const VAPID_PUBLIC = process.env.VAPID_PUBLIC_KEY;
const VAPID_PRIVATE = process.env.VAPID_PRIVATE_KEY;
const CRON_SECRET = process.env.CRON_SECRET;
const RESEND_KEY = process.env.RESEND_API_KEY;
const EMAIL_REMETENTE = process.env.EMAIL_REMETENTE || 'ANT Capital <lembretes@antcapital.com.br>';
const APP_URL = 'https://app.antcapital.com.br';

if (VAPID_PUBLIC && VAPID_PRIVATE) {
  webpush.setVapidDetails('mailto:rodrigo@antcapital.com.br', VAPID_PUBLIC, VAPID_PRIVATE);
}

// ── Utilidades ──────────────────────────────────────────────────────────
async function supaRpc(nome, args = {}) {
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
  return r.ok ? r.json() : null;
}

function hojeBrasil() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date());
}
const reais = v => Number(v || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const dataBR = iso => { const [a, m, d] = String(iso).slice(0, 10).split('-'); return `${d}/${m}`; };
const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const ROTULO = { antes: 'vence em breve', dia: 'vence hoje', atraso: 'está em atraso' };
const ORDEM = { atraso: 0, dia: 1, antes: 2 };

// Monta o texto do lembrete (um por pessoa, juntando todas as contas do dia)
function montarMensagem(itens) {
  itens = [...itens].sort((a, b) => ORDEM[a.tipo] - ORDEM[b.tipo] || String(a.vencimento).localeCompare(b.vencimento));
  const linha = i => {
    const quando = i.tipo === 'dia' ? 'hoje' : i.tipo === 'atraso' ? `venceu ${dataBR(i.vencimento)}` : `vence ${dataBR(i.vencimento)}`;
    return `${i.descricao}${Number(i.valor) > 0 ? ' (' + reais(i.valor) + ')' : ''} — ${quando}`;
  };
  let titulo;
  if (itens.length === 1) {
    const i = itens[0];
    titulo = i.tipo === 'antes' ? `📅 ${i.descricao} vence em ${dataBR(i.vencimento)}`
           : i.tipo === 'dia' ? `⏰ ${i.descricao} vence hoje`
           : `⚠️ ${i.descricao} está em atraso`;
  } else {
    const temAtraso = itens.some(i => i.tipo === 'atraso');
    titulo = `${temAtraso ? '⚠️' : '📅'} ${itens.length} contas para lembrar`;
  }
  return { titulo, linhas: itens.map(linha), itens };
}

async function enviarPush(userId, payload) {
  const inscricoes = await supaRpc('_push_do_usuario', { p_user_id: userId }) || [];
  let enviados = 0;
  for (const s of inscricoes) {
    try {
      await webpush.sendNotification(
        { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
        JSON.stringify(payload), { TTL: 60 * 60 * 12 }
      );
      enviados++;
    } catch (e) {
      // 404/410: o aparelho não aceita mais (app desinstalado, permissão retirada)
      if (e.statusCode === 404 || e.statusCode === 410) await supaRpc('_push_remover', { p_endpoint: s.endpoint });
      else console.error('[lembretes] Falha no push:', e.statusCode, e.body || e.message);
    }
  }
  return enviados;
}

async function enviarEmail(para, nome, msg) {
  if (!RESEND_KEY || !para) return false;
  const lista = msg.linhas.map(l => `<li style="margin:6px 0">${esc(l)}</li>`).join('');
  const html = `
  <div style="font-family:Arial,Helvetica,sans-serif;background:#eef3f9;padding:24px">
    <div style="max-width:520px;margin:0 auto;background:#ffffff;border-radius:12px;overflow:hidden;border:1px solid #dbe4ef">
      <div style="background:#152336;color:#ffffff;padding:18px 22px;font-size:16px;font-weight:bold">🐜 ANT Capital — Lembrete de pagamento</div>
      <div style="padding:22px;color:#1f2d3d;font-size:14px;line-height:1.6">
        <p style="margin:0 0 10px">Olá, ${esc(nome || '')}!</p>
        <p style="margin:0 0 10px">${esc(msg.titulo.replace(/^\S+\s/, ''))}:</p>
        <ul style="padding-left:18px;margin:0 0 18px">${lista}</ul>
        <a href="${APP_URL}/?aba=pagar" style="display:inline-block;background:#3a6fa8;color:#ffffff;text-decoration:none;padding:10px 18px;border-radius:8px;font-weight:bold">Ver minhas contas</a>
        <p style="margin:18px 0 0;font-size:12px;color:#8fa8c4">Você recebe este e-mail porque ativou os lembretes no app ANT Capital. Para desligar, acesse Contas a pagar → Lembretes.</p>
      </div>
    </div>
  </div>`;
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${RESEND_KEY}` },
    body: JSON.stringify({ from: EMAIL_REMETENTE, to: [para], subject: msg.titulo.replace(/^\S+\s/, ''), html })
  });
  if (!r.ok) { console.error('[lembretes] Falha no e-mail:', r.status, await r.text()); return false; }
  return true;
}

// ── Tarefa diária ───────────────────────────────────────────────────────
async function rodarDiario() {
  const hoje = hojeBrasil();
  const pendentes = await supaRpc('_lembretes_pendentes', { p_hoje: hoje }) || [];

  // agrupa por pessoa
  const porUsuario = {};
  for (const p of pendentes) (porUsuario[p.user_id] ||= []).push(p);

  const resumo = { data: hoje, pessoas: 0, push: 0, email: 0, itens: pendentes.length };
  for (const [userId, itens] of Object.entries(porUsuario)) {
    resumo.pessoas++;
    const registrar = [];

    const paraPush = itens.filter(i => i.quer_push && !i.enviado_push);
    if (paraPush.length && VAPID_PUBLIC && VAPID_PRIVATE) {
      const msg = montarMensagem(paraPush);
      const n = await enviarPush(userId, {
        title: msg.titulo, body: msg.linhas.join('\n'), url: '/?aba=pagar', tag: `lembrete-${hoje}`
      });
      if (n > 0) { resumo.push++; paraPush.forEach(i => registrar.push({ ...i, canal: 'push' })); }
    }

    const paraEmail = itens.filter(i => i.quer_email && !i.enviado_email);
    if (paraEmail.length && RESEND_KEY) {
      const ok = await enviarEmail(itens[0].email, itens[0].nome, montarMensagem(paraEmail));
      if (ok) { resumo.email++; paraEmail.forEach(i => registrar.push({ ...i, canal: 'email' })); }
    }

    if (registrar.length) await supaRpc('_registrar_lembretes', { p_itens: registrar });
  }
  return resumo;
}

// ── Handler ─────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  try {
    // Chave pública (não é segredo) para o app ativar as notificações
    if (req.method === 'GET' && (req.query?.vapid || '').length) {
      if (!VAPID_PUBLIC) return res.status(503).json({ error: 'Notificações ainda não configuradas' });
      return res.status(200).json({ publicKey: VAPID_PUBLIC });
    }

    // Notificação de teste para o próprio usuário
    if (req.method === 'POST' && req.body?.acao === 'teste') {
      const user = await usuarioDoToken(req);
      if (!user?.id) return res.status(401).json({ error: 'Faça login novamente.' });
      if (!VAPID_PUBLIC || !VAPID_PRIVATE) return res.status(503).json({ error: 'Notificações ainda não configuradas no servidor.' });
      const n = await enviarPush(user.id, {
        title: '✅ Notificações ativadas',
        body: 'Pronto! Você vai receber aqui os lembretes das suas contas.',
        url: '/?aba=pagar', tag: 'teste'
      });
      if (n === 0) return res.status(404).json({ error: 'Nenhum aparelho com notificações ativas nesta conta.' });
      return res.status(200).json({ ok: true, aparelhos: n });
    }

    // Tarefa diária (Vercel Cron)
    if (req.method === 'GET') {
      if (!CRON_SECRET || req.headers.authorization !== `Bearer ${CRON_SECRET}`) {
        return res.status(401).json({ error: 'Não autorizado' });
      }
      const resumo = await rodarDiario();
      console.log('[lembretes] Resumo:', JSON.stringify(resumo));
      return res.status(200).json({ ok: true, ...resumo });
    }

    return res.status(405).json({ error: 'Método não permitido' });
  } catch (err) {
    console.error('[lembretes] Erro:', err);
    return res.status(500).json({ error: 'Erro interno' });
  }
}
