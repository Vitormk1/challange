-- ===========================================================================
-- Smart Charge — esquema do banco
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
-- Tres papeis, e a diferenca entre eles e o que o painel libera:
--   main     -- quem desenvolve. Ve e mexe em tudo, e troca de cliente.
--   gerente  -- dono da loja. Mexe em tudo do cliente dele, ve o financeiro,
--               mas nao troca de cliente: so existe o dele.
--   operador -- balconista. Ve tudo do cliente dele menos o financeiro, e
--               nao altera nada. O painel particular dele e a unica coisa
--               que ele monta, porque e area de trabalho dele, nao dado da
--               loja.
CREATE TABLE IF NOT EXISTS usuarios (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  nome          text        NOT NULL,
  email         text        NOT NULL UNIQUE,
  papel         text        NOT NULL DEFAULT 'operador'
                            CHECK (papel IN ('main','gerente','operador')),
  senha_hash    text        NOT NULL,
  -- tema, barra lateral, grupos fechados, ultima secao, painel ativo e
  -- ajustes de cada tabela. E o que faz o usuario abrir em outro computador
  -- e encontrar exatamente o que deixou.
  preferencias  jsonb       NOT NULL DEFAULT '{}'::jsonb,
  ultimo_acesso timestamptz,
  ativo         boolean     NOT NULL DEFAULT true,
  criado_em     timestamptz NOT NULL DEFAULT now()
);

-- --------------------------------------------------------------------------
-- sessao de login. Fica no banco, e nao so num cookie assinado, para que
-- "sair" signifique de fato encerrar: o token some daqui e nao vale mais em
-- lugar nenhum, inclusive nos outros computadores onde a pessoa esqueceu
-- aberto.
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sessoes_web (
  token       text        PRIMARY KEY,
  usuario_id  bigint      NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  criada_em   timestamptz NOT NULL DEFAULT now(),
  expira_em   timestamptz NOT NULL,
  agente      text
);
CREATE INDEX IF NOT EXISTS ix_sessoes_web_usuario ON sessoes_web (usuario_id);

