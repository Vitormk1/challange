"""Ate que percentual de cashback se paga, por segmento.

A pergunta que decide o modelo de negocio inteiro: quanto do valor da recarga
a loja pode devolver como credito antes de o programa comer o proprio retorno?

Nao adianta o cliente gastar R$ 60 se o supermercado so fica com 2,9% disso.

O modelo anterior era cortesia -- energia de graca ate um teto, absorvida pela
loja como marketing. Saiu por dois motivos: dependia de o lojista renovar um
orcamento de marketing todo mes, e o teto que se pagava dava NEGATIVO no
supermercado. Vendendo a energia com margem, o mesmo supermercado passa a ter
folga para devolver credito -- e e isso que a tabela de baixo mostra.

Premissas, todas com fonte:
    tarifa      R$ 0,789/kWh -- Enel SP, Resolucao Homologatoria ANEEL 3.596/2026.
                A ANEEL homologa a mesma tarifa para todo o grupo B convencional,
                entao B3 comercial usa a mesma base da B1 residencial. O custo
                efetivo varia com ICMS e regime tributario de cada loja.
    venda       2x a tarifa. E o markup de partida sugerido, no meio da faixa
                que a rede publica brasileira pratica hoje. Configuravel por
                ponto no painel.
    potencia    6,6 kW no carregador de bordo do carro, 92% de eficiencia -- o
                gargalo e o carro, nao o ponto da loja
    equipamento R$ 6.000 em 5 anos a 3 sessoes/dia = R$ 1,11 por sessao
    margens     supermercado 2,9% (ABRAS, media do setor, faixa de 1,5% a 3%)
                demais segmentos: faixas correntes de mercado, a confirmar
                com o lojista antes de qualquer proposta comercial

Uso:
    python ai/break_even.py
"""

from __future__ import annotations

TARIFA_KWH = 0.789
ONBOARD_KW = 6.6
EFICIENCIA = 0.92
AMORT_SESSAO = 1.11     # equipamento: R$ 6.000 em 5 anos, 3 sessoes/dia
MARKUP = 2.0            # preco de venda da energia sobre a tarifa

# (segmento, margem liquida, ticket medio, permanencia tipica em minutos)
SEGMENTOS = [
    ("Supermercado",        0.029,  60.0,  45),
    ("Farmacia",            0.055,  45.0,  15),
    ("Restaurante",         0.080, 120.0,  90),
    ("Cafe / padaria",      0.090,  35.0,  40),
    ("Academia",            0.150, 130.0,  75),   # mensalidade, visita longa
    ("Pet shop / servicos", 0.120, 150.0,  90),
]


def energia_kwh(minutos: float) -> float:
    return ONBOARD_KW * EFICIENCIA * minutos / 60


def custo(minutos: float) -> float:
    """O que a energia custa a loja."""
    return energia_kwh(minutos) * TARIFA_KWH


def cobrado(minutos: float) -> float:
    """O que o motorista paga por aquela recarga."""
    return custo(minutos) * MARKUP


def teto_cashback(margem: float, ticket: float, minutos: float) -> tuple[float, float]:
    """Quanto de credito cabe por visita, em reais e em percentual.

    Tres coisas entram: a margem da energia vendida, o lucro da compra feita
    enquanto o carro carrega, e o equipamento diluido por sessao. O que sobra
    e o teto -- travado em 100%, porque devolver mais do que a pessoa pagou
    nao e cashback, e pagar para ela carregar.
    """
    pago = cobrado(minutos)
    sobra = (pago - custo(minutos)) + margem * ticket - AMORT_SESSAO
    pct = min(100.0, max(0.0, sobra) / pago * 100) if pago else 0.0
    return sobra, pct


def main() -> None:
    print(f"tarifa R$ {TARIFA_KWH}/kWh - venda a {MARKUP:.1f}x - "
          f"carro aceita {ONBOARD_KW} kW - eficiencia {EFICIENCIA:.0%}")
    print()
    print(f"{'segmento':<22}{'margem':>7}{'ticket':>9}{'perm.':>7}"
          f"{'lucro':>9}{'energia':>9}{'sobra':>9}   veredito")
    print("-" * 92)

    for nome, margem, ticket, minutos in SEGMENTOS:
        lucro = margem * ticket
        gasto = custo(minutos)
        sobra, _ = teto_cashback(margem, ticket, minutos)
        veredito = "paga" if sobra > 0 else "NAO PAGA"
        print(f"{nome:<22}{100*margem:>6.1f}%{ticket:>9.2f}{minutos:>6}m"
              f"{lucro:>9.2f}{gasto:>9.2f}{sobra:>9.2f}   {veredito}")

    print()
    print("=" * 92)
    print("QUANTO DE CASHBACK CABE, POR SEGMENTO")
    print("=" * 92)
    print(f"{'segmento':<22}{'recarga cobrada':>18}{'sobra por visita':>18}"
          f"{'teto de cashback':>20}")
    print("-" * 92)
    for nome, margem, ticket, minutos in SEGMENTOS:
        sobra, pct = teto_cashback(margem, ticket, minutos)
        print(f"{nome:<22}{cobrado(minutos):>17.2f}{sobra:>18.2f}{pct:>19.1f}%")

    print()
    print("Nao entram nesta conta, e precisam entrar antes de qualquer proposta:")
    print("  - instalacao eletrica (o equipamento ja entra, a R$ 1,11 por sessao)")
    print("  - manutencao e eventual furto de cabo")
    print("  - impacto na demanda contratada, se a loja for do Grupo A")
    print("  - o custo de oportunidade da vaga")
    print()
    print("E do outro lado, tambem nao entram:")
    print("  - o cliente que so veio por causa do carregador (venda 100% nova)")
    print("  - quem volta mais vezes por causa dele")
    print("  - o valor de marca de ser a loja que tem o ponto de recarga")


if __name__ == "__main__":
    main()
