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
  -- 'motorista' e o unico papel que se cria sozinho, pelo cadastro aberto do
  -- site. Ele NAO tem vinculo em usuarios_estabelecimentos, e e isso que o
  -- mantem longe do dado de loja: exigir_loja() recusa qualquer loja que nao
  -- esteja na lista dele, e a lista dele e vazia. A protecao nao depende de
  -- lembrarem de checar o papel em cada rota.
  papel         text        NOT NULL DEFAULT 'operador'
                            CHECK (papel IN ('main','gerente','operador','motorista')),
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
  -- A ficha vira de alguem quando um motorista com conta reconhece a recarga
  -- como dele. Fica NULL enquanto a pessoa carrega sem se identificar, que
  -- continua sendo o caso comum: quem chega no ponto nao precisa ter conta.
  --
  -- SET NULL ao excluir o usuario, e nao CASCADE: o historico de visitas e da
  -- LOJA, nao do motorista. Apagar a conta desliga o nome do registro; nao
  -- apaga a venda que aconteceu nem o cashback que a loja ja pagou.
  usuario_id          bigint      REFERENCES usuarios(id) ON DELETE SET NULL,
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
  -- papeis antigos (lojista/admin) viram os de agora
  IF EXISTS (SELECT 1 FROM information_schema.constraint_column_usage
              WHERE table_name = 'usuarios' AND constraint_name = 'usuarios_papel_check') THEN
    ALTER TABLE usuarios DROP CONSTRAINT usuarios_papel_check;
  END IF;
  UPDATE usuarios SET papel = 'main'    WHERE papel = 'admin';
  UPDATE usuarios SET papel = 'gerente' WHERE papel = 'lojista';
  ALTER TABLE usuarios ALTER COLUMN papel SET DEFAULT 'operador';
  -- A restricao NAO e recriada aqui. Ela tem um dono so, no fim do arquivo.
  --
  -- Este bloco ja a recriou uma vez, com a lista de tres papeis que valia
  -- quando foi escrito. Quando 'motorista' chegou, o bloco do fim passou a
  -- ampliar a lista para quatro -- mas este roda ANTES, e no instante em que
  -- existiu o primeiro motorista na tabela ele passou a estourar
  --
  --     check constraint "usuarios_papel_check" is violated by some row
  --
  -- abortando o script inteiro antes que o bloco do fim consertasse. O
  -- schema.sql ficava impossivel de aplicar justamente no banco que ja tinha
  -- usuarios de verdade, que e o unico que importa. Duas linhas escrevendo a
  -- mesma restricao e uma delas desatualizada e uma armadilha; agora e uma.
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


-- --------------------------------------------------------------------------
-- O papel 'motorista' chegou depois. Num banco que ja existe, a restricao
-- antiga continua valendo e recusaria o primeiro cadastro; esta migracao a
-- substitui. E idempotente: rodar de novo nao quebra.
-- --------------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.constraint_column_usage
              WHERE table_name = 'usuarios' AND constraint_name = 'usuarios_papel_check') THEN
    ALTER TABLE usuarios DROP CONSTRAINT usuarios_papel_check;
  END IF;
  ALTER TABLE usuarios ADD CONSTRAINT usuarios_papel_check
    CHECK (papel IN ('main','gerente','operador','motorista'));
END $$;


-- --------------------------------------------------------------------------
-- Liga a ficha de cliente a uma conta de motorista.
--
-- Sem esta coluna o motorista entrava e nao havia como dizer quais recargas
-- eram dele: sessoes aponta para clientes, e clientes e uma ficha por LOJA,
-- identificada por hash, sem nenhuma ligacao com usuarios.
--
-- Que a ficha seja por loja nao e defeito, e o desenho certo: o cashback so
-- vale onde foi gerado, entao quem carrega em tres lugares tem tres fichas e
-- tres saldos. Esta coluna amarra as tres a mesma conta.
--
-- Aditiva e idempotente: nao reescreve linha nenhuma e pode rodar de novo.
-- --------------------------------------------------------------------------
ALTER TABLE clientes ADD COLUMN IF NOT EXISTS usuario_id bigint;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.table_constraints
                  WHERE table_name = 'clientes'
                    AND constraint_name = 'clientes_usuario_id_fkey') THEN
    ALTER TABLE clientes ADD CONSTRAINT clientes_usuario_id_fkey
      FOREIGN KEY (usuario_id) REFERENCES usuarios(id) ON DELETE SET NULL;
  END IF;
