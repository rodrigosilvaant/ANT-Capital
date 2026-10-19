// api/_motor.js — Motor de cálculo do Planejador ANT (sem IA)
// Arquivos com "_" na pasta api não viram rota: este é só uma biblioteca.
//
// Faz as contas que um planejador faria: projeção do mês, tendências por
// categoria, orçamento, poupança, dívidas, reserva, metas e contas a pagar.
// A IA recebe estes números prontos (confiáveis) e só explica e orienta.

const SUPA_URL = process.env.SUPABASE_URL;
const SUPA_KEY = process.env.SUPABASE_SERVICE_KEY;

// ── Utilidades ──────────────────────────────────────────────────────────
const num = v => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const r2 = v => Math.round(num(v) * 100) / 100;
const ym = iso => String(iso || '').slice(0, 7);
const diaDe = iso => Number(String(iso).slice(8, 10));
const diasNoMes = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();           // m = 1..12
const somaMes = (iso, n) => { const [y, m] = iso.split('-').map(Number); const d = new Date(Date.UTC(y, m - 1 + n, 1)); return d.toISOString().slice(0, 7); };
const reais = v => num(v).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const pct = v => `${Math.round(num(v) * 100)}%`;
const MESES = ['janeiro','fevereiro','março','abril','maio','junho','julho','agosto','setembro','outubro','novembro','dezembro'];
const nomeMes = ymStr => MESES[Number(ymStr.slice(5, 7)) - 1] + ' de ' + ymStr.slice(0, 4);
const media = arr => arr.length ? arr.reduce((s, x) => s + x, 0) / arr.length : 0;
function mesesEntre(deIso, ateIso) {
  const [y1, m1, d1] = deIso.split('-').map(Number); const [y2, m2, d2] = ateIso.split('-').map(Number);
  return (y2 - y1) * 12 + (m2 - m1) + (d2 - d1) / 30;
}
function hojeBrasil() { return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date()); }

// ── Carregar dados (uma consulta) ───────────────────────────────────────
async function carregarDados(userId) {
  const r = await fetch(`${SUPA_URL}/rest/v1/rpc/_dados_planejador`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: SUPA_KEY, Authorization: `Bearer ${SUPA_KEY}` },
    body: JSON.stringify({ p_user_id: userId })
  });
  if (!r.ok) throw new Error('[motor] Falha ao carregar dados: ' + (await r.text()));
  return r.json();
}

// ── Normalização ────────────────────────────────────────────────────────
function normalizar(d) {
  const trans = (d.transacoes || []).filter(t => t && t.data).map(t => ({
    tipo: t.tipo, valor: num(t.valor), categoria: t.categoria || 'Outros', data: String(t.data).slice(0, 10), conta_id: t.conta_id
  }));
  return {
    nome: d.nome || '',
    trans,
    contas: d.contas || [],
    transferencias: (d.transferencias || []).map(t => ({ ...t, valor: num(t.valor) })),
    dividas: (d.dividas || []).filter(x => !x.quitada && x.status !== 'quitada'),
    metas: (Array.isArray(d.metas) ? d.metas : []).filter(m => m && !m.concluida),
    limites: (Array.isArray(d.limites) ? d.limites : []).filter(l => l && num(l.valor) > 0),
    categorias: d.categorias || [],
    contas_pagar: d.contas_pagar || [],
    patrimonio: d.patrimonio || [],
  };
}

