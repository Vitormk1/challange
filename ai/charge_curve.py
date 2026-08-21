"""Previsao de tempo de recarga.

O jeito atual de fazer no mercado e uma regra de tres: energia dividida por
potencia. Ela erra justamente onde o motorista esta decidindo se espera ou vai
embora, porque a recarga de uma bateria de litio nao e linear.

Sao dois regimes:

    corrente constante (CC)   ate cerca de 80% de carga, a potencia e a maxima
                              que o par carro/carregador aguenta
    tensao constante (CV)     acima disso a potencia cai por protecao quimica,
                              e os ultimos 20% podem levar tanto tempo quanto
                              os primeiros 60

Este modulo comeca com um modelo fisico parametrizado — funciona sem dado
nenhum e ja e melhor que linear. Os parametros sao depois calibrados com
sessoes reais, e o erro contra o realizado fica visivel no painel.

Referencia de baseline a bater: a estimativa linear, implementada aqui do lado
para que a comparacao seja sempre feita com o mesmo codigo.
"""

from __future__ import annotations

from dataclasses import dataclass

# Passo da integracao numerica. 0.001 de SoC da erro abaixo de um segundo.
_STEP = 0.001


@dataclass(frozen=True)
class Vehicle:
    """O que precisamos saber do carro. Tudo isso o proprio carregador informa
    ou se infere das primeiras leituras da sessao."""

    battery_kwh: float
    onboard_max_kw: float          # limite do carregador interno do veiculo
    knee_soc: float | None = None  # onde a potencia cai; None = derivar da taxa C
    tail_ratio: float = 0.15       # fracao da potencia maxima ao chegar em 100%


@dataclass(frozen=True)
class Charger:
    max_kw: float
    efficiency: float = 0.92       # perdas de conversao e cabo


def _ceiling_kw(v: Vehicle, c: Charger) -> float:
    """Quem manda e o mais fraco dos dois lados."""
    return min(v.onboard_max_kw, c.max_kw) * c.efficiency


def knee_soc(v: Vehicle, c: Charger) -> float:
    """Onde a potencia comeca a cair, derivado da taxa C da sessao.

    O afunilamento forte e fenomeno de recarga rapida em corrente continua: a
    bateria esquenta e o BMS corta cedo. Num ponto de corrente alternada de
    7 kW alimentando uma bateria de 50 kWh, a taxa C e de apenas 0,14 e a
    potencia se mantem quase constante ate perto do fim.

    Tratar os dois casos com a mesma curva era o erro do modelo anterior —
    ele inflava o tempo de recarga lenta em mais de duas horas.
    """
    if v.knee_soc is not None:
        return v.knee_soc
    c_rate = _ceiling_kw(v, c) / max(1e-6, v.battery_kwh)
    return max(0.55, min(0.95, 0.95 - 0.20 * c_rate))


def available_power_kw(v: Vehicle, c: Charger, soc: float) -> float:
    """Potencia que efetivamente entra na bateria com o carro em `soc`."""
    ceiling = _ceiling_kw(v, c)
    knee = knee_soc(v, c)
    if soc <= knee:
        return ceiling
    # regime CV: cai linearmente do joelho ate `tail_ratio` da maxima em 100%
    progress = (soc - knee) / (1.0 - knee)
    return ceiling * (1.0 - (1.0 - v.tail_ratio) * progress)


def time_to_soc(v: Vehicle, c: Charger, soc_from: float, soc_to: float) -> float:
    """Horas para ir de um estado de carga a outro. Integracao numerica."""
    if soc_to <= soc_from:
        return 0.0
    soc_to = min(soc_to, 0.999)  # 100% exato nunca acontece na pratica
    hours = 0.0
    soc = soc_from
    while soc < soc_to:
        step = min(_STEP, soc_to - soc)
        power = available_power_kw(v, c, soc + step / 2)
        hours += (v.battery_kwh * step) / power
        soc += step
    return hours


def energy_to_soc(v: Vehicle, soc_from: float, soc_to: float) -> float:
    """Energia que sai da tomada — inclui as perdas."""
    return max(0.0, (soc_to - soc_from) * v.battery_kwh)


def linear_baseline_hours(v: Vehicle, c: Charger, soc_from: float, soc_to: float) -> float:
    """A regra de tres que o mercado usa hoje. Existe aqui para ser batida."""
    ceiling = min(v.onboard_max_kw, c.max_kw) * c.efficiency
    return energy_to_soc(v, soc_from, soc_to) / ceiling


def forecast(v: Vehicle, c: Charger, soc_now: float) -> dict:
    """O que o totem mostra: tempo ate 80%, tempo ate cheio, energia e erro
    do metodo ingenuo — para o painel poder exibir o ganho."""
    t80 = time_to_soc(v, c, soc_now, 0.80)
    t100 = time_to_soc(v, c, soc_now, 1.00)
    lin100 = linear_baseline_hours(v, c, soc_now, 1.00)
    return {
        "soc_now": round(soc_now, 3),
        "hours_to_80": round(t80, 3),
        "hours_to_full": round(t100, 3),
        "kwh_to_80": round(energy_to_soc(v, soc_now, 0.80), 2),
        "kwh_to_full": round(energy_to_soc(v, soc_now, 1.00), 2),
        "linear_hours_to_full": round(lin100, 3),
        "linear_error_min": round((t100 - lin100) * 60, 1),
    }


def _hhmm(hours: float) -> str:
    return f"{int(hours)}h{int(round((hours % 1) * 60)):02d}"


if __name__ == "__main__":
    # Carro comum no Brasil: bateria de 50 kWh, carregador interno de 7 kW.
    carro = Vehicle(battery_kwh=50.0, onboard_max_kw=7.0)
    ponto = Charger(max_kw=7.4)

    print("Carro de 50 kWh em um ponto de 7,4 kW\n")
    print(f"{'SoC':>5}  {'ate 80%':>9}  {'ate cheio':>10}  "
          f"{'linear diz':>11}  {'erro do linear':>15}")
    print("-" * 60)
    for soc in (0.10, 0.30, 0.50, 0.70, 0.85):
        f = forecast(carro, ponto, soc)
        print(f"{100*soc:4.0f}%  {_hhmm(f['hours_to_80']):>9}  "
              f"{_hhmm(f['hours_to_full']):>10}  "
              f"{_hhmm(f['linear_hours_to_full']):>11}  "
              f"{f['linear_error_min']:>12.0f} min")
    print("\nO erro do metodo linear cresce conforme a bateria enche —")
    print("exatamente onde o motorista decide se espera ou vai embora.")