END $$;

-- Os dois indices ficam aqui, e nao la em cima junto dos outros: num banco
-- que ja existe o CREATE TABLE nao faz nada, a coluna so aparece no ALTER
-- acima, e um indice escrito antes dele falha com "column does not exist".
--
-- Uma ficha por motorista em cada loja. O UNIQUE e parcial porque usuario_id
-- e NULL na maioria das linhas -- as fichas anonimas -- e esses NULLs nao
-- podem contar como repeticao.
CREATE UNIQUE INDEX IF NOT EXISTS ux_clientes_usuario_loja
  ON clientes (estabelecimento_id, usuario_id) WHERE usuario_id IS NOT NULL;

-- A consulta da tela do motorista atravessa as lojas: "todas as minhas
-- fichas". Sem este indice ela varreria a tabela inteira.
CREATE INDEX IF NOT EXISTS ix_clientes_usuario
  ON clientes (usuario_id) WHERE usuario_id IS NOT NULL;

COMMENT ON COLUMN clientes.usuario_id IS
  'Conta do motorista dono desta ficha. NULL = carregou sem se identificar.';

-- --------------------------------------------------------------------------
-- Carteira do motorista. Saldo nunca e alterado por uma confirmacao vinda do
-- navegador: cada centavo nasce em um lancamento, e uma cobranca Pix so vira
-- credito quando o webhook autenticado da Asaas a marca como recebida.
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS carteiras (
  usuario_id        bigint PRIMARY KEY REFERENCES usuarios(id) ON DELETE CASCADE,
  asaas_cliente_id  text UNIQUE,
  criado_em         timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS carteira_lancamentos (
  id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  usuario_id        bigint NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  tipo              text NOT NULL CHECK (tipo IN ('recarga_pix','credito_teste','pagamento_recarga','estorno')),
  valor_brl         numeric(10,2) NOT NULL CHECK (valor_brl <> 0),
  descricao         text NOT NULL,
  referencia        text UNIQUE,
  criado_em         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_carteira_lancamentos_usuario
  ON carteira_lancamentos (usuario_id, criado_em DESC);

CREATE TABLE IF NOT EXISTS carteira_pix (
  id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  usuario_id        bigint NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  asaas_pagamento_id text NOT NULL UNIQUE,
  valor_brl         numeric(10,2) NOT NULL CHECK (valor_brl > 0),
  status            text NOT NULL DEFAULT 'PENDING',
  payload_pix       text,
  expiracao_em      timestamptz,
  recebido_em       timestamptz,
  criado_em         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_carteira_pix_usuario ON carteira_pix (usuario_id, criado_em DESC);

-- Entrega de webhook e "pelo menos uma vez". Guardar o id do evento faz o
-- segundo envio inofensivo, em vez de duplicar saldo.
CREATE TABLE IF NOT EXISTS carteira_eventos_asaas (
  evento_id         text PRIMARY KEY,
  recebido_em       timestamptz NOT NULL DEFAULT now()
);

-- Retomada de Pix e identificação do ambiente. Sem guardar CPF/CNPJ.
ALTER TABLE carteiras ADD COLUMN IF NOT EXISTS asaas_base text;
ALTER TABLE carteiras ADD COLUMN IF NOT EXISTS pix_referencia text;
ALTER TABLE carteira_pix ADD COLUMN IF NOT EXISTS asaas_base text;
ALTER TABLE carteira_pix ADD COLUMN IF NOT EXISTS imagem_base64 text;
ALTER TABLE carteira_pix ADD COLUMN IF NOT EXISTS verificado_em timestamptz;

-- --------------------------------------------------------------------------
-- Programa de fidelidade da loja: um dos tres modelos, nunca mais de um ao
-- mesmo tempo. Colunas tipadas e anulaveis em vez de tabela ou jsonb novos --
-- e o mesmo desenho de margem_liquida_pct/ticket_medio_brl, e o CHECK deixa
-- passar NULL: "ainda nao escolheu" nao e o mesmo que "escolheu um valor
-- invalido". Trocar de modelo nao apaga a configuracao do modelo anterior,
-- entao voltar para ele reaproveita o que estava salvo.
-- --------------------------------------------------------------------------
ALTER TABLE estabelecimentos ADD COLUMN IF NOT EXISTS fidelidade_tipo text
  CHECK (fidelidade_tipo IN ('cashback','tiers','creditos'));

-- Cashback: % de desconto na proxima carga.
ALTER TABLE estabelecimentos ADD COLUMN IF NOT EXISTS fidelidade_cashback_pct numeric(5,2)
  CHECK (fidelidade_cashback_pct BETWEEN 0 AND 100);

-- Tiers: desconto da 1a compra do mes, e o desconto maior a partir de qual
-- compra do mes.
ALTER TABLE estabelecimentos ADD COLUMN IF NOT EXISTS fidelidade_tiers_desconto_inicial_pct numeric(5,2)
  CHECK (fidelidade_tiers_desconto_inicial_pct BETWEEN 0 AND 100);
ALTER TABLE estabelecimentos ADD COLUMN IF NOT EXISTS fidelidade_tiers_a_partir_da_compra integer
  CHECK (fidelidade_tiers_a_partir_da_compra >= 2);
ALTER TABLE estabelecimentos ADD COLUMN IF NOT EXISTS fidelidade_tiers_desconto_top_pct numeric(5,2)
  CHECK (fidelidade_tiers_desconto_top_pct BETWEEN 0 AND 100);

-- Creditos do app: quanto se gasta por credito, e quantos minutos de carga
-- vale cada credito.
ALTER TABLE estabelecimentos ADD COLUMN IF NOT EXISTS fidelidade_creditos_reais_por_credito numeric(10,2)
  CHECK (fidelidade_creditos_reais_por_credito > 0);
ALTER TABLE estabelecimentos ADD COLUMN IF NOT EXISTS fidelidade_creditos_minutos_por_credito numeric(10,2)
  CHECK (fidelidade_creditos_minutos_por_credito > 0);


-- --------------------------------------------------------------------------
-- Verificacao de e-mail
--
-- Ate aqui bastava digitar qualquer coisa com @ para ter conta. Isso deixava
-- duas portas abertas: cadastrar com o e-mail de outra pessoa, e encher a
-- tabela de contas que nunca existiram.
--
-- `email_verificado` comeca TRUE para quem ja existe. Sao as contas que nos
-- mesmos criamos, e marca-las como pendentes trancaria todo mundo para fora
-- do painel de uma vez -- inclusive o lojista, que nunca recebeu e-mail de
-- confirmacao nenhum porque o fluxo nao existia.
-- --------------------------------------------------------------------------
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS email_verificado boolean NOT NULL DEFAULT true;
ALTER TABLE usuarios ALTER COLUMN email_verificado SET DEFAULT false;

COMMENT ON COLUMN usuarios.email_verificado IS
  'false = cadastrou e ainda nao clicou no link. O DEFAULT e false: conta nova nasce pendente.';

-- O token vive aqui, e nao numa coluna de usuarios, porque pedir um novo
-- reenvio nao pode invalidar em silencio o link que a pessoa ja tem no
-- e-mail: os dois valem ate expirar, e o primeiro clique resolve.
CREATE TABLE IF NOT EXISTS verificacoes_email (
  token       text        PRIMARY KEY,
  usuario_id  bigint      NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  criado_em   timestamptz NOT NULL DEFAULT now(),
  expira_em   timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS ix_verificacoes_usuario ON verificacoes_email (usuario_id);
-- Para a limpeza dos vencidos nao varrer a tabela inteira.
CREATE INDEX IF NOT EXISTS ix_verificacoes_expira  ON verificacoes_email (expira_em);

-- Motor de fidelidade: a loja escolhe um modelo (migracao acima) e agora
-- toda COMPRA identificada acumula de verdade, em vez de so mostrar a
-- configuracao.
--
-- vendas nasceu para o que carrega um cupom nosso atras (comentario na
-- CREATE TABLE acima) -- garante que todo real contado no painel tem uma
-- venda de verdade por tras do cashback de carga. Isso deixa de fora a
-- compra comum de balcao, sem carregar nada, que e exatamente o exemplo do
-- proprio programa ("cliente gasta R$40 no cafe"). cliente_id e um segundo
-- jeito, independente do cupom, de dizer quem comprou -- anulavel: venda
-- sem cliente identificado continua existindo, so nao acumula fidelidade.
-- --------------------------------------------------------------------------
ALTER TABLE vendas ADD COLUMN IF NOT EXISTS cliente_id bigint
  REFERENCES clientes(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS ix_vendas_cliente ON vendas (cliente_id) WHERE cliente_id IS NOT NULL;

-- Saldo por cliente. Os tres campos existem sempre, mas so o do modelo ativo
-- da loja e o que muda com as compras -- trocar de modelo nao apaga o que o
-- cliente ja acumulou no anterior (mesma ideia das colunas de configuracao
-- em estabelecimentos).
ALTER TABLE clientes ADD COLUMN IF NOT EXISTS fidelidade_saldo_cashback_brl numeric(10,2)
  NOT NULL DEFAULT 0 CHECK (fidelidade_saldo_cashback_brl >= 0);
ALTER TABLE clientes ADD COLUMN IF NOT EXISTS fidelidade_creditos numeric(10,2)
  NOT NULL DEFAULT 0 CHECK (fidelidade_creditos >= 0);
ALTER TABLE clientes ADD COLUMN IF NOT EXISTS fidelidade_compras_mes integer
  NOT NULL DEFAULT 0 CHECK (fidelidade_compras_mes >= 0);
ALTER TABLE clientes ADD COLUMN IF NOT EXISTS fidelidade_mes_referencia date;


-- ==========================================================================
-- Reserva de carregador
-- ==========================================================================

-- Coordenadas na LOJA, e nao no carregador: as vagas de um mesmo
-- estabelecimento ficam no mesmo endereco, e repetir o par em cada carregador
-- criaria duas verdades para a mesma coisa.
ALTER TABLE estabelecimentos ADD COLUMN IF NOT EXISTS lat numeric(9,6);
ALTER TABLE estabelecimentos ADD COLUMN IF NOT EXISTS lng numeric(9,6);

COMMENT ON COLUMN estabelecimentos.lat IS
  'Latitude do ponto no mapa publico. NULL = nao aparece no mapa.';

-- O mapa so mostra quem tem coordenada, entao este indice parcial e o que ele
-- percorre.
CREATE INDEX IF NOT EXISTS ix_estabelecimentos_mapa
  ON estabelecimentos (id) WHERE lat IS NOT NULL AND lng IS NOT NULL;


CREATE TABLE IF NOT EXISTS reservas (
  id             bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  carregador_id  bigint      NOT NULL REFERENCES carregadores(id) ON DELETE CASCADE,
  usuario_id     bigint      NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  inicio         timestamptz NOT NULL,
  fim            timestamptz NOT NULL,
  -- ativa     reservada, ainda vai acontecer
  -- cumprida  a pessoa apareceu e carregou
  -- cancelada desistiu dentro do prazo; o valor voltou para a carteira
  -- expirada  passou da hora e nao apareceu; o valor fica com a loja
  situacao       text        NOT NULL DEFAULT 'ativa'
                 CHECK (situacao IN ('ativa','cumprida','cancelada','expirada')),
  valor_brl      numeric(10,2) NOT NULL CHECK (valor_brl >= 0),
  criado_em      timestamptz NOT NULL DEFAULT now(),
  encerrada_em   timestamptz,
  CHECK (fim > inicio)
);

CREATE INDEX IF NOT EXISTS ix_reservas_usuario     ON reservas (usuario_id, inicio DESC);
CREATE INDEX IF NOT EXISTS ix_reservas_carregador  ON reservas (carregador_id, inicio);

-- Duas reservas nao podem ocupar o mesmo carregador ao mesmo tempo, e quem
-- garante isso e o banco.
--
-- A alternativa seria consultar antes de inserir, e ela tem um buraco que so
-- aparece em producao: entre a consulta e a insercao cabe outra reserva. Com
-- duas pessoas olhando o mesmo horario -- que e exatamente quando a disputa
-- acontece -- as duas consultam, as duas veem livre, e as duas reservam.
--
-- EXCLUDE resolve no proprio indice: `carregador_id WITH =` junta as linhas do
-- mesmo carregador, `tstzrange(inicio, fim) WITH &&` recusa quando os periodos
-- se cruzam. Precisa do btree_gist para misturar igualdade com intervalo no
-- mesmo indice.
--
-- O WHERE limita a regra as reservas ativas: cancelada e expirada podem
-- conviver com uma nova no mesmo horario, e devem.
CREATE EXTENSION IF NOT EXISTS btree_gist;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'reservas'::regclass
                    AND conname = 'reservas_sem_sobreposicao') THEN
    ALTER TABLE reservas ADD CONSTRAINT reservas_sem_sobreposicao
      EXCLUDE USING gist (carregador_id WITH =, tstzrange(inicio, fim) WITH &&)
      WHERE (situacao = 'ativa');
  END IF;
END $$;


-- A carteira precisa saber lancar reserva e devolucao de reserva.
--
-- Esta restricao e compartilhada: a carteira e de outra pessoa da equipe, e
-- tipos novos entram aqui. Se dois commits acrescentarem tipos diferentes, o
-- ultimo a rodar vence e derruba o do outro em silencio -- ja aconteceu neste
-- projeto com o papel do usuario. Por isso a lista abaixo e a UNIAO de tudo
-- que existe, e quem acrescentar um tipo deve acrescentar aqui, nao criar
-- outro bloco.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint
              WHERE conrelid = 'carteira_lancamentos'::regclass
                AND conname = 'carteira_lancamentos_tipo_check') THEN
    ALTER TABLE carteira_lancamentos DROP CONSTRAINT carteira_lancamentos_tipo_check;
  END IF;
  ALTER TABLE carteira_lancamentos ADD CONSTRAINT carteira_lancamentos_tipo_check
    CHECK (tipo IN ('recarga_pix','credito_teste','pagamento_recarga','estorno',
                    'reserva','estorno_reserva'));
END $$;


-- --------------------------------------------------------------------------
-- Lojas que existem so para o mapa
--
-- Os 12 pontos do mapa viraram estabelecimentos de verdade para poderem ser
-- reservados. Eles nao tem operacao nenhuma -- nenhuma recarga, nenhuma
-- venda, ninguem vinculado -- e mesmo assim apareciam no seletor de lojas do
-- painel, porque o papel 'main' enxerga todas as lojas ativas. O seletor
-- passou de 3 para 15, com 12 vazias no meio.
--
-- `so_mapa` separa as duas coisas. Quem vende de verdade aparece no painel;
-- ponto de mapa aparece no mapa. E uma coluna e nao uma tabela porque a
-- diferenca e de proposito, nao de natureza: o dia que um desses pontos virar
-- cliente, muda um booleano.
-- --------------------------------------------------------------------------
ALTER TABLE estabelecimentos ADD COLUMN IF NOT EXISTS so_mapa boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN estabelecimentos.so_mapa IS
  'true = ponto de demonstracao do mapa; nao aparece no seletor do painel.';


-- ==========================================================================
-- Carteira: boleto e cartao, alem do Pix
--
-- A tabela continua chamando-se carteira_pix. Renomear seria mais bonito e
-- mais caro: ela e referenciada em dezenas de lugares no carteira.py, no
-- webhook e no front, e o ganho seria so o nome. O que passa a distinguir as
-- formas e a coluna `forma`.
-- ==========================================================================

ALTER TABLE carteira_pix ADD COLUMN IF NOT EXISTS forma text NOT NULL DEFAULT 'pix';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'carteira_pix'::regclass
                    AND conname = 'carteira_pix_forma_check') THEN
    ALTER TABLE carteira_pix ADD CONSTRAINT carteira_pix_forma_check
      CHECK (forma IN ('pix','boleto','cartao'));
  END IF;
END $$;

-- Pix mostra QR e copia-e-cola; boleto mostra linha digitavel e PDF; cartao
-- manda para o checkout da Asaas. Cada forma guarda o que precisa, e o que
-- nao usa fica nulo.
ALTER TABLE carteira_pix ADD COLUMN IF NOT EXISTS url_pagamento   text;
ALTER TABLE carteira_pix ADD COLUMN IF NOT EXISTS linha_digitavel text;
ALTER TABLE carteira_pix ADD COLUMN IF NOT EXISTS url_boleto      text;

COMMENT ON COLUMN carteira_pix.forma IS
  'pix | boleto | cartao. A tabela guarda as tres; o nome ficou do tempo em que so havia Pix.';
COMMENT ON COLUMN carteira_pix.url_pagamento IS
  'Checkout hospedado da Asaas (invoiceUrl). E por onde o cartao e digitado: o numero nunca passa por este servidor.';

-- Uma cobranca pendente por forma, e nao uma no total: ter um boleto em
-- aberto nao pode impedir de gerar um Pix para pagar agora.
CREATE INDEX IF NOT EXISTS ix_carteira_pix_pendente
  ON carteira_pix (usuario_id, forma, status) WHERE status = 'PENDING';


-- O extrato passa a dizer por onde o dinheiro entrou. Lista completa: quem
-- acrescentar tipo novo acrescenta AQUI, sem criar outro bloco -- dois
-- blocos mexendo na mesma restricao ja se derrubaram neste projeto.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint
              WHERE conrelid = 'carteira_lancamentos'::regclass
                AND conname = 'carteira_lancamentos_tipo_check') THEN
    ALTER TABLE carteira_lancamentos DROP CONSTRAINT carteira_lancamentos_tipo_check;
  END IF;
  ALTER TABLE carteira_lancamentos ADD CONSTRAINT carteira_lancamentos_tipo_check
    CHECK (tipo IN ('recarga_pix','recarga_boleto','recarga_cartao',
                    'credito_teste','pagamento_recarga','estorno',
                    'reserva','estorno_reserva'));
END $$;



-- ==========================================================================
-- Foto de perfil
--
-- Guardada como data URL (base64) numa coluna de texto, e nao como arquivo.
-- Nao e o que um sistema grande faria -- imagem em banco engorda backup e
-- nao ganha CDN --, mas aqui nao ha armazenamento de objetos, o Render
-- gratuito tem disco efemero (arquivo enviado some no proximo deploy), e a
-- imagem e recortada em 256x256 no navegador antes de subir: ~20 KB por
-- pessoa. A alternativa honesta seria contratar um bucket; a desonesta seria
-- gravar em disco e descobrir na banca que as fotos sumiram.
--
-- O teto e imposto no servidor (api/main.py), nao aqui: o CHECK serve para o
-- caso de alguem escrever direto no banco.
-- ==========================================================================

ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS foto text;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'usuarios'::regclass
                    AND conname = 'usuarios_foto_check') THEN
    ALTER TABLE usuarios ADD CONSTRAINT usuarios_foto_check
      CHECK (foto IS NULL OR (foto LIKE 'data:image/%' AND length(foto) <= 400000));
  END IF;