// ── Cálculo principal ───────────────────────────────────────────────────
function calcularPainel(dadosBrutos, hoje = hojeBrasil()) {
  const D = normalizar(dadosBrutos);
  const mesAtual = ym(hoje);
  const [ano, mes] = mesAtual.split('-').map(Number);
  const N = diasNoMes(ano, mes);
  const dia = diaDe(hoje);

  // Histórico: até 3 meses completos anteriores que tenham lançamentos
  const histMeses = [1, 2, 3].map(i => somaMes(mesAtual + '-01', -i)).filter(m => D.trans.some(t => ym(t.data) === m));
  const doMes = m => D.trans.filter(t => ym(t.data) === m);
  const soma = (arr, tipo, filtro = () => true) => arr.filter(t => t.tipo === tipo && filtro(t)).reduce((s, t) => s + t.valor, 0);

  // --- Histórico mês a mês
  const historico = histMeses.map(m => {
    const tm = doMes(m); const rec = soma(tm, 'receita'); const desp = soma(tm, 'despesa');
    return { mes: m, receitas: r2(rec), despesas: r2(desp), saldo: r2(rec - desp), taxa_poupanca: rec > 0 ? (rec - desp) / rec : null };
  });
  const recMedia = media(historico.map(h => h.receitas));
  const despMedia = media(historico.map(h => h.despesas));
  const poupMedia = media(historico.map(h => h.saldo));
  const taxasValidas = historico.filter(h => h.taxa_poupanca !== null).map(h => h.taxa_poupanca);
  const taxaMedia = taxasValidas.length ? media(taxasValidas) : null;

  // --- Mês atual até hoje
  const tmAtual = doMes(mesAtual);
  const ateHoje = t => t.data <= hoje;
  const depoisHoje = t => t.data > hoje;
  const recAte = soma(tmAtual, 'receita', ateHoje);
  const despAte = soma(tmAtual, 'despesa', ateHoje);
  const recFuturas = soma(tmAtual, 'receita', depoisHoje);
  const despFuturas = soma(tmAtual, 'despesa', depoisHoje);

  // "Mesmo período" nos meses anteriores (do dia 1 até hoje / depois de hoje)
  const parteHist = (m, tipo, depois, cat) => {
    const [y, mm] = m.split('-').map(Number); const lim = Math.min(dia, diasNoMes(y, mm));
    return doMes(m).filter(t => t.tipo === tipo && (cat ? t.categoria === cat : true) && (depois ? diaDe(t.data) > lim : diaDe(t.data) <= lim))
      .reduce((s, t) => s + t.valor, 0);
  };
  const histDespRestante = media(histMeses.map(m => parteHist(m, 'despesa', true)));

  // Contas a pagar ainda não pagas até o fim do mês (inclui atrasadas)
  const fimMes = `${mesAtual}-${String(N).padStart(2, '0')}`;
  const cpPendMes = D.contas_pagar.filter(c => String(c.vencimento) <= fimMes);
  const cpPendMesTotal = cpPendMes.reduce((s, c) => s + num(c.valor), 0);

  let confianca, recProj, despProj;
  if (histMeses.length === 0) {
    confianca = 'baixa';
    const ritmo = dia > 0 ? despAte / dia : 0;
    despProj = despAte + despFuturas + Math.max(ritmo * (N - dia) * 0.5, cpPendMesTotal);
    recProj = recAte + recFuturas;
  } else {
    confianca = histMeses.length >= 3 ? 'alta' : 'media';
    despProj = despAte + Math.max(histDespRestante, despFuturas + cpPendMesTotal);
    recProj = Math.max(recAte + recFuturas, recMedia);
  }
  const saldoProj = recProj - despProj;

  // --- Categorias: tendência (mesmo período) e projeção
  const catsDesp = [...new Set([...tmAtual, ...histMeses.flatMap(doMes)].filter(t => t.tipo === 'despesa').map(t => t.categoria))];
  const categorias = catsDesp.map(cat => {
    const atual = soma(tmAtual, 'despesa', t => ateHoje(t) && t.categoria === cat);
    const histAte = histMeses.length ? media(histMeses.map(m => parteHist(m, 'despesa', false, cat))) : null;
    const histMes = histMeses.length ? media(histMeses.map(m => soma(doMes(m), 'despesa', t => t.categoria === cat))) : null;
    const histRest = histMeses.length ? media(histMeses.map(m => parteHist(m, 'despesa', true, cat))) : null;
    const projecao = histMeses.length ? atual + histRest : (dia > 0 ? atual / dia * N : atual);
    const desvio = histAte !== null ? atual - histAte : null;
    const variacao = histAte ? desvio / histAte : null;
    const classif = (D.categorias.find(c => c.nome === cat) || {}).essencial_superfluo || null;
    return { categoria: cat, gasto_ate_hoje: r2(atual), media_mesmo_periodo: histAte === null ? null : r2(histAte),
      media_mensal: histMes === null ? null : r2(histMes), projecao_mes: r2(projecao), desvio: desvio === null ? null : r2(desvio),
      variacao, classificacao: classif };
  }).sort((a, b) => b.gasto_ate_hoje - a.gasto_ate_hoje);

  const acimaDoNormal = categorias.filter(c => c.desvio !== null && c.desvio >= 100 && (c.variacao === null || c.variacao >= 0.25 || c.media_mesmo_periodo === 0))
    .sort((a, b) => b.desvio - a.desvio);

  // --- Orçamento
  const orcamento = D.limites.map(l => {
    const c = categorias.find(x => x.categoria === l.categoria) || { gasto_ate_hoje: 0, projecao_mes: 0 };
    const limite = num(l.valor);
    const status = c.gasto_ate_hoje > limite ? 'estourado' : c.projecao_mes > limite * 1.02 ? 'vai_estourar' : 'ok';
    return { categoria: l.categoria, limite: r2(limite), gasto: c.gasto_ate_hoje, projecao: c.projecao_mes, uso: limite ? c.gasto_ate_hoje / limite : 0, status };
  });

  // --- Saldos e reserva
  const saldoConta = c => {
    const id = c.id; const tr = D.trans.filter(t => t.conta_id === id);
    return num(c.saldo_inicial) + soma(tr, 'receita') - soma(tr, 'despesa')
      + D.transferencias.filter(t => t.to_id === id).reduce((s, t) => s + t.valor, 0)
      - D.transferencias.filter(t => t.from_id === id).reduce((s, t) => s + t.valor, 0);
  };
  const saldoContas = D.contas.reduce((s, c) => s + saldoConta(c), 0);
  const investimentos = D.patrimonio.filter(p => /invest|reserva|aplica|poupan|tesouro|cdb|renda/i.test(`${p.tipo} ${p.nome}`))
    .reduce((s, p) => s + num(p.valor_atual), 0);
  const baseDespesa = despMedia || despProj;
  const mesesReserva = baseDespesa > 0 ? (Math.max(saldoContas, 0) + investimentos) / baseDespesa : null;

  // --- Dívidas
  const dividas = D.dividas.map(d => {
    const parcelas = Math.max(num(d.parcelas) || 1, 1); const pagas = Math.min(num(d.pagas), parcelas);
    const parcela = num(d.valor_total) / parcelas; const restantes = parcelas - pagas;
    const i = num(d.juros) / 100;
    const saldo = i > 0 ? parcela * (1 - Math.pow(1 + i, -restantes)) / i : parcela * restantes;   // valor presente
    const out = { id: d.id, credor: d.credor || 'Dívida', parcela: r2(parcela), parcelas_restantes: restantes,
      juros_am: num(d.juros), saldo_devedor: r2(saldo), total_a_pagar: r2(parcela * restantes) };
    Object.defineProperty(out, '_exato', { value: { parcela, saldo }, enumerable: false });   // usado nas simulações
    return out;
  }).filter(d => d.parcelas_restantes > 0);
  const totalParcelas = dividas.reduce((s, d) => s + d.parcela, 0);
  const rendaRef = recMedia || recProj;
  const comprometimento = rendaRef > 0 ? totalParcelas / rendaRef : null;
  const ordemAvalanche = [...dividas].sort((a, b) => b.juros_am - a.juros_am || a.saldo_devedor - b.saldo_devedor).map(d => d.credor);

  // --- Metas
  const capacidade = Math.max(poupMedia, 0);
  const metas = D.metas.map(m => {
    const alvo = num(m.valor_alvo), atual = num(m.valor_atual), falta = Math.max(alvo - atual, 0);
    let mesesPrazo = null, aporteNecessario = null;
    if (m.prazo) { mesesPrazo = Math.max(mesesEntre(hoje, String(m.prazo).slice(0, 10)), 0.5); aporteNecessario = falta / mesesPrazo; }
    const mesesNoRitmo = capacidade > 0 ? falta / capacidade : null;
    return { nome: m.nome, alvo: r2(alvo), atual: r2(atual), falta: r2(falta), progresso: alvo ? atual / alvo : 0, prazo: m.prazo || null,
      aporte_necessario: aporteNecessario === null ? null : r2(aporteNecessario),
      no_ritmo: aporteNecessario === null ? null : capacidade >= aporteNecessario,
      meses_no_ritmo_atual: mesesNoRitmo === null ? null : Math.ceil(mesesNoRitmo) };
  });

  // --- Contas a pagar
  const atrasadas = D.contas_pagar.filter(c => String(c.vencimento) < hoje);
  const prox30 = D.contas_pagar.filter(c => String(c.vencimento) >= hoje && mesesEntre(hoje, String(c.vencimento)) <= 1);

  // --- Mês anterior (check-up)
  const mAnt = somaMes(mesAtual + '-01', -1);
  const tAnt = doMes(mAnt);
  let checkup = null;
  if (tAnt.length) {
    const rec = soma(tAnt, 'receita'), desp = soma(tAnt, 'despesa');
    const porCat = {}; tAnt.filter(t => t.tipo === 'despesa').forEach(t => { porCat[t.categoria] = (porCat[t.categoria] || 0) + t.valor; });
    const ant3 = [2, 3, 4].map(i => somaMes(mesAtual + '-01', -i)).filter(m => D.trans.some(t => ym(t.data) === m));
    const variacoes = Object.entries(porCat).map(([cat, v]) => {
      const mediaCat = ant3.length ? media(ant3.map(m => soma(doMes(m), 'despesa', t => t.categoria === cat))) : null;
      return { categoria: cat, valor: r2(v), media_anterior: mediaCat === null ? null : r2(mediaCat), diferenca: mediaCat === null ? null : r2(v - mediaCat) };
    }).sort((a, b) => b.valor - a.valor);
    checkup = { mes: mAnt, nome_mes: nomeMes(mAnt), receitas: r2(rec), despesas: r2(desp), saldo: r2(rec - desp),
      taxa_poupanca: rec > 0 ? (rec - desp) / rec : null, maiores_gastos: variacoes.slice(0, 3),
      maior_aumento: variacoes.filter(v => v.diferenca !== null && v.diferenca > 0).sort((a, b) => b.diferenca - a.diferenca)[0] || null };
  }

  const painel = {
    gerado_em: hoje, mes: mesAtual, nome_mes: nomeMes(mesAtual), dia, dias_no_mes: N, nome: D.nome,
    tem_dados: D.trans.length > 0, meses_historico: histMeses.length,
    mes_atual: { receitas_ate_hoje: r2(recAte), despesas_ate_hoje: r2(despAte), receitas_projetadas: r2(recProj),
      despesas_projetadas: r2(despProj), saldo_projetado: r2(saldoProj), contas_pendentes_mes: r2(cpPendMesTotal), confianca },
    historico, medias: { receitas: r2(recMedia), despesas: r2(despMedia), poupanca: r2(poupMedia), taxa_poupanca: taxaMedia },
    categorias, acima_do_normal: acimaDoNormal.slice(0, 5), orcamento,
    reserva: { saldo_contas: r2(saldoContas), investimentos: r2(investimentos), meses: mesesReserva === null ? null : Math.round(mesesReserva * 10) / 10 },
    dividas, dividas_resumo: { total_parcelas: r2(totalParcelas), comprometimento_renda: comprometimento, ordem_sugerida: ordemAvalanche,
      saldo_devedor_total: r2(dividas.reduce((s, d) => s + d.saldo_devedor, 0)) },
    metas, capacidade_poupanca_mensal: r2(capacidade),
    contas_pagar: { atrasadas: atrasadas.map(c => ({ descricao: c.descricao, valor: r2(c.valor), vencimento: c.vencimento })),
      proximos_30_dias: r2(prox30.reduce((s, c) => s + num(c.valor), 0)), quantidade_30_dias: prox30.length },
    checkup_mes_anterior: checkup,
  };
  painel.alertas = gerarAlertas(painel);
  return painel;
}

