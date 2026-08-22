-- ===========================================================================
-- Praça de Recarga — esquema do banco
-- PostgreSQL 18 (Aiven)
--
-- Regra de modelagem: o painel do lojista precisa responder "o carregador me
-- trouxe cliente?". Toda tabela existe para sustentar essa resposta, ou para
-- configurar o que o lojista controla.
--
-- Aplicar:  python api/db.py --aplicar
-- ===========================================================================

-- --------------------------------------------------------------------------
-- quem opera o painel. O lojista não mexe nesta tabela.
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS usuarios (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  nome          text        NOT NULL,
  email         text        NOT NULL UNIQUE,
  papel         text        NOT NULL DEFAULT 'lojista'
                            CHECK (papel IN ('lojista','operador','admin')),
  senha_hash    text,
  ativo         boolean     NOT NULL DEFAULT true,
  criado_em     timestamptz NOT NULL DEFAULT now()
);

-- --------------------------------------------------------------------------
-- o estabelecimento. Margem e ticket ficam aqui porque são o que define o
-- teto de cortesia que cada loja aguarda sem prejuízo.
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS estabelecimentos (
  id                    bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  nome                  text          NOT NULL,
  segmento              text          NOT NULL DEFAULT 'outro',
  cnpj                  text,
  margem_liquida_pct    numeric(5,2)  NOT NULL DEFAULT 10.00
                                      CHECK (margem_liquida_pct BETWEEN 0 AND 100),
  ticket_medio_brl      numeric(10,2) NOT NULL DEFAULT 100.00
                                      CHECK (ticket_medio_brl >= 0),
  tarifa_kwh_brl        numeric(6,4)  NOT NULL DEFAULT 0.7890
                                      CHECK (tarifa_kwh_brl > 0),
  demanda_contratada_kw numeric(8,2),
  criado_em             timestamptz   NOT NULL DEFAULT now(),
  atualizado_em         timestamptz   NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS usuarios_estabelecimentos (
  usuario_id          bigint NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  estabelecimento_id  bigint NOT NULL REFERENCES estabelecimentos(id) ON DELETE CASCADE,
  PRIMARY KEY (usuario_id, estabelecimento_id)
);

-- --------------------------------------------------------------------------
-- os pontos de recarga. A regra comercial fica no PONTO, não na loja: a mesma
-- loja pode ter a vaga da frente em cortesia e a dos fundos cobrando.
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS carregadores (
  id                    bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  estabelecimento_id    bigint        NOT NULL REFERENCES estabelecimentos(id) ON DELETE CASCADE,
  nome                  text          NOT NULL,
  numero_serie          text          UNIQUE,
  potencia_kw           numeric(6,2)  NOT NULL DEFAULT 7.40 CHECK (potencia_kw > 0),
  conector              text          NOT NULL DEFAULT 'Tipo 2',
  modo                  text          NOT NULL DEFAULT 'cortesia'
                                      CHECK (modo IN ('cortesia','pago')),
  -- modo cortesia: teto de ENERGIA, não de tempo. Teto por tempo não sobrevive
  -- a permanência longa, porque o lucro da compra é fixo e a energia não.
  teto_cortesia_kwh     numeric(6,2)  NOT NULL DEFAULT 6.00 CHECK (teto_cortesia_kwh >= 0),
  -- extensão proporcional: cada real gasto libera (margem / tarifa) kWh, então
  -- a energia liberada nunca custa mais que o lucro que a gerou.
  kwh_por_real          numeric(6,4)  NOT NULL DEFAULT 0.1270 CHECK (kwh_por_real >= 0),
  -- modo pago
  preco_kwh_brl         numeric(6,4)  CHECK (preco_kwh_brl IS NULL OR preco_kwh_brl >= 0),
  -- vale nos dois: evita que a vaga vire estacionamento
  carencia_min          integer       NOT NULL DEFAULT 15 CHECK (carencia_min >= 0),
  taxa_ociosidade_min   numeric(6,2)  NOT NULL DEFAULT 0.20 CHECK (taxa_ociosidade_min >= 0),
  ativo                 boolean       NOT NULL DEFAULT true,
  criado_em             timestamptz   NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_carregadores_estab ON carregadores (estabelecimento_id);

-- --------------------------------------------------------------------------
-- clientes. LGPD: nunca guardamos CPF nem telefone em claro — só um resumo
-- irreversível, que serve para reconhecer quem volta e não permite identificar
-- a pessoa a partir do banco.
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS clientes (
  id                  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  estabelecimento_id  bigint      NOT NULL REFERENCES estabelecimentos(id) ON DELETE CASCADE,
  identificador_hash  text        NOT NULL,
  apelido             text,
  modelo_veiculo      text,
  bateria_kwh         numeric(6,2),
  primeira_visita     timestamptz NOT NULL DEFAULT now(),
  ultima_visita       timestamptz,
  visitas             integer     NOT NULL DEFAULT 0,
  consentimento_lgpd  boolean     NOT NULL DEFAULT false,
  UNIQUE (estabelecimento_id, identificador_hash)
);

-- --------------------------------------------------------------------------
-- sessões de recarga: o coração do produto.
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sessoes (
  id                 bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  carregador_id      bigint        NOT NULL REFERENCES carregadores(id) ON DELETE CASCADE,
  cliente_id         bigint        REFERENCES clientes(id) ON DELETE SET NULL,
  inicio             timestamptz   NOT NULL,
  fim                timestamptz,
  energia_kwh        numeric(8,3)  NOT NULL DEFAULT 0 CHECK (energia_kwh >= 0),
  soc_inicial        numeric(4,3)  CHECK (soc_inicial BETWEEN 0 AND 1),
  soc_final          numeric(4,3)  CHECK (soc_final BETWEEN 0 AND 1),
  modo               text          NOT NULL CHECK (modo IN ('cortesia','pago')),
  -- o que a previsão disse, para o painel medir o próprio erro
  previsao_fim       timestamptz,
  previsao_custo_brl numeric(8,2),
  custo_energia_brl  numeric(8,2)  NOT NULL DEFAULT 0,
  valor_cobrado_brl  numeric(8,2)  NOT NULL DEFAULT 0,
  minutos_ocioso     integer       NOT NULL DEFAULT 0,
  situacao           text          NOT NULL DEFAULT 'ativa'
                                   CHECK (situacao IN ('ativa','concluida','interrompida')),
  CHECK (fim IS NULL OR fim >= inicio)
);
CREATE INDEX IF NOT EXISTS ix_sessoes_carregador ON sessoes (carregador_id, inicio DESC);
CREATE INDEX IF NOT EXISTS ix_sessoes_cliente    ON sessoes (cliente_id) WHERE cliente_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_sessoes_inicio     ON sessoes (inicio DESC);

-- --------------------------------------------------------------------------
-- cupons: o vínculo entre a recarga e a venda. É o que resolve a atribuição
-- sem pedir CPF nem cupom de papel — o cliente escaneia porque ganha desconto.
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS cupons (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  codigo        text          NOT NULL UNIQUE,
  sessao_id     bigint        NOT NULL REFERENCES sessoes(id) ON DELETE CASCADE,
  desconto_brl  numeric(8,2)  NOT NULL DEFAULT 0,
  emitido_em    timestamptz   NOT NULL DEFAULT now(),
  usado_em      timestamptz,
  expira_em     timestamptz
);
CREATE INDEX IF NOT EXISTS ix_cupons_sessao ON cupons (sessao_id);

-- --------------------------------------------------------------------------
-- vendas atribuídas. Só entram aqui as que carregam um cupom nosso — é o que
-- garante que cada real contado no painel tem uma venda por trás.
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS vendas (
  id                  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  estabelecimento_id  bigint        NOT NULL REFERENCES estabelecimentos(id) ON DELETE CASCADE,
  cupom_id            bigint        REFERENCES cupons(id) ON DELETE SET NULL,
  sessao_id           bigint        REFERENCES sessoes(id) ON DELETE SET NULL,
  valor_brl           numeric(10,2) NOT NULL CHECK (valor_brl >= 0),
  momento             timestamptz   NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_vendas_estab ON vendas (estabelecimento_id, momento DESC);

-- --------------------------------------------------------------------------
-- leituras do carregador. Cresce rápido e vale pouco depois de alguns dias —
-- a limpeza fica em uma rotina, não no banco.
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS leituras (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  carregador_id  bigint        NOT NULL REFERENCES carregadores(id) ON DELETE CASCADE,
  sessao_id      bigint        REFERENCES sessoes(id) ON DELETE CASCADE,
  momento        timestamptz   NOT NULL DEFAULT now(),
  potencia_kw    numeric(8,3)  NOT NULL DEFAULT 0,
  soc            numeric(4,3)  CHECK (soc IS NULL OR soc BETWEEN 0 AND 1)
);
CREATE INDEX IF NOT EXISTS ix_leituras_carregador ON leituras (carregador_id, momento DESC);

-- --------------------------------------------------------------------------
-- painéis: cada estabelecimento tem os seus, e um painel pode ser privado do
-- usuário ou compartilhado com todo mundo da loja. A disposição dos cards
-- mora aqui — é isso que faz "Editar painel" persistir entre navegadores.
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS paineis (
  id                  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  estabelecimento_id  bigint      NOT NULL REFERENCES estabelecimentos(id) ON DELETE CASCADE,
  usuario_id          bigint      REFERENCES usuarios(id) ON DELETE SET NULL,
  nome                text        NOT NULL,
  compartilhado       boolean     NOT NULL DEFAULT true,
  padrao              boolean     NOT NULL DEFAULT false,
  cards               jsonb       NOT NULL DEFAULT '[]'::jsonb,
  criado_em           timestamptz NOT NULL DEFAULT now(),
  atualizado_em       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_paineis_estab ON paineis (estabelecimento_id);

-- --------------------------------------------------------------------------
-- visões que o painel consome direto
-- --------------------------------------------------------------------------
CREATE OR REPLACE VIEW vw_sessoes_detalhe AS
SELECT s.id, s.inicio, s.fim, s.energia_kwh, s.modo, s.situacao,
       s.custo_energia_brl, s.valor_cobrado_brl, s.minutos_ocioso,
       c.id  AS carregador_id, c.nome AS carregador, c.potencia_kw,
       e.id  AS estabelecimento_id, e.nome AS estabelecimento,
       cl.apelido AS cliente,
       v.valor_brl AS venda_brl,
       ROUND(s.energia_kwh * 10.4)::int AS km_estimados
FROM sessoes s
JOIN carregadores c      ON c.id = s.carregador_id
JOIN estabelecimentos e  ON e.id = c.estabelecimento_id
LEFT JOIN clientes cl    ON cl.id = s.cliente_id
LEFT JOIN vendas v       ON v.sessao_id = s.id;

CREATE OR REPLACE VIEW vw_resumo_diario AS
SELECT e.id AS estabelecimento_id,
       date_trunc('day', s.inicio)::date AS dia,
       COUNT(*)                                   AS sessoes,
       COALESCE(SUM(s.energia_kwh), 0)            AS energia_kwh,
       COALESCE(SUM(s.custo_energia_brl), 0)      AS custo_energia_brl,
       COALESCE(SUM(s.valor_cobrado_brl), 0)      AS cobrado_brl,
       COALESCE(SUM(v.valor_brl), 0)              AS vendas_atribuidas_brl,
       COALESCE(SUM(v.valor_brl), 0) * MAX(e.margem_liquida_pct) / 100 AS lucro_atribuido_brl
FROM sessoes s
JOIN carregadores c     ON c.id = s.carregador_id
JOIN estabelecimentos e ON e.id = c.estabelecimento_id
LEFT JOIN vendas v      ON v.sessao_id = s.id
GROUP BY e.id, date_trunc('day', s.inicio);