END $$;

COMMENT ON COLUMN usuarios.foto IS
  'Data URL da foto de perfil, 256x256, recortada no navegador. Nulo = icone padrao.';


-- ==========================================================================
-- Gerenciamento da demanda de potencia
--
-- Ate aqui a loja DECLARAVA `demanda_contratada_kw` e ninguem calculava nada
-- em cima dela. Estes campos sao o que falta para a conta fechar:
--
--   carga_base_kw    o carregador divide o medidor com a geladeira e o
--                    ar-condicionado. Sem saber o que a loja consome sozinha,
--                    o teto do carregador e um chute -- e o erro so aparece na
--                    fatura, como multa de ultrapassagem.
--
--   ponta            tres horas consecutivas em dias uteis em que a energia
--                    custa varias vezes mais. Os horarios exatos vem da
--                    distribuidora, por isso sao campo da loja e nao constante
--                    no codigo. `tarifa_kwh_brl`, que ja existia, passa a ser
--                    a de FORA de ponta.
--
--   solar e bateria  cada kW que vem do telhado nao passa pelo medidor, entao
--                    levanta o teto enquanto o sol esta no ceu. A bateria
--                    guarda o excedente do meio-dia e devolve na ponta, que e
--                    quando o teto aperta e a tarifa pesa.
--
-- A conta em si esta em ai/demanda.py, que nao toca no banco.
-- ==========================================================================