// ── Alertas de correção de rota (regras fixas, sem IA) ──────────────────
function gerarAlertas(p) {
  const a = [];
  const m = p.mes_atual;
  if (!p.tem_dados) return a;

  if (p.contas_pagar.atrasadas.length) {
    const tot = p.contas_pagar.atrasadas.reduce((s, c) => s + c.valor, 0);
    a.push({ tipo: 'contas_atrasadas', severidade: 'alta',
      titulo: `${p.contas_pagar.atrasadas.length === 1 ? '1 conta atrasada' : p.contas_pagar.atrasadas.length + ' contas atrasadas'}`,
      texto: `${p.contas_pagar.atrasadas.map(c => c.descricao).join(', ')} — ${reais(tot)} em atraso. Atrasos geram multa e juros.`,
      acoes: ['Pague as contas atrasadas primeiro, antes de gastos que podem esperar.'] });
  }

  if (m.saldo_projetado < 0 && p.dia >= 5) {
    const desvios = p.acima_do_normal.slice(0, 2);
    const acoes = desvios.map(c => `Reduza ${c.categoria}: está ${reais(c.desvio)} acima do seu normal para esta altura do mês.`);
    if (!acoes.length) acoes.push('Adie compras que não são essenciais até o próximo mês.');
    const cobertura = desvios.reduce((s, c) => s + c.desvio, 0);
    a.push({ tipo: 'projecao', severidade: 'alta',
      titulo: `No ritmo atual, ${p.nome_mes.split(' ')[0]} fecha com ${reais(m.saldo_projetado)}`,
      texto: `Projeção: receitas de ${reais(m.receitas_projetadas)} e despesas de ${reais(m.despesas_projetadas)}.`
        + (desvios.length ? ` O maior desvio é ${desvios[0].categoria} (+${reais(desvios[0].desvio)}).` : '')
        + (cobertura >= Math.abs(m.saldo_projetado) ? ' Ajustando esses gastos, você volta ao azul.' : ''),
      acoes, dados: { saldo_projetado: m.saldo_projetado, desvios: desvios.map(d => ({ categoria: d.categoria, desvio: d.desvio })) } });
  } else if (p.acima_do_normal.length && p.dia >= 7) {
    const c = p.acima_do_normal[0];
    a.push({ tipo: 'tendencia', severidade: 'media',
      titulo: `${c.categoria} está acima do normal`,
      texto: `Até hoje você gastou ${reais(c.gasto_ate_hoje)} em ${c.categoria}; no mesmo período dos últimos meses a média foi ${reais(c.media_mesmo_periodo)}.`,
      acoes: [`Defina um teto para ${c.categoria} até o fim do mês (ex.: ${reais(Math.max(c.media_mensal - c.gasto_ate_hoje, 0))} restantes).`],
      dados: { categoria: c.categoria, desvio: c.desvio } });
  }

  p.orcamento.filter(o => o.status !== 'ok').slice(0, 2).forEach(o => {
    a.push({ tipo: 'orcamento', severidade: o.status === 'estourado' ? 'alta' : 'media', chave_extra: o.categoria,
      titulo: o.status === 'estourado' ? `Orçamento de ${o.categoria} estourado` : `${o.categoria} vai passar do orçamento`,
      texto: o.status === 'estourado'
        ? `Gasto de ${reais(o.gasto)} para um limite de ${reais(o.limite)} (${pct(o.uso)}).`
        : `Você já usou ${pct(o.uso)} do limite de ${reais(o.limite)} e a projeção é chegar a ${reais(o.projecao)}.`,
      acoes: [o.status === 'estourado' ? `Evite novos gastos em ${o.categoria} este mês.` : `Segure ${o.categoria}: restam ${reais(Math.max(o.limite - o.gasto, 0))} até o fim do mês.`] });
  });

  const comp = p.dividas_resumo.comprometimento_renda;
  if (comp !== null && comp > 0.3) {
    const prior = p.dividas.slice().sort((x, y) => y.juros_am - x.juros_am)[0];
    a.push({ tipo: 'dividas', severidade: comp > 0.5 ? 'alta' : 'media',
      titulo: `Dívidas comprometem ${pct(comp)} da renda`,
      texto: `As parcelas somam ${reais(p.dividas_resumo.total_parcelas)} por mês. O recomendado é ficar abaixo de 30%.`,
      acoes: [prior && prior.juros_am > 0 ? `Priorize quitar ${prior.credor} (${prior.juros_am}% ao mês, o juro mais caro).` : 'Evite novas parcelas até reduzir esse percentual.'] });
  }

  if (p.reserva.meses !== null && p.reserva.meses < 3 && p.medias.despesas > 0) {
    const alvo = p.medias.despesas * 6;
    a.push({ tipo: 'reserva', severidade: 'media',
      titulo: `Reserva de emergência: ${String(p.reserva.meses).replace('.', ',')} ${p.reserva.meses === 1 ? 'mês' : 'meses'}`,
      texto: `O ideal são 6 meses do seu custo de vida (${reais(alvo)}). Hoje você tem ${reais(p.reserva.saldo_contas + p.reserva.investimentos)}.`,
      acoes: [`Separe um valor fixo todo mês assim que a renda entrar (ex.: ${reais(Math.max(p.medias.despesas * 0.1, 50))}).`] });
  }

  if (p.medias.taxa_poupanca !== null && p.medias.taxa_poupanca < 0.1 && p.meses_historico >= 2) {
    a.push({ tipo: 'poupanca', severidade: 'media', titulo: `Você está poupando ${pct(Math.max(p.medias.taxa_poupanca, 0))} da renda`,
      texto: 'A referência saudável é guardar pelo menos 10% a 20% do que entra.',
      acoes: ['Comece com 5% automático no dia do pagamento e aumente aos poucos.'] });
  }

  p.metas.filter(mt => mt.no_ritmo === false).slice(0, 1).forEach(mt => {
    a.push({ tipo: 'meta', severidade: 'media', chave_extra: mt.nome, titulo: `Meta "${mt.nome}" fora do ritmo`,
      texto: `Faltam ${reais(mt.falta)}; para chegar no prazo seria preciso guardar ${reais(mt.aporte_necessario)} por mês (sua média é ${reais(p.capacidade_poupanca_mensal)}).`,
      acoes: ['Ajuste o prazo, o valor da meta ou reduza um gasto para liberar esse aporte.'] });
  });

  if (!a.some(x => x.severidade === 'alta') && m.saldo_projetado > 0 && p.medias.taxa_poupanca !== null && p.medias.taxa_poupanca >= 0.2) {
    a.push({ tipo: 'positivo', severidade: 'info', titulo: 'Você está no caminho certo 👏',
      texto: `Poupança média de ${pct(p.medias.taxa_poupanca)} e mês projetado no azul (${reais(m.saldo_projetado)}).`,
      acoes: ['Direcione o excedente para a reserva ou para a meta mais importante.'] });
  }
  const ordem = { alta: 0, media: 1, info: 2 };
  return a.sort((x, y) => ordem[x.severidade] - ordem[y.severidade]);
}

