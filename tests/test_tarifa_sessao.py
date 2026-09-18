"""Testes do custo de energia da sessao -- o que a recarga custa A LOJA.

E o outro lado do `preco_kwh_brl`: o motorista paga o preco de venda, e a loja
paga a tarifa da distribuidora. A diferenca entre os dois e a margem da
recarga, e e ela que o painel usa para dizer ate onde o cashback se paga.

O caso que justifica o teste e a virada da ponta. Uma recarga que comeca as
17h30 e termina as 19h atravessa o momento em que a tarifa mais que dobra, e
a conta ingenua -- energia acumulada vezes a tarifa de agora -- reprecificaria
a energia da tarde pelo preco da noite.

    python -m unittest discover -s tests -v
"""

import sys
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

RAIZ = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(RAIZ))
sys.path.insert(0, str(RAIZ / "api"))

from telinha import _tarifa, energia_e_custo  # noqa: E402

BRASIL = timezone(timedelta(hours=-3))

# Sexta-feira: ponta so existe em dia util, e um teste escrito num sabado
# passaria por engano.
SEXTA = datetime(2026, 9, 18, tzinfo=BRASIL)

# Enel SP, Resolucao Homologatoria ANEEL 3.596/2026. Os mesmos numeros que as
# lojas com tarifa horaria tem em producao.
FORA, PONTA = 0.7890, 2.1500

LOJA_HORARIA = {"tarifa_kwh_brl": FORA, "tarifa_ponta_kwh_brl": PONTA,
                "ponta_inicio": 18, "ponta_fim": 21}
LOJA_SIMPLES = {"tarifa_kwh_brl": FORA, "tarifa_ponta_kwh_brl": None}


def aas(hora, minuto=0):
    return SEXTA.replace(hour=hora, minute=minuto)


class TestTarifa(unittest.TestCase):

    def test_fora_da_ponta_usa_a_tarifa_barata(self):
        t = _tarifa(LOJA_HORARIA)
        self.assertAlmostEqual(t.preco_kwh(aas(14)), FORA)
        self.assertAlmostEqual(t.preco_kwh(aas(17, 59)), FORA)

    def test_dentro_da_ponta_usa_a_tarifa_cara(self):
        t = _tarifa(LOJA_HORARIA)
        self.assertAlmostEqual(t.preco_kwh(aas(18)), PONTA)
        self.assertAlmostEqual(t.preco_kwh(aas(20, 59)), PONTA)

    def test_ponta_acaba_no_fim_da_janela(self):
        self.assertAlmostEqual(_tarifa(LOJA_HORARIA).preco_kwh(aas(21)), FORA)

    def test_fim_de_semana_nao_tem_ponta(self):
        sabado = datetime(2026, 9, 19, 19, 0, tzinfo=BRASIL)
        self.assertAlmostEqual(_tarifa(LOJA_HORARIA).preco_kwh(sabado), FORA)

    def test_loja_sem_tarifa_horaria_paga_o_mesmo_o_dia_todo(self):
        """Grupo B sem tarifa branca -- a maioria das lojas pequenas."""
        t = _tarifa(LOJA_SIMPLES)
        self.assertAlmostEqual(t.preco_kwh(aas(14)), FORA)
        self.assertAlmostEqual(t.preco_kwh(aas(19)), FORA)

    def test_colunas_ausentes_nao_quebram(self):
        """A consulta pode nao trazer as colunas da janela; cai no padrao."""
        t = _tarifa({"tarifa_kwh_brl": FORA, "tarifa_ponta_kwh_brl": PONTA})
        self.assertAlmostEqual(t.preco_kwh(aas(19)), PONTA)
        self.assertAlmostEqual(t.preco_kwh(aas(14)), FORA)


