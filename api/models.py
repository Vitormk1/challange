"""O contrato de dados. Tudo no sistema fala nestes documentos.

Modelagem pensada para o plano gratuito do MongoDB Atlas — 512 MB. A regra e
simples e esta implementada em `db.py`:

    sessoes e vendas    ficam para sempre   (poucos documentos, sao o produto)
    telemetria bruta    expira em 30 dias   (indice TTL do proprio Mongo)
    agregados diarios   ficam para sempre   (uma linha por ponto por dia)
"""

from __future__ import annotations

from dataclasses import asdict, dataclass, field
from datetime import datetime
from typing import Literal

BillingMode = Literal["cortesia", "pago"]


@dataclass
class Store:
    """A loja. Uma instalacao, varios pontos de recarga."""

    store_id: str
    name: str
    segment: str                       # supermercado, restaurante, farmacia...
    tariff_group: Literal["A", "B"] = "B"
    contracted_demand_kw: float | None = None   # so faz sentido no Grupo A
    grid_limit_kw: float = 75.0
    timezone: str = "America/Sao_Paulo"


@dataclass
class ChargePoint:
    """Um ponto de recarga e a regra comercial que vale nele.

    A regra fica no ponto, nao na loja: a mesma loja pode ter uma vaga de
    cortesia na frente e uma vaga paga no estacionamento.
    """

    point_id: str
    store_id: str
    label: str                         # "Vaga 1", "Entrada norte"
    max_kw: float
    connector: str = "Tipo 2"
    billing_mode: BillingMode = "cortesia"

    # Modo cortesia
    free_kwh_limit: float | None = None      # gratis ate X kWh
    free_minutes_limit: int | None = None    # ou ate Y minutos
    min_purchase_brl: float | None = None    # mediante compra minima no PDV

    # Modo pago
    price_brl_kwh: float | None = None

    # Vale para os dois: evita que a vaga vire estacionamento
    idle_grace_minutes: int = 15
    idle_fee_brl_minute: float = 0.0


@dataclass
class Session:
    """Uma sessao de recarga, do plugue ao desplugue."""

    session_id: str
    point_id: str
    store_id: str
    started_at: datetime
    ended_at: datetime | None = None

    soc_start: float | None = None
    soc_end: float | None = None
    energy_kwh: float = 0.0
    peak_kw: float = 0.0

    # Identificacao do cliente, quando houver (RFID, app, placa informada)
    customer_ref: str | None = None

    # O que foi prometido e o que aconteceu — e o que alimenta o erro do modelo
    predicted_full_at: datetime | None = None
    predicted_cost_brl: float | None = None
    actual_cost_brl: float = 0.0

    billing_mode: BillingMode = "cortesia"
    idle_minutes: int = 0
    status: Literal["ativa", "concluida", "interrompida"] = "ativa"


@dataclass
class Sale:
    """Uma venda no PDV da loja.

    `customer_ref` e o que permite cruzar com a sessao — e o unico jeito de
    responder a pergunta que decide a compra do produto: o carregador trouxe
    faturamento?
    """

    sale_id: str
    store_id: str
    at: datetime
    total_brl: float
    customer_ref: str | None = None
    linked_session_id: str | None = None


@dataclass
class Telemetry:
    """Leitura instantanea de um ponto. Expira em 30 dias."""

    point_id: str
    at: datetime
    power_kw: float
    soc: float | None = None
    session_id: str | None = None


@dataclass
class DailyRollup:
    """Agregado de um ponto num dia. Nunca expira — alimenta o historico."""

    point_id: str
    store_id: str
    day: str                            # "2026-08-21"
    sessions: int = 0
    energy_kwh: float = 0.0
    peak_kw: float = 0.0
    revenue_brl: float = 0.0
    energy_cost_brl: float = 0.0
    linked_sales_brl: float = 0.0
    unique_customers: int = 0
    occupancy_by_hour: list[float] = field(default_factory=lambda: [0.0] * 24)


def to_doc(obj) -> dict:
    """Converte qualquer dataclass acima em documento do Mongo."""
    return {k: v for k, v in asdict(obj).items() if v is not None}
