"""A cortesia se paga? Ponto de equilibrio por segmento.

A pergunta que decide o modelo de negocio inteiro: o lucro que a loja tira da
compra cobre a energia que ela deu de graca?

Nao adianta o cliente gastar R$ 60 se o supermercado so fica com 2,9% disso.

Premissas, todas com fonte:
    tarifa      R$ 0,789/kWh — Enel SP, Resolucao Homologatoria ANEEL 3.596/2026.
                A ANEEL homologa a mesma tarifa para todo o grupo B convencional,
                entao B3 comercial usa a mesma base da B1 residencial. O custo
                efetivo varia com ICMS e regime tributario de cada loja.
    potencia    6,6 kW no carregador de bordo do carro, 92% de eficiencia — o
                gargalo e o carro, nao o ponto da loja
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
    return energia_kwh(minutos) * TARIFA_KWH


def minutos_no_limite(margem: float, ticket: float) -> float:
    """Ate quantos minutos de cortesia o lucro daquela compra aguenta."""
    lucro = margem * ticket
    kwh = lucro / TARIFA_KWH
    return kwh / (ONBOARD_KW * EFICIENCIA) * 60


def ticket_no_limite(margem: float, minutos: float) -> float:
    """Quanto o cliente precisa gastar para a cortesia daquele tempo se pagar."""
    return custo(minutos) / margem


def main() -> None:
    print(f"tarifa R$ {TARIFA_KWH}/kWh · carro aceita {ONBOARD_KW} kW · "
          f"eficiencia {EFICIENCIA:.0%}\n")
    print(f"{'segmento':<22}{'margem':>7}{'ticket':>9}{'perm.':>7}"
          f"{'lucro':>9}{'energia':>9}{'saldo':>9}   veredito")
    print("-" * 92)

    for nome, margem, ticket, minutos in SEGMENTOS:
        lucro = margem * ticket
        gasto = custo(minutos)
        saldo = lucro - gasto
        veredito = "paga" if saldo > 0 else "NAO PAGA"
        print(f"{nome:<22}{100*margem:>6.1f}%{ticket:>9.2f}{minutos:>6}m"
              f"{lucro:>9.2f}{gasto:>9.2f}{saldo:>9.2f}   {veredito}")

    print("\n" + "=" * 92)
    print("ATE QUANDO A CORTESIA SE PAGA, POR SEGMENTO")
    print("=" * 92)
    print(f"{'segmento':<22}{'minutos que cabem':>20}{'ticket necessario para 45 min':>32}")
    print("-" * 92)
    for nome, margem, ticket, minutos in SEGMENTOS:
        cabe = minutos_no_limite(margem, ticket)
        precisa = ticket_no_limite(margem, 45)
        print(f"{nome:<22}{cabe:>17.0f} min{precisa:>29.2f}")

    print("\nNao entram nesta conta, e precisam entrar antes de qualquer proposta:")
    print("  - amortizacao do carregador e da instalacao eletrica")
    print("  - manutencao e eventual furto de cabo")
    print("  - impacto na demanda contratada, se a loja for do Grupo A")
    print("  - o custo de oportunidade da vaga")
    print("\nE do outro lado, tambem nao entram:")
    print("  - o cliente que so veio por causa do carregador (venda 100% nova)")
    print("  - quem volta mais vezes por causa dele")
    print("  - o valor de marca de ser a loja que tem o ponto de recarga")


if __name__ == "__main__":
    main()