// ── Correção de rota proativa (cron diário) ─────────────────────────────
// Candidatos a notificação, em ordem de prioridade. Cada chave sai uma única
// vez (tabela insights): projeção negativa → no máximo 1 por semana; orçamento
// → 1 por categoria no mês; check-up → 1 por mês, nos 3 primeiros dias.
function insightsDoDia(p) {
  const out = [];
  if (!p.tem_dados) return out;
  const c = p.checkup_mes_anterior;
  if (p.dia <= 3 && c) {
    const mes = c.nome_mes.split(' ')[0];
    out.push({ chave: `checkup:${c.mes}`, tipo: 'checkup', titulo: `📊 Seu fechamento de ${mes}`,
      texto: `Receitas ${reais(c.receitas)}, despesas ${reais(c.despesas)}: ${c.saldo >= 0 ? 'sobraram ' + reais(c.saldo) : 'faltaram ' + reais(-c.saldo)}. Veja o check-up no app.`,
      dados: { mes: c.mes, saldo: c.saldo } });
  }
  const semana = Math.ceil(p.dia / 7);
  for (const a of p.alertas) {
    if (a.tipo === 'projecao') out.push({ chave: `projecao:${p.mes}:s${semana}`, tipo: 'projecao', titulo: '🧭 ' + a.titulo, texto: a.texto + (a.acoes[0] ? ' ' + a.acoes[0] : ''), dados: a.dados || null });
    else if (a.tipo === 'orcamento') out.push({ chave: `orcamento:${p.mes}:${a.chave_extra}${a.severidade === 'alta' ? ':estourado' : ''}`, tipo: 'orcamento', titulo: '🎯 ' + a.titulo, texto: a.texto + ' ' + a.acoes[0], dados: { categoria: a.chave_extra } });
    else if (a.tipo === 'tendencia') out.push({ chave: `tendencia:${p.mes}:${a.dados.categoria}`, tipo: 'tendencia', titulo: '📈 ' + a.titulo, texto: a.texto, dados: a.dados });
  }
  return out;
}

