-- ============================================================
-- ANT Capital — Setup do banco de dados no Supabase
-- Execute este script no SQL Editor do Supabase
-- ============================================================

-- 1. TABELAS

CREATE TABLE public.profiles (
  id UUID REFERENCES auth.users(id) ON DELETE CASCADE PRIMARY KEY,
  nome TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE public.contas (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  banco TEXT NOT NULL,
  apelido TEXT DEFAULT '',
  tipo TEXT DEFAULT '',
  saldo_inicial DECIMAL(12,2) DEFAULT 0,
  cor TEXT DEFAULT '#3a6fa8',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE public.categorias (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  nome TEXT NOT NULL,
  tipo TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE public.transacoes (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  tipo TEXT NOT NULL,
  descricao TEXT NOT NULL,
  valor DECIMAL(12,2) NOT NULL,
  categoria TEXT DEFAULT '',
  data DATE NOT NULL,
  conta_id UUID REFERENCES public.contas(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE public.transferencias (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  from_id UUID REFERENCES public.contas(id) ON DELETE CASCADE,
  to_id UUID REFERENCES public.contas(id) ON DELETE CASCADE,
  valor DECIMAL(12,2) NOT NULL,
  data DATE NOT NULL,
  descricao TEXT DEFAULT '',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE public.dividas (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  credor TEXT NOT NULL,
  tipo TEXT DEFAULT '',
  valor_total DECIMAL(12,2) NOT NULL,
  parcelas INTEGER DEFAULT 1,
  pagas INTEGER DEFAULT 0,
  juros DECIMAL(5,2) DEFAULT 0,
  inicio DATE,
  vencimento DATE,
  obs TEXT DEFAULT '',
  quitada BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE public.pagamentos_divida (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  divida_id UUID REFERENCES public.dividas(id) ON DELETE CASCADE NOT NULL,
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  valor DECIMAL(12,2) NOT NULL,
  data DATE NOT NULL,
  obs TEXT DEFAULT '',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE public.aposentadoria (
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE PRIMARY KEY,
  idade_atual INTEGER,
  idade_apos INTEGER,
  renda_mensal DECIMAL(12,2),
  invest_atual DECIMAL(12,2),
  taxa_anual DECIMAL(5,2) DEFAULT 6,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE public.projecao (
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE PRIMARY KEY,
  receitas JSONB DEFAULT '[]',
  despesas JSONB DEFAULT '[]',
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- 2. ROW LEVEL SECURITY (RLS)
-- Garante que cada usuário só vê e edita seus próprios dados
-- ============================================================

ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.contas ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.categorias ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.transacoes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.transferencias ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.dividas ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pagamentos_divida ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.aposentadoria ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.projecao ENABLE ROW LEVEL SECURITY;

CREATE POLICY "profiles_own" ON public.profiles FOR ALL USING (auth.uid() = id) WITH CHECK (auth.uid() = id);
CREATE POLICY "contas_own" ON public.contas FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE POLICY "categorias_own" ON public.categorias FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE POLICY "transacoes_own" ON public.transacoes FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE POLICY "transferencias_own" ON public.transferencias FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE POLICY "dividas_own" ON public.dividas FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE POLICY "pagamentos_own" ON public.pagamentos_divida FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE POLICY "aposentadoria_own" ON public.aposentadoria FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE POLICY "projecao_own" ON public.projecao FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

-- ============================================================
-- 3. TRIGGER — cria perfil automaticamente ao cadastrar usuário
-- ============================================================

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO public.profiles (id, nome)
  VALUES (
    NEW.id,
    COALESCE(NEW.raw_user_meta_data->>'nome', split_part(NEW.email, '@', 1))
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();