ALTER TABLE estabelecimentos
  ADD COLUMN IF NOT EXISTS carga_base_kw         numeric(8,2)  NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS grupo_tarifario       text          NOT NULL DEFAULT 'B',
  ADD COLUMN IF NOT EXISTS ponta_inicio          smallint      NOT NULL DEFAULT 18,
  ADD COLUMN IF NOT EXISTS ponta_fim             smallint      NOT NULL DEFAULT 21,
  ADD COLUMN IF NOT EXISTS tarifa_ponta_kwh_brl  numeric(6,4),
  ADD COLUMN IF NOT EXISTS solar_kwp             numeric(8,2)  NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS bateria_kwh           numeric(8,2)  NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS bateria_kw            numeric(8,2)  NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS bateria_soc           numeric(4,3)  NOT NULL DEFAULT 0.500;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'estabelecimentos'::regclass
                    AND conname = 'estabelecimentos_demanda_check') THEN
    ALTER TABLE estabelecimentos ADD CONSTRAINT estabelecimentos_demanda_check
      CHECK (carga_base_kw >= 0
         AND solar_kwp     >= 0
         AND bateria_kwh   >= 0
         AND bateria_kw    >= 0
         AND bateria_soc BETWEEN 0 AND 1
         AND grupo_tarifario IN ('A', 'B')
         -- Janela de ponta valida: comeca antes de terminar, e cabe no dia.
         -- Sem isto, uma janela invertida faria `em_ponta` responder sempre
         -- nao, e a loja carregaria na hora cara sem ninguem perceber.
         AND ponta_inicio BETWEEN 0 AND 23
         AND ponta_fim    BETWEEN 1 AND 24
         AND ponta_inicio < ponta_fim
         AND (tarifa_ponta_kwh_brl IS NULL OR tarifa_ponta_kwh_brl > 0));
  END IF;