-- --------------------------------------------------------------------------
-- o estabelecimento. Margem e ticket ficam aqui porque são o que define o
-- percentual de cashback que cada loja aguenta devolver sem prejuízo.
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
-- loja pode ter a vaga da frente devolvendo 10% e a dos fundos devolvendo 5%.
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS carregadores (
  id                    bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  estabelecimento_id    bigint        NOT NULL REFERENCES estabelecimentos(id) ON DELETE CASCADE,
  nome                  text          NOT NULL,
  numero_serie          text          UNIQUE,
  potencia_kw           numeric(6,2)  NOT NULL DEFAULT 7.40 CHECK (potencia_kw > 0),
  conector              text          NOT NULL DEFAULT 'Tipo 2',
  -- Todo ponto cobra por kWh. Não existe mais recarga de graça: a energia é
  -- receita, e a vaga se banca sem depender de a loja aprovar um orçamento
  -- de marketing todo mês.
  preco_kwh_brl         numeric(6,4)  NOT NULL DEFAULT 1.2000 CHECK (preco_kwh_brl >= 0),
  -- O que traz a pessoa para dentro: parte do que ela pagou volta como
  -- crédito que só vale nesta loja. Percentual e não valor fixo, porque
  -- recarga pequena e recarga grande não merecem o mesmo incentivo.
  cashback_pct          numeric(5,2)  NOT NULL DEFAULT 8.00
                                      CHECK (cashback_pct BETWEEN 0 AND 100),
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
  -- quanto desta recarga voltou como crédito da loja
  cashback_brl       numeric(8,2)  NOT NULL DEFAULT 0 CHECK (cashback_brl >= 0),
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
-- cupons: o crédito de cashback, e o vínculo entre a recarga e a venda ao
-- mesmo tempo. Resolve a atribuição sem pedir CPF: o cliente digita o código
-- porque é o dinheiro dele de volta. `desconto_brl` é o valor do crédito.
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
  -- dono do painel. Num painel particular e quem o ve; num compartilhado e
  -- so quem criou, e a loja inteira enxerga.
  usuario_id          bigint      NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  nome                text        NOT NULL,
  compartilhado       boolean     NOT NULL DEFAULT true,
  padrao              boolean     NOT NULL DEFAULT false,
  -- Um objeto por card, com tudo que o usuario mexeu:
  --   {"id":"retorno","grupo":"large","cols":11,"rows":4,"config":{}}
  -- A ordem do array e a ordem na tela. Guardar largura e altura aqui e o
  -- que faz o layout atravessar de um computador para outro.
  cards               jsonb       NOT NULL DEFAULT '[]'::jsonb,
  criado_em           timestamptz NOT NULL DEFAULT now(),
  atualizado_em       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_paineis_estab ON paineis (estabelecimento_id);

-- Um painel particular por usuario, por loja. O banco recusa o segundo, e
-- nao so a interface -- limite que so a interface respeita nao e limite.
CREATE UNIQUE INDEX IF NOT EXISTS ux_painel_particular
  ON paineis (usuario_id, estabelecimento_id) WHERE NOT compartilhado;

-- Quantos compartilhados a loja aguenta e "um por usuario dela", e isso
-- depende de contar linhas de outra tabela -- CHECK nao faz isso. Fica numa
-- funcao chamada por gatilho, que e onde essa regra ainda vale para qualquer
-- caminho de escrita.
CREATE OR REPLACE FUNCTION limite_paineis_compartilhados() RETURNS trigger AS $$
DECLARE
  usuarios_da_loja integer;
  compartilhados   integer;
BEGIN
  IF NOT NEW.compartilhado THEN
    RETURN NEW;
  END IF;
  SELECT count(*) INTO usuarios_da_loja
    FROM usuarios_estabelecimentos ue
    JOIN usuarios u ON u.id = ue.usuario_id AND u.ativo
   WHERE ue.estabelecimento_id = NEW.estabelecimento_id;
  SELECT count(*) INTO compartilhados
    FROM paineis
   WHERE estabelecimento_id = NEW.estabelecimento_id
     AND compartilhado
     AND id IS DISTINCT FROM NEW.id;
  IF compartilhados >= GREATEST(usuarios_da_loja, 1) THEN
    RAISE EXCEPTION 'limite de paineis compartilhados atingido: % para % usuario(s)',
      compartilhados, usuarios_da_loja
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS tg_limite_paineis ON paineis;
CREATE TRIGGER tg_limite_paineis
  BEFORE INSERT OR UPDATE ON paineis
  FOR EACH ROW EXECUTE FUNCTION limite_paineis_compartilhados();

-- ===========================================================================
-- Cortesia sai, cashback entra
--
-- O modelo antigo tinha dois modos por ponto: 'cortesia' (energia de graca
-- ate um teto em kWh, absorvida pela loja como marketing) e 'pago'. O novo
-- tem um so: todo mundo paga por kWh, e parte volta como credito da loja.
--
-- A migracao e destrutiva de proposito. Manter as colunas antigas "por via
-- das duvidas" deixaria duas verdades no banco, e a primeira consulta que
-- esquecesse de filtrar por modo voltaria a misturar os dois modelos.
--
-- Quem tinha ponto em cortesia (preco_kwh_brl nulo) recebe a tarifa da loja
-- com uma margem de 40%, que e o preco de partida sugerido, e 8% de cashback.
-- ===========================================================================
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_name = 'carregadores' AND column_name = 'modo') THEN

    ALTER TABLE carregadores ADD COLUMN IF NOT EXISTS
      cashback_pct numeric(5,2) NOT NULL DEFAULT 8.00;

    -- ponto que era cortesia nao tinha preco: ganha um, derivado da tarifa
    UPDATE carregadores c
       SET preco_kwh_brl = COALESCE(c.preco_kwh_brl, ROUND(e.tarifa_kwh_brl * 1.40, 4))
      FROM estabelecimentos e
     WHERE e.id = c.estabelecimento_id;
    UPDATE carregadores SET preco_kwh_brl = 1.2000 WHERE preco_kwh_brl IS NULL;

    ALTER TABLE carregadores ALTER COLUMN preco_kwh_brl SET NOT NULL;
    ALTER TABLE carregadores ALTER COLUMN preco_kwh_brl SET DEFAULT 1.2000;
    ALTER TABLE carregadores DROP COLUMN modo;
    ALTER TABLE carregadores DROP COLUMN IF EXISTS teto_cortesia_kwh;
    ALTER TABLE carregadores DROP COLUMN IF EXISTS kwh_por_real;
    ALTER TABLE carregadores ADD CONSTRAINT carregadores_cashback_pct_check
      CHECK (cashback_pct BETWEEN 0 AND 100);
  END IF;

  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_name = 'sessoes' AND column_name = 'modo') THEN
    -- a visão de detalhe le sessoes.modo e segura a coluna; ela e recriada
    -- logo adiante, ja com cashback_brl no lugar
    DROP VIEW IF EXISTS vw_sessoes_detalhe;
    ALTER TABLE sessoes ADD COLUMN IF NOT EXISTS
      cashback_brl numeric(8,2) NOT NULL DEFAULT 0;
    -- sessao antiga em cortesia nao cobrou nada, entao nao gerou credito;
    -- a que era paga gera o cashback padrao sobre o que foi cobrado
    UPDATE sessoes SET cashback_brl = ROUND(valor_cobrado_brl * 0.08, 2)
     WHERE modo = 'pago';
    ALTER TABLE sessoes DROP COLUMN modo;
  END IF;
END $$;

-- --------------------------------------------------------------------------
-- visões que o painel consome direto
-- --------------------------------------------------------------------------
-- DROP antes do CREATE: `CREATE OR REPLACE VIEW` recusa mudar a LISTA de
-- colunas, e esta mudou (modo saiu, cashback_brl entrou). Sem o drop, o
-- schema falha em todo banco que já existia.
DROP VIEW IF EXISTS vw_sessoes_detalhe;
CREATE OR REPLACE VIEW vw_sessoes_detalhe AS
SELECT s.id, s.inicio, s.fim, s.energia_kwh, s.cashback_brl, s.situacao,
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