// ── Texto para a IA ─────────────────────────────────────────────────────
function textoParaIA(p) {
  if (!p.tem_dados) return '\n\nPAINEL DO PLANEJADOR: o cliente ainda não registrou lançamentos. Oriente-o a registrar receitas e despesas no app.';
  const L = [];
  const m = p.mes_atual;
  L.push(`PAINEL DO PLANEJADOR (calculado pelo sistema em ${p.gerado_em} — números exatos, use-os):`);
  L.push(`Mês atual (${p.nome_mes}, dia ${p.dia} de ${p.dias_no_mes}): receitas até hoje ${reais(m.receitas_ate_hoje)}, despesas até hoje ${reais(m.despesas_ate_hoje)}.`);
  L.push(`Projeção de fechamento: receitas ${reais(m.receitas_projetadas)}, despesas ${reais(m.despesas_projetadas)}, saldo ${reais(m.saldo_projetado)} (confiança ${m.confianca}; base: ${p.meses_historico} meses de histórico + contas a pagar).`);
  if (p.historico.length) L.push('Histórico: ' + p.historico.map(h => `${h.mes}: receitas ${reais(h.receitas)}, despesas ${reais(h.despesas)}, saldo ${reais(h.saldo)}${h.taxa_poupanca !== null ? ' (' + pct(h.taxa_poupanca) + ' poupado)' : ''}`).join(' | '));
  L.push(`Médias mensais: receitas ${reais(p.medias.receitas)}, despesas ${reais(p.medias.despesas)}, poupança ${reais(p.medias.poupanca)}${p.medias.taxa_poupanca !== null ? ' (' + pct(p.medias.taxa_poupanca) + ')' : ''}.`);
  if (p.categorias.length) L.push('Gastos por categoria no mês (até hoje → projeção; média mensal): ' + p.categorias.slice(0, 8).map(c => `${c.categoria} ${reais(c.gasto_ate_hoje)} → ${reais(c.projecao_mes)}${c.media_mensal !== null ? '; média ' + reais(c.media_mensal) : ''}${c.classificacao ? ' [' + c.classificacao + ']' : ''}`).join(' | '));
  if (p.acima_do_normal.length) L.push('Acima do normal (comparado ao mesmo período dos meses anteriores): ' + p.acima_do_normal.map(c => `${c.categoria} +${reais(c.desvio)}${c.variacao !== null ? ' (+' + pct(c.variacao) + ')' : ''}`).join(' | '));
  if (p.orcamento.length) L.push('Orçamento: ' + p.orcamento.map(o => `${o.categoria}: ${reais(o.gasto)} de ${reais(o.limite)} (${o.status.replace('_', ' ')})`).join(' | '));
  L.push(`Reserva: ${reais(p.reserva.saldo_contas)} em contas + ${reais(p.reserva.investimentos)} investidos = ${p.reserva.meses === null ? 'sem base de cálculo' : String(p.reserva.meses).replace('.', ',') + ' meses de custo de vida'}.`);
  if (p.dividas.length) {
    L.push('Dívidas: ' + p.dividas.map(d => `${d.credor}: parcela ${reais(d.parcela)}, ${d.parcelas_restantes} restantes, juros ${d.juros_am}% a.m., saldo devedor ${reais(d.saldo_devedor)}`).join(' | '));
    L.push(`Parcelas somam ${reais(p.dividas_resumo.total_parcelas)}/mês${p.dividas_resumo.comprometimento_renda !== null ? ' (' + pct(p.dividas_resumo.comprometimento_renda) + ' da renda)' : ''}. Ordem sugerida de quitação (maior juro primeiro): ${p.dividas_resumo.ordem_sugerida.join(' → ')}.`);
  } else L.push('Dívidas: nenhuma registrada.');
  if (p.metas.length) L.push('Metas: ' + p.metas.map(mt => `${mt.nome}: ${reais(mt.atual)} de ${reais(mt.alvo)}${mt.prazo ? ', prazo ' + mt.prazo + ', precisa ' + reais(mt.aporte_necessario) + '/mês (' + (mt.no_ritmo ? 'no ritmo' : 'fora do ritmo') + ')' : ''}${mt.meses_no_ritmo_atual !== null ? ', no ritmo atual leva ~' + mt.meses_no_ritmo_atual + ' meses' : ''}`).join(' | '));
  else L.push('Metas: nenhuma registrada.');
  if (p.contas_pagar.atrasadas.length || p.contas_pagar.quantidade_30_dias) L.push(`Contas a pagar: ${p.contas_pagar.atrasadas.length} atrasada(s); ${p.contas_pagar.quantidade_30_dias} nos próximos 30 dias (${reais(p.contas_pagar.proximos_30_dias)}).`);
  if (p.checkup_mes_anterior) { const c = p.checkup_mes_anterior; L.push(`Fechamento de ${c.nome_mes}: receitas ${reais(c.receitas)}, despesas ${reais(c.despesas)}, saldo ${reais(c.saldo)}.`); }
  if (p.alertas.length) L.push('Alertas do sistema: ' + p.alertas.map(x => `[${x.severidade}] ${x.titulo} — ${x.texto}`).join(' | '));
  return '\n\n' + L.join('\n');
}