END $$;

COMMENT ON COLUMN estabelecimentos.carga_base_kw IS
  'O que a loja consome sem os carregadores. Entra como piso na conta do teto.';
COMMENT ON COLUMN estabelecimentos.tarifa_ponta_kwh_brl IS
  'Tarifa no horario de ponta. Nulo = sem tarifa horaria; usa tarifa_kwh_brl o dia todo.';
COMMENT ON COLUMN estabelecimentos.bateria_soc IS
  'Estado de carga da bateria, de 0 a 1. Numa instalacao real viria do inversor.';

-- As leituras ja guardam potencia por carregador e por instante; o que faltava
-- era conseguir varrer uma loja inteira por faixa de tempo sem ler a tabela
-- toda. E a consulta que desenha a curva de 24h do painel.
CREATE INDEX IF NOT EXISTS ix_leituras_carregador_momento
  ON leituras (carregador_id, momento DESC);


-- --------------------------------------------------------------------------
-- Leilao de potencia
--
-- Quando varios carros disputam a mesma folga, `repartir` divide pelo que cada
-- bateria fisicamente aceita. E justo, e ignora uma informacao que so o
-- motorista tem: se ELE tem pressa. Quem vai ficar duas horas no mercado nao
-- precisa de 11 kW; quem parou dez minutos, precisa.
--
-- O leilao pergunta. Aceitar menos potencia rende mais cashback -- o mesmo
-- multiplicador que ja existe para a hora do dia (ver fator_cashback em
-- ai/demanda.py), agora tambem para a paciencia.
--
-- Quem define as opcoes e o lojista, na aba de Fidelidade do painel, junto do
-- programa de cashback. Sao duas, e nao uma lista livre: a telinha mostra a
-- escolha em tres botoes (cheia, opcao 1, opcao 2) e tres cabem na tela de
-- quem esta em pe ao lado do carro. Colunas tipadas e anulaveis, no mesmo
-- desenho das colunas de fidelidade logo acima.
-- --------------------------------------------------------------------------
ALTER TABLE estabelecimentos ADD COLUMN IF NOT EXISTS leilao_ativo boolean NOT NULL DEFAULT false;