-- ===========================================================================
-- Migracao. As tabelas acima usam CREATE IF NOT EXISTS, entao num banco que
-- ja existe elas nao mudam sozinhas. Este bloco leva o esquema antigo ate o
-- de cima, e pode rodar quantas vezes for.
-- ===========================================================================
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS preferencias  jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS ultimo_acesso timestamptz;

DO $$
BEGIN
  -- papeis antigos (lojista/admin) viram os tres de agora
  IF EXISTS (SELECT 1 FROM information_schema.constraint_column_usage
              WHERE table_name = 'usuarios' AND constraint_name = 'usuarios_papel_check') THEN
    ALTER TABLE usuarios DROP CONSTRAINT usuarios_papel_check;
  END IF;
  UPDATE usuarios SET papel = 'main'    WHERE papel = 'admin';
  UPDATE usuarios SET papel = 'gerente' WHERE papel = 'lojista';
  ALTER TABLE usuarios ADD CONSTRAINT usuarios_papel_check
    CHECK (papel IN ('main','gerente','operador'));
  ALTER TABLE usuarios ALTER COLUMN papel SET DEFAULT 'operador';
END $$;

-- quem nao tem senha nao entra, entao nao e usuario de nada
DELETE FROM usuarios WHERE senha_hash IS NULL;
ALTER TABLE usuarios ALTER COLUMN senha_hash SET NOT NULL;

-- painel sem dono nao tem como ser "o particular de alguem"
DELETE FROM paineis WHERE usuario_id IS NULL;
ALTER TABLE paineis ALTER COLUMN usuario_id SET NOT NULL;

DO $$
BEGIN
  -- o dono sai, o painel dele sai junto (antes era SET NULL, que deixava orfao)
  IF EXISTS (SELECT 1 FROM information_schema.table_constraints
              WHERE table_name = 'paineis' AND constraint_name = 'paineis_usuario_id_fkey') THEN
    ALTER TABLE paineis DROP CONSTRAINT paineis_usuario_id_fkey;
  END IF;
  ALTER TABLE paineis ADD CONSTRAINT paineis_usuario_id_fkey
    FOREIGN KEY (usuario_id) REFERENCES usuarios(id) ON DELETE CASCADE;
END $$;

-- ===========================================================================
-- Historico nao some junto com cadastro
--
-- Sessao, leitura e cupom sao o que aconteceu de fato; carregador e uma linha
-- de configuracao. Com ON DELETE CASCADE, um clique em "excluir carregador"
-- levava junto 69 sessoes, 671 leituras e 69 cupons -- sem perguntar nada.
-- Agora o banco recusa, e o painel oferece desativar em vez de excluir.
-- ===========================================================================
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.table_constraints
              WHERE table_name = 'sessoes' AND constraint_name = 'sessoes_carregador_id_fkey') THEN
    ALTER TABLE sessoes DROP CONSTRAINT sessoes_carregador_id_fkey;
  END IF;
  ALTER TABLE sessoes ADD CONSTRAINT sessoes_carregador_id_fkey
    FOREIGN KEY (carregador_id) REFERENCES carregadores(id) ON DELETE RESTRICT;

  IF EXISTS (SELECT 1 FROM information_schema.table_constraints
              WHERE table_name = 'leituras' AND constraint_name = 'leituras_carregador_id_fkey') THEN
    ALTER TABLE leituras DROP CONSTRAINT leituras_carregador_id_fkey;
  END IF;
  ALTER TABLE leituras ADD CONSTRAINT leituras_carregador_id_fkey
    FOREIGN KEY (carregador_id) REFERENCES carregadores(id) ON DELETE RESTRICT;

  -- venda com cupom continua valendo mesmo se a sessao for apagada
  IF EXISTS (SELECT 1 FROM information_schema.table_constraints
              WHERE table_name = 'vendas' AND constraint_name = 'vendas_cupom_id_fkey') THEN
    ALTER TABLE vendas DROP CONSTRAINT vendas_cupom_id_fkey;
  END IF;
  ALTER TABLE vendas ADD CONSTRAINT vendas_cupom_id_fkey
    FOREIGN KEY (cupom_id) REFERENCES cupons(id) ON DELETE SET NULL;
END $$;

-- Loja desativada derruba a sessao de quem estava dentro dela, como o
-- usuario desativado ja fazia.
ALTER TABLE estabelecimentos ADD COLUMN IF NOT EXISTS ativo boolean NOT NULL DEFAULT true;

-- Carregador desativado nao aceita sessao nova, mas o que ja rodou continua
-- na tabela. E o caminho no lugar de excluir.
COMMENT ON COLUMN carregadores.ativo IS
  'false = fora de operacao. Preferir isto a excluir: excluir e recusado quando ha historico.';