// ── Ferramentas de simulação (a IA chama; o motor calcula) ──────────────
const FERRAMENTAS = [
  { name: 'simular_quitacao_divida',
    description: 'Simula pagar uma dívida do cliente com um valor extra por mês (ou quitar à vista). Retorna em quantos meses quita, quanto paga no total e quanto economiza de juros. Use para perguntas sobre antecipar, quitar ou qual dívida priorizar.',
    input_schema: { type: 'object', properties: {
      credor: { type: 'string', description: 'Nome do credor (como aparece no painel). Se omitido, usa a dívida de maior juro.' },
      valor_extra_mensal: { type: 'number', description: 'Quanto a mais por mês, em reais, além da parcela. Use 0 para ver o cenário atual.' } }, required: ['valor_extra_mensal'] } },
  { name: 'simular_meta',
    description: 'Calcula quanto guardar por mês para chegar a um valor até um prazo, ou em quanto tempo chega guardando um valor por mês. Pode considerar rendimento anual.',
    input_schema: { type: 'object', properties: {
      valor_alvo: { type: 'number' }, valor_atual: { type: 'number', description: 'Quanto já tem guardado (padrão 0).' },
      prazo_meses: { type: 'number', description: 'Em quantos meses quer chegar (informe este OU aporte_mensal).' },
      aporte_mensal: { type: 'number', description: 'Quanto pode guardar por mês (informe este OU prazo_meses).' },
      rendimento_anual_pct: { type: 'number', description: 'Rendimento anual esperado em %, ex. 10. Padrão 0.' } }, required: ['valor_alvo'] } },
  { name: 'simular_corte_gasto',
    description: 'Simula reduzir um gasto mensal e mostra o impacto: quanto sobra a mais por mês e por ano, efeito na reserva de emergência, nas metas e na dívida mais cara.',
    input_schema: { type: 'object', properties: {
      categoria: { type: 'string', description: 'Categoria do gasto (opcional, só para o texto).' },
      valor_mensal: { type: 'number', description: 'Quanto reduzir por mês, em reais.' } }, required: ['valor_mensal'] } },
  { name: 'projetar_saldo',
    description: 'Projeta o saldo acumulado (o que sobra) mês a mês nos próximos meses, pela média atual de poupança do cliente, opcionalmente com um ajuste mensal (positivo = economiza mais, negativo = gasta mais).',
    input_schema: { type: 'object', properties: {
      meses: { type: 'number', description: 'Quantos meses à frente (1 a 24).' },
      ajuste_mensal: { type: 'number', description: 'Mudança mensal em reais (padrão 0).' } }, required: ['meses'] } },
  { name: 'simular_investimento',
    description: 'Calcula quanto um investimento rende com aportes mensais e juros compostos.',
    input_schema: { type: 'object', properties: {
      aporte_mensal: { type: 'number' }, meses: { type: 'number' }, taxa_anual_pct: { type: 'number', description: 'Taxa anual em %, ex. 10.' },
      valor_inicial: { type: 'number' } }, required: ['aporte_mensal', 'meses', 'taxa_anual_pct'] } },
  { name: 'historico_categoria',
    description: 'Mostra quanto o cliente gastou em uma categoria em cada um dos últimos meses (para analisar tendência).',
    input_schema: { type: 'object', properties: { categoria: { type: 'string' } }, required: ['categoria'] } },
];