-- Teto do multiplicador. Existe para o lojista nao configurar sem querer um
-- premio que come o retorno da vaga inteira -- ver ai/break_even.py.
ALTER TABLE estabelecimentos ADD COLUMN IF NOT EXISTS leilao_teto_fator numeric(4,2)
  CHECK (leilao_teto_fator IS NULL OR leilao_teto_fator BETWEEN 1 AND 5);

-- Opcao 1: "sem pressa". Opcao 2: "deixa quieto".
ALTER TABLE estabelecimentos ADD COLUMN IF NOT EXISTS leilao_op1_potencia_pct numeric(5,2)
  CHECK (leilao_op1_potencia_pct IS NULL OR leilao_op1_potencia_pct BETWEEN 10 AND 100);
ALTER TABLE estabelecimentos ADD COLUMN IF NOT EXISTS leilao_op1_fator numeric(4,2)
  CHECK (leilao_op1_fator IS NULL OR leilao_op1_fator BETWEEN 1 AND 5);
ALTER TABLE estabelecimentos ADD COLUMN IF NOT EXISTS leilao_op2_potencia_pct numeric(5,2)
  CHECK (leilao_op2_potencia_pct IS NULL OR leilao_op2_potencia_pct BETWEEN 10 AND 100);
ALTER TABLE estabelecimentos ADD COLUMN IF NOT EXISTS leilao_op2_fator numeric(4,2)
  CHECK (leilao_op2_fator IS NULL OR leilao_op2_fator BETWEEN 1 AND 5);