class TestEnergiaECusto(unittest.TestCase):

    def test_primeira_leitura_parte_do_zero(self):
        e, custo = energia_e_custo(0.0, 0.0, 10.0, _tarifa(LOJA_HORARIA), aas(14))
        self.assertAlmostEqual(e, 10.0)
        self.assertAlmostEqual(custo, 10.0 * FORA)

    def test_so_o_incremento_e_cobrado(self):
        """A leitura manda o acumulado, nao o pedaco. 10 -> 14 custa 4 kWh."""
        antes = 10.0 * FORA
        e, custo = energia_e_custo(10.0, antes, 14.0, _tarifa(LOJA_HORARIA), aas(15))
        self.assertAlmostEqual(e, 14.0)
        self.assertAlmostEqual(custo, antes + 4.0 * FORA)

    def test_a_virada_da_ponta_nao_reprecifica_o_passado(self):
        """O caso que motivou a funcao.

        20 kWh entregues de tarde a R$ 0,789 e mais 5 kWh na ponta a R$ 2,15.
        A conta ingenua diria 25 x 2,15 = R$ 53,75 -- quase o dobro do real,
        e a margem da recarga apareceria negativa sem nada ter acontecido.
        """
        t = _tarifa(LOJA_HORARIA)
        e1, antes = energia_e_custo(0.0, 0.0, 20.0, t, aas(17, 30))
        e2, depois = energia_e_custo(e1, antes, 25.0, t, aas(18, 30))

        self.assertAlmostEqual(depois, 20.0 * FORA + 5.0 * PONTA)
        self.assertLess(depois, 25.0 * PONTA)

    def test_energia_nao_anda_para_tras(self):
        """Telinha recarregada: ela reporta `(soc - inicial) * capacidade`, e
        recomecar zera a conta dela. A sessao guarda o maior ja visto."""
        antes = 30.0 * FORA
        e, custo = energia_e_custo(30.0, antes, 0.0, _tarifa(LOJA_HORARIA), aas(15))
        self.assertAlmostEqual(e, 30.0)
        self.assertAlmostEqual(custo, antes)

    def test_leitura_repetida_nao_cobra_duas_vezes(self):
        antes = 12.0 * FORA
        e, custo = energia_e_custo(12.0, antes, 12.0, _tarifa(LOJA_HORARIA), aas(15))
        self.assertAlmostEqual(e, 12.0)
        self.assertAlmostEqual(custo, antes)

    def test_custo_e_energia_nunca_discordam(self):
        """O bug que apareceu em producao, travado.

        Uma sessao real ficou com R$ 0,14 de custo e R$ 0,00 cobrado: a
        telinha foi recarregada, a energia voltou a zero e o
        `valor_cobrado_brl` -- que sai dela -- zerou junto, enquanto o custo
        guardava o que ja tinha acumulado. Margem negativa de uma recarga que
        nao aconteceu.

        A invariante: a soma dos incrementos e exatamente a energia guardada,
        entao o custo nunca descreve mais kWh do que o que o motorista paga.
        """
        VENDA = 1.62
        t = _tarifa(LOJA_SIMPLES)          # tarifa unica: da para comparar direto
        e, custo = 0.0, 0.0
        # sobe, cai (telinha recarregada), sobe de novo, repete uma leitura
        for reportado in (0.18, 0.0, 0.05, 0.05, 0.40, 0.0, 0.9):
            e, custo = energia_e_custo(e, custo, reportado, t, aas(15))
            self.assertAlmostEqual(custo, e * FORA, places=6,
                                   msg=f"custo e energia discordaram em {reportado}")
            self.assertLessEqual(custo, e * VENDA + 1e-9,
                                 "custo passou do cobrado: margem negativa falsa")
        self.assertAlmostEqual(e, 0.9)

    def test_leitura_negativa_nao_quebra(self):
        e, custo = energia_e_custo(5.0, 5.0 * FORA, -3.0, _tarifa(LOJA_SIMPLES), aas(15))
        self.assertAlmostEqual(e, 5.0)
        self.assertAlmostEqual(custo, 5.0 * FORA)

    def test_custo_fica_abaixo_do_cobrado_com_markup(self):
        """A margem da recarga precisa ser positiva: e a premissa do modelo.

        Mercado Central Butanta: R$ 1,62/kWh de venda sobre R$ 0,789 de
        tarifa. Fora da ponta a margem existe; na ponta, a R$ 2,15, ela fica
        NEGATIVA -- e isso e verdade no mundo real, e o motivo de a bateria e
        o leilao existirem.
        """
        venda = 1.62
        t = _tarifa(LOJA_HORARIA)

        _, fora = energia_e_custo(0.0, 0.0, 20.0, t, aas(14))
        self.assertLess(fora, 20.0 * venda)

        _, ponta = energia_e_custo(0.0, 0.0, 20.0, t, aas(19))
        self.assertGreater(ponta, 20.0 * venda)


if __name__ == "__main__":
    unittest.main()