function mesesParaQuitar(saldo, pagamento, i) {
  if (pagamento <= 0) return Infinity;
  // (- 1e-9 evita que 8,0000001 vire 9 por imprecisão de ponto flutuante)
  if (i <= 0) return Math.ceil(saldo / pagamento - 1e-9);
  if (pagamento <= saldo * i) return Infinity;      // nunca quita: parcela não cobre os juros
  return Math.ceil(-Math.log(1 - (i * saldo) / pagamento) / Math.log(1 + i) - 1e-9);
}

function executarFerramenta(nome, inp, painel, dadosBrutos) {
  inp = inp || {};
  const p = painel;
  switch (nome) {
    case 'simular_quitacao_divida': {
      if (!p.dividas.length) return { erro: 'O cliente não tem dívidas registradas.' };
      const alvo = inp.credor ? p.dividas.find(d => d.credor.toLowerCase().includes(String(inp.credor).toLowerCase())) : null;
      const d = alvo || p.dividas.slice().sort((a, b) => b.juros_am - a.juros_am)[0];
      const i = d.juros_am / 100; const extra = Math.max(num(inp.valor_extra_mensal), 0);
      const ex = d._exato || { parcela: d.parcela, saldo: d.saldo_devedor };
      const nBase = d.parcelas_restantes, totalBase = ex.parcela * nBase;
      const pag = ex.parcela + extra; const nNovo = mesesParaQuitar(ex.saldo, pag, i);
      if (!Number.isFinite(nNovo)) return { credor: d.credor, erro: 'Com esse valor a dívida não diminui (não cobre os juros).' };
      let saldo = ex.saldo, totalNovo = 0;
      for (let k = 0; k < nNovo; k++) { saldo = saldo * (1 + i); const pg = Math.min(pag, saldo); totalNovo += pg; saldo -= pg; if (saldo < 0.005) break; }
      return { credor: d.credor, juros_am: d.juros_am, saldo_devedor_hoje: r2(d.saldo_devedor), parcela_atual: d.parcela,
        cenario_atual: { meses: nBase, total_pago: r2(totalBase) },
        com_extra: { pagamento_mensal: r2(pag), meses: nNovo, total_pago: r2(totalNovo) },
        meses_antecipados: Math.max(nBase - nNovo, 0), economia_juros: r2(Math.max(totalBase - totalNovo, 0)),
        quitar_a_vista_hoje: r2(d.saldo_devedor) };
    }
    case 'simular_meta': {
      const alvo = num(inp.valor_alvo), atual = num(inp.valor_atual), im = Math.pow(1 + num(inp.rendimento_anual_pct) / 100, 1 / 12) - 1;
      if (alvo <= atual) return { mensagem: 'O valor atual já alcança a meta.' };
      if (inp.prazo_meses) {
        const n = Math.max(Math.round(num(inp.prazo_meses)), 1);
        const fvAtual = atual * Math.pow(1 + im, n);
        const aporte = im > 0 ? (alvo - fvAtual) * im / (Math.pow(1 + im, n) - 1) : (alvo - atual) / n;
        return { valor_alvo: alvo, prazo_meses: n, aporte_mensal_necessario: r2(Math.max(aporte, 0)),
          comparacao_media_poupanca: p.capacidade_poupanca_mensal, cabe_na_poupanca_atual: p.capacidade_poupanca_mensal >= aporte };
      }
      const ap = num(inp.aporte_mensal) || p.capacidade_poupanca_mensal;
      if (ap <= 0) return { erro: 'Sem aporte mensal informado e o cliente não tem sobra média positiva.' };
      let s = atual, n = 0; while (s < alvo && n < 600) { s = s * (1 + im) + ap; n++; }
      return { valor_alvo: alvo, aporte_mensal: r2(ap), meses_necessarios: n, anos: Math.round(n / 12 * 10) / 10 };
    }
    case 'simular_corte_gasto': {
      const v = Math.max(num(inp.valor_mensal), 0);
      const poupNova = p.medias.poupanca + v;
      const res = { categoria: inp.categoria || null, corte_mensal: r2(v), economia_anual: r2(v * 12),
        poupanca_mensal_atual: p.medias.poupanca, poupanca_mensal_nova: r2(poupNova),
        taxa_poupanca_nova: p.medias.receitas > 0 ? Math.round(poupNova / p.medias.receitas * 1000) / 10 + '%' : null };
      if (p.medias.despesas > 0) res.meses_para_reserva_6_meses = poupNova > 0 ? Math.ceil(Math.max(p.medias.despesas * 6 - (p.reserva.saldo_contas + p.reserva.investimentos), 0) / poupNova) : null;
      const meta = p.metas[0];
      if (meta && meta.falta > 0) res.meta_principal = { nome: meta.nome, meses_antes: meta.meses_no_ritmo_atual, meses_depois: poupNova > 0 ? Math.ceil(meta.falta / poupNova) : null };
      if (p.dividas.length) res.divida_mais_cara = executarFerramenta('simular_quitacao_divida', { valor_extra_mensal: v }, p, dadosBrutos);
      return res;
    }
    case 'projetar_saldo': {
      const n = Math.min(Math.max(Math.round(num(inp.meses)), 1), 24); const ajuste = num(inp.ajuste_mensal);
      const mensal = p.medias.poupanca + ajuste; let acum = 0; const meses = [];
      for (let k = 1; k <= n; k++) { acum += mensal; meses.push({ mes: somaMes(p.mes + '-01', k), acumulado: r2(acum) }); }
      return { sobra_mensal_usada: r2(mensal), base: `média dos últimos ${p.meses_historico} meses${ajuste ? ' + ajuste de ' + reais(ajuste) : ''}`, meses };
    }
    case 'simular_investimento': {
      const n = Math.max(Math.round(num(inp.meses)), 1), im = Math.pow(1 + num(inp.taxa_anual_pct) / 100, 1 / 12) - 1;
      let s = num(inp.valor_inicial); for (let k = 0; k < n; k++) s = s * (1 + im) + num(inp.aporte_mensal);
      const investido = num(inp.valor_inicial) + num(inp.aporte_mensal) * n;
      return { meses: n, total_investido: r2(investido), valor_final: r2(s), rendimento: r2(s - investido), taxa_mensal_equivalente: Math.round(im * 10000) / 100 + '%' };
    }
    case 'historico_categoria': {
      const D = normalizar(dadosBrutos); const cat = String(inp.categoria || '').toLowerCase();
      const meses = [0, 1, 2, 3, 4, 5].map(i => somaMes(p.mes + '-01', -i));
      const linhas = meses.map(m => ({ mes: m, valor: r2(D.trans.filter(t => t.tipo === 'despesa' && ym(t.data) === m && t.categoria.toLowerCase().includes(cat)).reduce((s, t) => s + t.valor, 0)) }));
      return { categoria: inp.categoria, meses: linhas, observacao: 'O mês atual está parcial (até hoje).' };
    }
    default: return { erro: 'Ferramenta desconhecida' };
  }
}

module.exports = { carregarDados, calcularPainel, gerarAlertas, insightsDoDia, textoParaIA, FERRAMENTAS, executarFerramenta, hojeBrasil, reais };
