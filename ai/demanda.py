"""Gerenciamento da demanda de potencia.

O `charge_curve.py` responde quanto UMA sessao puxa. Este responde a pergunta
seguinte, que e a que decide se a loja leva multa: quanto TODAS puxam juntas, e
quanto ainda cabe.

Sao duas escassezes ao mesmo tempo e uma abundancia.

    a rede       a loja contrata uma demanda em kW. Passar disso nao e so
                 conta mais alta -- e multa de ultrapassagem, e ela come o
                 ganho da vaga inteira. O carregador divide o medidor com a
                 geladeira e o ar-condicionado, entao o teto que sobra para
                 ele e o contratado MENOS o que a loja ja consome sozinha.

    a hora       no horario de ponta a energia custa varias vezes mais. Uma
                 recarga que podia esperar uma hora e dinheiro jogado fora --
                 do lojista, que paga a tarifa, e do motorista, que paga o kWh.

    o sol        onde ha geracao, cada kW que vem do painel e um kW que NAO
                 vem da rede. Ele nao entra na conta da demanda contratada, o
                 que na pratica levanta o teto enquanto o sol esta no ceu.

E uma peca que trabalha nas tres: a bateria. Ela guarda o excedente do meio-dia
e devolve na ponta, que e exatamente quando o teto aperta e a tarifa pesa.

Tudo aqui e funcao pura: entra numero, sai numero. Nao ha banco, nao ha rede e
nao ha relogio implicito -- o momento sempre vem por parametro. E o que permite
simular um dia inteiro em milissegundos e testar o pior caso sem esperar por
ele.

    python ai/demanda.py     # roda a demonstracao de um dia
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from datetime import datetime, timedelta

# ==========================================================================
# Tarifa: quando a energia custa caro
# ==========================================================================

# A ponta sao tres horas consecutivas em dias uteis, definidas pela
# distribuidora -- normalmente na faixa das 17h as 22h. Feriado nao e ponta, e
# fim de semana tambem nao. Quem tem os horarios exatos e a fatura da loja, por
# isso eles sao campo do estabelecimento e nao constante daqui.
PONTA_INICIO_PADRAO = 18
PONTA_FIM_PADRAO = 21


@dataclass(frozen=True)
class Tarifa:
    """O preco da energia ao longo do dia.

    `grupo` muda o que a ultrapassagem custa, nao o que este modulo calcula:
    no Grupo A a demanda e faturada e ultrapassar gera penalidade; no Grupo B
    nao ha demanda contratada, e o teto vale como limite do disjuntor. Guardar
    o grupo deixa a tela dizer a verdade para cada caso.
    """

    fora_ponta_kwh: float
    ponta_kwh: float
    ponta_inicio: int = PONTA_INICIO_PADRAO
    ponta_fim: int = PONTA_FIM_PADRAO
    grupo: str = "B"

    def em_ponta(self, momento: datetime) -> bool:
        if momento.weekday() >= 5:      # sabado e domingo nao tem ponta
            return False
        return self.ponta_inicio <= momento.hour < self.ponta_fim

    def preco_kwh(self, momento: datetime) -> float:
        return self.ponta_kwh if self.em_ponta(momento) else self.fora_ponta_kwh

    def horas_ate_fora_de_ponta(self, momento: datetime) -> float:
        """Quanto falta para a energia baratear. Zero se ja esta barata."""
        if not self.em_ponta(momento):
            return 0.0
        fim = momento.replace(hour=self.ponta_fim, minute=0, second=0, microsecond=0)
        return max(0.0, (fim - momento).total_seconds() / 3600.0)


# ==========================================================================
# Sol: quanto o telhado entrega
# ==========================================================================

def elevacao_solar_graus(momento: datetime, latitude: float) -> float:
    """Altura do sol no ceu, em graus. Negativo = de noite.

    Formulas classicas de posicao solar: declinacao pela equacao de Cooper e
    angulo horario a partir da hora local.

    APROXIMACAO ASSUMIDA: usamos a hora do relogio como hora solar. A correcao
    de longitude e a equacao do tempo somadas erram no maximo uns 15 minutos no
    horario do pico -- irrelevante para dimensionar carga, e seria peso morto
    numa conta que roda a cada requisicao. Se algum dia isso virar previsao de
    geracao para venda, e a primeira coisa a corrigir.
    """
    dia = momento.timetuple().tm_yday
    declinacao = 23.45 * math.sin(math.radians(360.0 * (284 + dia) / 365.0))
    hora = momento.hour + momento.minute / 60.0
    angulo_horario = 15.0 * (hora - 12.0)

    lat = math.radians(latitude)
    dec = math.radians(declinacao)
    ah = math.radians(angulo_horario)

    seno = math.sin(lat) * math.sin(dec) + math.cos(lat) * math.cos(dec) * math.cos(ah)
    return math.degrees(math.asin(max(-1.0, min(1.0, seno))))


def solar_kw(kwp: float, momento: datetime, latitude: float = -23.55,
             rendimento: float = 0.80) -> float:
    """Geracao instantanea de um sistema de `kwp` em ceu limpo.

    `rendimento` junta num numero so o que separa a placa do inversor: perda
    do inversor, temperatura, sujeira e cabo. 0,80 e o valor de projeto usado
    no mercado; a loja pode ajustar depois de um mes de dados reais.

    Ceu limpo, e isso e uma ESCOLHA, nao um esquecimento. Sem previsao do tempo
    ligada, superestimar a geracao seria perigoso -- o sistema liberaria carga
    contando com um sol que nao veio e estouraria a demanda. Por isso a folga
    (`folga_kw`) desconta a geracao com um fator de confianca.
    """
    if kwp <= 0:
        return 0.0
    elevacao = elevacao_solar_graus(momento, latitude)
    if elevacao <= 0:
        return 0.0
    return kwp * math.sin(math.radians(elevacao)) * rendimento


# ==========================================================================
# Bateria: guarda o excedente, devolve na hora cara
# ==========================================================================

@dataclass(frozen=True)
class Bateria:
    """Armazenamento da loja. `soc` e o estado de carga, de 0 a 1."""

    capacidade_kwh: float
    potencia_kw: float
    soc: float = 0.5
    rendimento: float = 0.90
    soc_minimo: float = 0.10        # nunca descarrega abaixo disto

    def descarga_disponivel_kw(self, horas: float = 0.25) -> float:
        """Quanto ela aguenta entregar pelas proximas `horas`.

        Nao basta olhar a potencia do inversor: uma bateria quase vazia aguenta
        20 kW por tres minutos e nada depois. Quem manda e o menor entre a
        potencia e a energia que ainda da para tirar.
        """
        if self.capacidade_kwh <= 0 or horas <= 0:
            return 0.0
        util_kwh = max(0.0, (self.soc - self.soc_minimo) * self.capacidade_kwh)
        return min(self.potencia_kw, util_kwh * self.rendimento / horas)

    def carga_disponivel_kw(self, horas: float = 0.25) -> float:
        """Quanto ela ainda aceita receber pelas proximas `horas`."""
        if self.capacidade_kwh <= 0 or horas <= 0:
            return 0.0
        falta_kwh = max(0.0, (1.0 - self.soc) * self.capacidade_kwh)
        return min(self.potencia_kw, falta_kwh / self.rendimento / horas)


# ==========================================================================
# O local: tudo que decide o teto
# ==========================================================================

@dataclass(frozen=True)
class Local:
    """A loja, do ponto de vista eletrico."""

    demanda_contratada_kw: float
    carga_base_kw: float = 0.0
    tarifa: Tarifa | None = None
    solar_kwp: float = 0.0
    bateria: Bateria | None = None
    latitude: float = -23.55
    # Margem de seguranca sobre a demanda contratada. A medicao da
    # distribuidora e por intervalos de 15 minutos: um pico curto no fim do
    # intervalo ainda entra na media. Deixar 5% de folga custa pouco e evita
    # descobrir o problema na fatura.
    margem_seguranca: float = 0.05
    # Quanto da geracao prevista o sistema se permite contar como teto. Ceu
    # limpo e otimista; uma nuvem tira a geracao em segundos e a carga ja
    # liberada nao volta atras.
    confianca_solar: float = 0.70


# ==========================================================================
# A conta central: quanto ainda cabe
# ==========================================================================

@dataclass(frozen=True)
class Folga:
    """O resultado da conta, com as parcelas a vista.

    Devolver as parcelas e nao so o total e de proposito: a tela do lojista
    precisa dizer POR QUE sobrou pouco, e "a loja esta consumindo 40 kW" e uma
    resposta diferente de "o sol se pos".
    """

    teto_kw: float               # quanto a instalacao aguenta agora
    base_kw: float               # o que a loja consome sozinha
    carregando_kw: float         # o que as sessoes ativas ja puxam
    solar_kw: float              # o que o telhado esta entregando
    bateria_kw: float            # o que a bateria pode somar agora
    disponivel_kw: float         # o que sobra para carregar mais
    em_ponta: bool

    @property
    def ocupacao(self) -> float:
        """Fracao do teto ja usada, de 0 a 1. E o numero do velocimetro."""
        if self.teto_kw <= 0:
            return 1.0
        return min(1.0, (self.base_kw + self.carregando_kw) / self.teto_kw)


def folga_kw(local: Local, momento: datetime, carregando_kw: float = 0.0,
             horizonte_h: float = 0.25) -> Folga:
    """Quantos kW ainda cabem sem estourar a demanda contratada.

        teto   = contratada - margem + solar confiavel + bateria
        sobra  = teto - carga da loja - o que ja esta carregando

    O sol e a bateria entram SOMANDO no teto porque nenhum dos dois passa pelo
    medidor da distribuidora: o kW que vem do telhado e um kW que a rede nao
    precisa entregar.
    """
    contratada = max(0.0, local.demanda_contratada_kw)
    teto_rede = contratada * (1.0 - local.margem_seguranca)

    sol = solar_kw(local.solar_kwp, momento, local.latitude) * local.confianca_solar

    # A bateria so entra no teto quando vale a pena gastar ciclo: na ponta, ou
    # quando a loja ja esta perto do limite. Descarregar de madrugada para
    # carregar um carro e desperdicar vida util de um equipamento caro.
    bat = 0.0
    if local.bateria is not None:
        aperto = (local.carga_base_kw + carregando_kw) > teto_rede * 0.85
        if (local.tarifa is not None and local.tarifa.em_ponta(momento)) or aperto:
            bat = local.bateria.descarga_disponivel_kw(horizonte_h)

    teto = teto_rede + sol + bat
    disponivel = max(0.0, teto - local.carga_base_kw - carregando_kw)

    return Folga(
        teto_kw=teto,
        base_kw=local.carga_base_kw,
        carregando_kw=carregando_kw,
        solar_kw=sol,
        bateria_kw=bat,
        disponivel_kw=disponivel,
        em_ponta=local.tarifa.em_ponta(momento) if local.tarifa else False,
    )


# ==========================================================================
# Repartir: quando nao cabe para todos
# ==========================================================================

def repartir(pedidos_kw: list[float], disponivel_kw: float) -> list[float]:
    """Divide a potencia disponivel entre as sessoes ativas.

    Nao e divisao proporcional, e nao e por ordem de chegada. E preenchimento
    por nivel: sobe-se uma cota igual para todos ate o orcamento acabar, e
    quem pede menos que a cota leva so o que pediu -- a sobra volta para o
    bolo e e redividida entre os que ainda querem mais.

    Isso importa por causa da fisica que o charge_curve.py ja modela. Um carro
    a 85% esta no regime de tensao constante e nao ACEITA potencia alta; dar
    30 kW a ele seria jogar fora. Um carro a 30% aceita tudo. A divisao por
    nivel manda a sobra de quem esta enchendo para quem esta comecando, sem
    precisar de regra especial nenhuma -- ela cai fora sozinha da conta.

    Devolve na mesma ordem que entrou.
    """
    n = len(pedidos_kw)
    if n == 0:
        return []
    if disponivel_kw <= 0:
        return [0.0] * n
    if sum(pedidos_kw) <= disponivel_kw:
        return list(pedidos_kw)

    restante = disponivel_kw
    concedido = [0.0] * n
    pendentes = list(range(n))

    while pendentes and restante > 1e-9:
        cota = restante / len(pendentes)
        # Quem cabe na cota e servido por inteiro; os outros ficam para a
        # proxima rodada, ja com a sobra redistribuida.
        contentes = [i for i in pendentes if pedidos_kw[i] <= cota]
        if not contentes:
            for i in pendentes:
                concedido[i] = cota
            break
        for i in contentes:
            concedido[i] = pedidos_kw[i]
            restante -= pedidos_kw[i]
        pendentes = [i for i in pendentes if i not in set(contentes)]

    return concedido


# ==========================================================================
# O incentivo: mover a demanda em vez de cortar
# ==========================================================================

# Cortar potencia funciona e e antipatico. Mexer no cashback funciona e a
# pessoa gosta: ela escolhe sozinha a hora barata, e a loja paga menos pela
# energia que devolve como credito. E o mesmo mecanismo de fidelidade que ja
# existe, usado como instrumento de demanda.
# Quantas horas a bateria enxerga a frente ao decidir se carrega. Curto
# demais e ela acorda dentro da ponta, quando carregar da rede ja nao vale;
# longo demais e ela vive cheia, gastando ciclo por demanda que talvez nem
# venha. Seis horas cobrem a distancia entre o sol da tarde e a ponta.
HORIZONTE_BATERIA_H = 6.0

def ha_disputa(pedidos_kw: list[float], disponivel_kw: float) -> bool:
    """Se todos levarem o que pediram, estoura? Entao ha o que leiloar.

    Sem disputa o leilao nao deve nem aparecer: perguntar "aceita menos?" a
    quem poderia levar tudo e pedir desconto sem motivo, e a pessoa aprende a
    ignorar a pergunta -- inclusive no dia em que ela importa.
    """
    return sum(pedidos_kw) > disponivel_kw + 1e-9


@dataclass(frozen=True)
class Oferta:
    """Uma linha do leilao, ja traduzida para o que a pessoa ve na telinha."""

    rotulo: str
    potencia_pct: float          # quanto da potencia da vaga ela aceita
    potencia_kw: float           # o que isso da em kW, aqui e agora
    cashback_fator: float        # multiplicador final, hora + paciencia
    minutos_a_mais: float        # o preco da escolha, em tempo


def ofertas_de_leilao(nominal_kw: float, disponivel_kw: float, fator_hora: float,
                      opcoes: list[tuple[float, float]], teto_fator: float = 2.0,
                      energia_kwh: float = 20.0) -> list[Oferta]:
    """Traduz a configuracao da loja no que a telinha mostra.

    `opcoes` sao os pares (percentual da potencia, multiplicador) que o lojista
    definiu no painel. A primeira linha da lista de volta e sempre a potencia
    cheia, sem premio: a escolha de nao participar precisa estar na tela com o
    mesmo peso das outras, senao vira pegadinha.

    `minutos_a_mais` e o que torna a escolha honesta. Dizer "aceite 40% e ganhe
    o dobro de cashback" sem dizer que isso custa quarenta minutos e vender
    sem mostrar o preco. A conta e simples de proposito -- energia dividida por
    potencia --, e nao a curva de recarga: a curva depende do estado da bateria
    do carro, que a telinha so sabe depois de plugar, e a oferta precisa
    aparecer antes.
    """
    cheia_kw = min(nominal_kw, disponivel_kw) if disponivel_kw > 0 else 0.0
    horas = lambda kw: (energia_kwh / kw) if kw > 0 else 0.0
    base_h = horas(cheia_kw)

    ofertas = [Oferta("Potência cheia", 100.0, round(cheia_kw, 2),
                      round(fator_hora, 2), 0.0)]
    for pct, bonus in opcoes:
        if not pct or not bonus:
            continue
        kw = min(nominal_kw * pct / 100.0, max(0.0, disponivel_kw))
        if kw <= 0:
            continue
        fator = min(fator_hora * bonus, teto_fator)
        ofertas.append(Oferta(
            rotulo=f"{int(pct)}% da potência",
            potencia_pct=float(pct),
            potencia_kw=round(kw, 2),
            cashback_fator=round(fator, 2),
            minutos_a_mais=round(max(0.0, horas(kw) - base_h) * 60.0),
        ))
    return ofertas


FATOR_PONTA = 0.5          # na ponta o credito cai pela metade
FATOR_SOL = 1.5            # com sol sobrando, uma vez e meia
FATOR_NORMAL = 1.0


def fator_cashback(local: Local, momento: datetime, carregando_kw: float = 0.0) -> float:
    """Multiplicador do cashback naquele instante.

    A ordem importa: ponta vence sol. Se por acaso houver geracao dentro da
    janela de ponta -- num verao com ponta as 17h, acontece --, a tarifa cara
    continua mandando, porque a loja ainda esta comprando demanda cara da rede
    para o que o sol nao cobre.
    """
    if local.tarifa is not None and local.tarifa.em_ponta(momento):
        return FATOR_PONTA
    sol = solar_kw(local.solar_kwp, momento, local.latitude)
    if sol > 0 and sol > (local.carga_base_kw + carregando_kw):
        return FATOR_SOL
    return FATOR_NORMAL


def melhor_janela(local: Local, momento: datetime, horas_a_frente: int = 12) -> dict:
    """A proxima hora cheia em que carregar sai mais barato.

    Serve a tela de reserva: em vez de so recusar a ponta, ela sugere. "As 21h
    voce paga 40% menos" move mais gente que "indisponivel".
    """
    if local.tarifa is None:
        return {"melhor_em": None, "economia_pct": 0.0}

    agora_preco = local.tarifa.preco_kwh(momento)
    melhor, melhor_preco = None, agora_preco
    for h in range(1, horas_a_frente + 1):
        quando = (momento + timedelta(hours=h)).replace(minute=0, second=0, microsecond=0)
        preco = local.tarifa.preco_kwh(quando)
        if preco < melhor_preco - 1e-9:
            melhor, melhor_preco = quando, preco

    if melhor is None:
        return {"melhor_em": None, "economia_pct": 0.0}
    return {"melhor_em": melhor,
            "economia_pct": 100.0 * (agora_preco - melhor_preco) / agora_preco}


def melhor_hora_de_carregar(local: Local, momento: datetime,
                            horas_a_frente: int = 12) -> dict:
    """Os dois motivos para esperar: pagar menos, ou receber mais.

    `melhor_janela` responde so o primeiro, e por isso fica muda o dia inteiro
    fora da ponta -- se ja estamos na hora barata, nao ha preco melhor a
    sugerir. Mas existe um segundo motivo, que a loja ja usa e o motorista nao
    ve: o multiplicador do cashback, que sobe quando sobra sol.

    Entao a resposta tem duas parcelas, e nao uma media entre elas. Somar
    preco e credito num numero so exigiria saber o cashback_pct da VAGA, que
    nao esta neste nivel -- e o resultado seria um indice que ninguem sabe
    ler. Duas parcelas nomeadas a tela sabe explicar: "as 21h voce paga 40%
    menos" e "as 11h o credito vale uma vez e meia".

    O fator futuro e calculado so com a carga base da loja, porque nao ha como
    saber quantos carros estarao ligados daqui a tres horas. E a mesma
    aproximacao que `plano_do_dia` faz para desenhar a curva.
    """
    if local.tarifa is None:
        return {"mais_barato": None, "mais_cashback": None}

    preco_agora = local.tarifa.preco_kwh(momento)
    fator_agora = fator_cashback(local, momento)

    barato_em, barato_preco = None, preco_agora
    credito_em, credito_fator = None, fator_agora

    for h in range(1, horas_a_frente + 1):
        quando = (momento + timedelta(hours=h)).replace(minute=0, second=0, microsecond=0)
        preco = local.tarifa.preco_kwh(quando)
        if preco < barato_preco - 1e-9:
            barato_em, barato_preco = quando, preco
        fator = fator_cashback(local, quando)
        if fator > credito_fator + 1e-9:
            credito_em, credito_fator = quando, fator

    return {
        "agora": {"preco_kwh_brl": preco_agora, "cashback_fator": fator_agora,
                  "em_ponta": local.tarifa.em_ponta(momento)},
        "mais_barato": None if barato_em is None else {
            "quando": barato_em,
            "economia_pct": 100.0 * (preco_agora - barato_preco) / preco_agora,
        },
        "mais_cashback": None if credito_em is None else {
            "quando": credito_em,
            "fator": credito_fator,
            "vezes_mais": credito_fator / fator_agora if fator_agora > 0 else 0.0,
        },
    }


# ==========================================================================
# O dia inteiro: o grafico do painel
# ==========================================================================

def metas_de_bateria(local: Local, dia: datetime,
                     carga_carregadores_kw: dict[int, float] | None = None,
                     passo_min: int = 60) -> list[float]:
    """Que estado de carga a bateria precisa ter em cada passo do dia.

    A regra antiga era gulosa e so olhava para tras: carregava sempre que
    sobrava sol, descarregava sempre que entrava na ponta. Funciona num dia
    comum e falha justamente no dia que importa -- aquele em que tres reservas
    caem as 18h30. O sol ja se pos, a bateria gastou o excedente do meio-dia
    numa ponta qualquer, e chega vazia na hora em que era para ela servir.

    Esta funcao olha para frente. As reservas ja dizem o que vem: uma reserva
    e uma sessao que a loja sabe que vai acontecer, com hora marcada. Entao da
    para calcular quanta energia a bateria vai precisar entregar mais tarde, e
    exigir que ela chegue naquela hora com essa energia dentro.

    Devolve uma meta de SoC por passo. O simulador segue a meta; quem nao tem
    bateria recebe uma lista de zeros e nada muda.
    """
    carga_carregadores_kw = carga_carregadores_kw or {}
    passos = int(24 * 60 / passo_min)
    horas_passo = passo_min / 60.0
    if local.bateria is None or local.bateria.capacidade_kwh <= 0:
        return [0.0] * passos

    inicio = dia.replace(hour=0, minute=0, second=0, microsecond=0)
    teto_rede = local.demanda_contratada_kw * (1.0 - local.margem_seguranca)

    # Quanto a bateria precisa entregar em cada passo para a rede nao estourar
    # o teto. So o que passa do teto conta: cobrir consumo que ja cabe na rede
    # seria gastar ciclo de bateria de graca.
    falta_kwh = []
    for i in range(passos):
        t = inicio + timedelta(minutes=i * passo_min)
        sol = solar_kw(local.solar_kwp, t, local.latitude)
        consumo = local.carga_base_kw + float(carga_carregadores_kw.get(t.hour, 0.0))
        excesso_kw = max(0.0, (consumo - sol) - teto_rede)
        falta_kwh.append(excesso_kw * horas_passo)

    # A meta de cada passo e o que vai faltar nas proximas HORIZONTE horas.
    #
    # O horizonte e o detalhe que faz a coisa funcionar, e a primeira versao
    # nao tinha: sem ele a meta so aparecia no passo da propria reserva -- que
    # nas 18h ja e horario de ponta, quando carregar da rede esta proibido. A
    # bateria "acordava" tarde demais e chegava na reserva com MENOS carga do
    # que comecou o dia. Seis horas dao tempo de carregar no sol da tarde ou na
    # rede barata antes de a ponta fechar a porta.
    cap = local.bateria.capacidade_kwh
    piso = local.bateria.soc_minimo
    rend = local.bateria.rendimento or 1.0
    passos_horizonte = max(1, int(HORIZONTE_BATERIA_H / horas_passo))

    metas = [0.0] * passos
    for i in range(passos):
        janela = falta_kwh[i:i + passos_horizonte]
        # A energia sai da bateria com perda: para entregar 10 kWh e preciso
        # ter mais que 10 kWh guardados.
        guardado = sum(janela) / rend
        metas[i] = min(1.0, piso + guardado / cap) if cap > 0 else 0.0
    return metas


def plano_do_dia(local: Local, dia: datetime, carga_carregadores_kw: dict[int, float] | None = None,
                 passo_min: int = 60) -> list[dict]:
    """A curva de 24 horas que o painel desenha.

    `carga_carregadores_kw` mapeia hora -> kW medidos ou previstos nos
    carregadores. Vem de duas fontes, e as duas ja existem no sistema: as
    LEITURAS para as horas que ja passaram, e as RESERVAS para as que vem.
    Uma reserva e uma sessao que a loja ja sabe que vai acontecer.
    """
    carga_carregadores_kw = carga_carregadores_kw or {}
    inicio = dia.replace(hour=0, minute=0, second=0, microsecond=0)
    passos = int(24 * 60 / passo_min)
    horas_passo = passo_min / 60.0
    teto_rede = local.demanda_contratada_kw * (1.0 - local.margem_seguranca)
    metas = metas_de_bateria(local, dia, carga_carregadores_kw, passo_min)

    bateria_soc = local.bateria.soc if local.bateria else 0.0
    linhas = []

    for i in range(passos):
        t = inicio + timedelta(minutes=i * passo_min)
        sol = solar_kw(local.solar_kwp, t, local.latitude)
        carregadores = float(carga_carregadores_kw.get(t.hour, 0.0))
        consumo = local.carga_base_kw + carregadores

        # A bateria segue a META do passo (ver `metas_de_bateria`), e nao mais
        # o impulso do momento. Tres casos, nesta ordem:
        #
        #   1. sobra sol            -> guarda, sempre. Energia de graca.
        #   2. abaixo da meta       -> carrega da REDE, mesmo sem sol, porque
        #                              ha demanda marcada mais tarde. So fora
        #                              da ponta, e so dentro do teto: criar um
        #                              pico agora para evitar outro depois nao
        #                              resolve nada.
        #   3. na ponta, com carga  -> entrega.
        bat_kw = 0.0
        if local.bateria is not None and local.bateria.capacidade_kwh > 0:
            b = Bateria(local.bateria.capacidade_kwh, local.bateria.potencia_kw,
                        bateria_soc, local.bateria.rendimento, local.bateria.soc_minimo)
            meta = metas[i] if i < len(metas) else 0.0
            em_ponta = local.tarifa is not None and local.tarifa.em_ponta(t)
            sobra_sol = sol - consumo

            if sobra_sol > 0:
                bat_kw = -min(sobra_sol, b.carga_disponivel_kw(horas_passo))
            elif bateria_soc < meta - 1e-9 and not em_ponta:
                # Espaco que ainda cabe na rede sem encostar no teto.
                folga_rede = max(0.0, teto_rede - (consumo - sol))
                bat_kw = -min(folga_rede, b.carga_disponivel_kw(horas_passo))
            elif em_ponta:
                bat_kw = min(consumo - sol, b.descarga_disponivel_kw(horas_passo))

            delta_kwh = -bat_kw * horas_passo
            bateria_soc = max(0.0, min(1.0, bateria_soc + delta_kwh / b.capacidade_kwh))

        rede = max(0.0, consumo - sol - bat_kw)
        linhas.append({
            "hora": t.hour,
            "base_kw": round(local.carga_base_kw, 2),
            "carregadores_kw": round(carregadores, 2),
            "solar_kw": round(sol, 2),
            "bateria_kw": round(bat_kw, 2),
            "rede_kw": round(rede, 2),
            "bateria_soc": round(bateria_soc, 3),
            # A meta e o que a tela usa para mostrar que a bateria estava se
            # PREPARANDO, e nao so reagindo. Sem ela, um degrau de carga as 15h
            # parece capricho do algoritmo.
            "bateria_meta_soc": round(metas[i] if i < len(metas) else 0.0, 3),
            "em_ponta": local.tarifa.em_ponta(t) if local.tarifa else False,
            "ultrapassou": rede > local.demanda_contratada_kw,
        })

    return linhas


# ==========================================================================
# Demonstracao
# ==========================================================================

def main() -> None:
    tarifa = Tarifa(fora_ponta_kwh=0.7890, ponta_kwh=2.1500, ponta_inicio=18, ponta_fim=21)
    loja = Local(
        demanda_contratada_kw=75.0,
        carga_base_kw=28.0,
        tarifa=tarifa,
        solar_kwp=40.0,
        bateria=Bateria(capacidade_kwh=30.0, potencia_kw=15.0, soc=0.5),
    )

    print("Supermercado: 75 kW contratados, 28 kW de carga base,")
    print("40 kWp de solar e bateria de 30 kWh / 15 kW.\n")

    print("  hora   sol    bateria   rede   sobra p/ carregar")
    dia = datetime(2026, 9, 17)
    for h in (3, 9, 12, 15, 18, 19, 22):
        t = dia.replace(hour=h)
        f = folga_kw(loja, t, carregando_kw=0.0)
        marca = " (ponta)" if f.em_ponta else ""
        print(f"  {h:02d}h  {f.solar_kw:5.1f}   {f.bateria_kw:5.1f}   "
              f"{f.base_kw:5.1f}   {f.disponivel_kw:6.1f} kW{marca}")

    print("\nRepartindo 22 kW entre tres carros que pedem 11, 11 e 3:")
    print(" ", [round(x, 1) for x in repartir([11.0, 11.0, 3.0], 22.0)])
    print("Os mesmos tres, com so 12 kW disponiveis:")
    print(" ", [round(x, 1) for x in repartir([11.0, 11.0, 3.0], 12.0)])
    print("  (o carro que so aceita 3 leva 3; os outros dividem o resto)")

    print("\nCashback ao longo do dia:")
    for h in (7, 12, 19, 23):
        t = dia.replace(hour=h)
        print(f"  {h:02d}h  x{fator_cashback(loja, t):.1f}")

    print("\nMelhor hora para carregar, se agora sao 19h:")
    m = melhor_janela(loja, dia.replace(hour=19))
    if m["melhor_em"]:
        print(f"  {m['melhor_em']:%H:%M}, {m['economia_pct']:.0f}% mais barato")


if __name__ == "__main__":
    main()