COMMENT ON COLUMN estabelecimentos.leilao_ativo IS
  'Liga a pergunta na telinha quando falta potencia. Desligado, a vaga entrega o que couber, como antes.';
COMMENT ON COLUMN estabelecimentos.leilao_op1_potencia_pct IS
  'Percentual da potencia da vaga que a opcao 1 entrega. O resto volta para o bolo de quem tem pressa.';


-- --------------------------------------------------------------------------
-- A sessao da telinha
--
-- A telinha nasceu simulando tudo no navegador, com os parametros na URL. Isso
-- deu a ela uma propriedade que vale manter: funciona com a internet da loja
-- fora do ar, que e quando uma tela ao lado do carregador mais importa.
--
-- O que faltava era o outro lado: quando HA rede, a sessao existir de verdade
-- no servidor, para o motorista acompanhar do celular e para a recarga entrar
-- no historico da loja.
--
-- `token` e o que vai no QR. Aleatorio e nao sequencial: id sequencial na URL
-- deixaria qualquer um varrer as sessoes dos outros trocando o numero.
-- --------------------------------------------------------------------------
ALTER TABLE sessoes ADD COLUMN IF NOT EXISTS token text;
CREATE UNIQUE INDEX IF NOT EXISTS ux_sessoes_token ON sessoes (token) WHERE token IS NOT NULL;

-- O que a pessoa escolheu no leilao, guardado na sessao. Sem isto nao da para
-- explicar depois por que aquela recarga rendeu mais cashback que a tabela.
ALTER TABLE sessoes ADD COLUMN IF NOT EXISTS leilao_potencia_pct numeric(5,2);
ALTER TABLE sessoes ADD COLUMN IF NOT EXISTS leilao_fator numeric(4,2);

COMMENT ON COLUMN sessoes.token IS
  'Segredo do QR da telinha. Quem tem o token acompanha a sessao sem login.';
COMMENT ON COLUMN sessoes.leilao_fator IS
  'Multiplicador de cashback aceito no leilao de potencia. Nulo = nao houve leilao.';
