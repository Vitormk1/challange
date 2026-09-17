"""Testes do gerenciamento de demanda de potencia.

`ai/demanda.py` e funcao pura de proposito, e e isto que a pureza compra: dar
para testar o pior caso -- meio-dia de verao, ponta com a bateria vazia, quatro
carros pedindo junto -- sem servidor, sem banco e sem esperar o relogio chegar
la.

    python -m unittest discover -s tests -v
"""

import sys
import unittest
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from ai.demanda import (  # noqa: E402
    Bateria, Local, Tarifa, fator_cashback, folga_kw, melhor_janela,
    plano_do_dia, repartir, solar_kw,
)

# Quinta-feira, para cair em dia util. Ponta so existe em dia util, e um teste
# escrito num sabado passaria por engano.
QUINTA = datetime(2026, 9, 17, 12, 0)


def loja(**troca) -> Local:
    base = dict(demanda_contratada_kw=100.0, carga_base_kw=30.0,
                tarifa=Tarifa(fora_ponta_kwh=0.80, ponta_kwh=2.15,
                              ponta_inicio=18, ponta_fim=21))
    base.update(troca)
    return Local(**base)


class TestaTarifa(unittest.TestCase):
    def test_ponta_so_em_dia_util(self):
        t = Tarifa(0.80, 2.15, 18, 21)
        self.assertTrue(t.em_ponta(datetime(2026, 9, 17, 19)))     # quinta
        self.assertFalse(t.em_ponta(datetime(2026, 9, 19, 19)))    # sabado
        self.assertFalse(t.em_ponta(datetime(2026, 9, 20, 19)))    # domingo

    def test_limites_da_janela(self):
        t = Tarifa(0.80, 2.15, 18, 21)
        self.assertFalse(t.em_ponta(datetime(2026, 9, 17, 17, 59)))
        self.assertTrue(t.em_ponta(datetime(2026, 9, 17, 18, 0)))
        self.assertTrue(t.em_ponta(datetime(2026, 9, 17, 20, 59)))
        # 21h em ponto ja e fora: a janela e [inicio, fim).
        self.assertFalse(t.em_ponta(datetime(2026, 9, 17, 21, 0)))

    def test_preco_acompanha_a_hora(self):
        t = Tarifa(0.80, 2.15, 18, 21)
        self.assertAlmostEqual(t.preco_kwh(datetime(2026, 9, 17, 10)), 0.80)
        self.assertAlmostEqual(t.preco_kwh(datetime(2026, 9, 17, 19)), 2.15)


class TestaSolar(unittest.TestCase):
    def test_de_noite_nao_gera(self):
        self.assertEqual(solar_kw(50.0, datetime(2026, 9, 17, 2)), 0.0)
        self.assertEqual(solar_kw(50.0, datetime(2026, 9, 17, 23)), 0.0)

    def test_pico_ao_meio_dia(self):
        manha = solar_kw(50.0, datetime(2026, 9, 17, 9))
        meio = solar_kw(50.0, datetime(2026, 9, 17, 12))
        tarde = solar_kw(50.0, datetime(2026, 9, 17, 16))
        self.assertGreater(meio, manha)
        self.assertGreater(meio, tarde)

    def test_nunca_passa_da_potencia_instalada(self):
        # Um sistema de 50 kWp nao entrega 50 kW: o rendimento come uma parte,
        # e o sol so bate perpendicular no equador.
        for h in range(24):
            self.assertLessEqual(solar_kw(50.0, datetime(2026, 9, 17, h)), 50.0)

    def test_sem_placa_nao_ha_geracao(self):
        self.assertEqual(solar_kw(0.0, QUINTA), 0.0)


class TestaFolga(unittest.TestCase):
    def test_desconta_a_carga_da_loja(self):
        # 100 contratados, 5% de margem, 30 de carga base: sobram 65.
        f = folga_kw(loja(), QUINTA)
        self.assertAlmostEqual(f.disponivel_kw, 65.0, places=1)

    def test_desconta_quem_ja_esta_carregando(self):
        f = folga_kw(loja(), QUINTA, carregando_kw=40.0)
        self.assertAlmostEqual(f.disponivel_kw, 25.0, places=1)

    def test_nunca_devolve_negativo(self):
        f = folga_kw(loja(), QUINTA, carregando_kw=500.0)
        self.assertEqual(f.disponivel_kw, 0.0)

    def test_sol_levanta_o_teto(self):
        sem = folga_kw(loja(), QUINTA).disponivel_kw
        com = folga_kw(loja(solar_kwp=40.0), QUINTA).disponivel_kw
        self.assertGreater(com, sem)

    def test_sol_entra_descontado_pela_confianca(self):
        # Ceu limpo e otimista: a folga so conta 70% da geracao prevista.
        l = loja(solar_kwp=40.0)
        f = folga_kw(l, QUINTA)
        bruto = solar_kw(40.0, QUINTA, l.latitude)
        self.assertAlmostEqual(f.solar_kw, bruto * l.confianca_solar, places=2)

    def test_bateria_so_entra_quando_vale(self):
        l = loja(bateria=Bateria(capacidade_kwh=40.0, potencia_kw=20.0, soc=0.9))
        meio_dia = folga_kw(l, QUINTA)                       # folgado, fora de ponta
        na_ponta = folga_kw(l, QUINTA.replace(hour=19))      # hora cara
        self.assertEqual(meio_dia.bateria_kw, 0.0)
        self.assertGreater(na_ponta.bateria_kw, 0.0)

    def test_bateria_vazia_nao_promete_o_que_nao_tem(self):
        l = loja(bateria=Bateria(capacidade_kwh=40.0, potencia_kw=20.0, soc=0.10))
        f = folga_kw(l, QUINTA.replace(hour=19))
        self.assertEqual(f.bateria_kw, 0.0)

    def test_ocupacao(self):
        f = folga_kw(loja(), QUINTA, carregando_kw=65.0)
        self.assertAlmostEqual(f.ocupacao, 1.0, places=2)


class TestaReparticao(unittest.TestCase):
    def test_cabendo_todos_levam_o_que_pediram(self):
        self.assertEqual(repartir([10.0, 10.0], 50.0), [10.0, 10.0])

    def test_nunca_entrega_mais_que_o_disponivel(self):
        dado = repartir([50.0, 50.0, 50.0], 30.0)
        self.assertAlmostEqual(sum(dado), 30.0, places=6)

    def test_quem_pede_pouco_leva_tudo(self):
        # O carro a 85% de bateria esta no regime CV e so aceita 3 kW. Dar mais
        # seria jogar fora; a sobra tem que ir para quem consegue usar.
        dado = repartir([11.0, 11.0, 3.0], 12.0)
        self.assertAlmostEqual(dado[2], 3.0, places=6)
        self.assertAlmostEqual(dado[0], dado[1], places=6)
        self.assertAlmostEqual(sum(dado), 12.0, places=6)

    def test_divide_igual_entre_os_famintos(self):
        dado = repartir([100.0, 100.0], 50.0)
        self.assertAlmostEqual(dado[0], 25.0, places=6)
        self.assertAlmostEqual(dado[1], 25.0, places=6)

    def test_sem_potencia_ninguem_carrega(self):
        self.assertEqual(repartir([10.0, 10.0], 0.0), [0.0, 0.0])

    def test_lista_vazia(self):
        self.assertEqual(repartir([], 50.0), [])

    def test_ordem_preservada(self):
        dado = repartir([3.0, 50.0, 5.0], 20.0)
        self.assertAlmostEqual(dado[0], 3.0, places=6)
        self.assertAlmostEqual(dado[2], 5.0, places=6)
        self.assertAlmostEqual(dado[1], 12.0, places=6)


class TestaIncentivo(unittest.TestCase):
    def test_ponta_derruba_o_cashback(self):
        self.assertLess(fator_cashback(loja(), QUINTA.replace(hour=19)), 1.0)

    def test_sol_sobrando_aumenta(self):
        # Carga base baixa e placa grande: sobra sol, e o credito sobe para
        # puxar gente para a hora em que a energia e de graca.
        l = loja(carga_base_kw=5.0, solar_kwp=60.0)
        self.assertGreater(fator_cashback(l, QUINTA), 1.0)

    def test_ponta_vence_o_sol(self):
        # Ponta as 17h com sol ainda no ceu: a tarifa cara continua mandando,
        # porque a loja ainda compra da rede o que o sol nao cobre.
        l = Local(demanda_contratada_kw=100.0, carga_base_kw=5.0, solar_kwp=60.0,
                  tarifa=Tarifa(0.80, 2.15, ponta_inicio=17, ponta_fim=20))
        self.assertLess(fator_cashback(l, QUINTA.replace(hour=17)), 1.0)

    def test_hora_neutra(self):
        self.assertEqual(fator_cashback(loja(), QUINTA.replace(hour=10)), 1.0)

    def test_melhor_janela_aponta_para_fora_da_ponta(self):
        m = melhor_janela(loja(), QUINTA.replace(hour=19))
        self.assertIsNotNone(m["melhor_em"])
        self.assertGreaterEqual(m["melhor_em"].hour, 21)
        self.assertGreater(m["economia_pct"], 0)

    def test_fora_da_ponta_nao_ha_o_que_sugerir(self):
        m = melhor_janela(loja(), QUINTA.replace(hour=10))
        self.assertIsNone(m["melhor_em"])


class TestaPlanoDoDia(unittest.TestCase):
    def test_vinte_e_quatro_horas(self):
        self.assertEqual(len(plano_do_dia(loja(), QUINTA)), 24)

    def test_acusa_ultrapassagem(self):
        # 100 contratados, 30 de base e 200 kW de carro as 19h: estoura, e a
        # tela precisa dizer isso. E o aviso mais caro do painel.
        linhas = plano_do_dia(loja(), QUINTA, {19: 200.0})
        hora19 = next(l for l in linhas if l["hora"] == 19)
        self.assertTrue(hora19["ultrapassou"])
        self.assertFalse(any(l["ultrapassou"] for l in linhas if l["hora"] != 19))

    def test_sol_reduz_o_que_vem_da_rede(self):
        sem = plano_do_dia(loja(), QUINTA, {12: 40.0})
        com = plano_do_dia(loja(solar_kwp=60.0), QUINTA, {12: 40.0})
        h_sem = next(l for l in sem if l["hora"] == 12)["rede_kw"]
        h_com = next(l for l in com if l["hora"] == 12)["rede_kw"]
        self.assertLess(h_com, h_sem)

    def test_bateria_carrega_de_dia_e_descarrega_na_ponta(self):
        l = loja(solar_kwp=80.0, carga_base_kw=10.0,
                 bateria=Bateria(capacidade_kwh=40.0, potencia_kw=20.0, soc=0.3))
        linhas = plano_do_dia(l, QUINTA)
        # "em alguma hora de sol", e nao "ao meio-dia": com 80 kWp alimentando
        # 10 kW de carga base, o excedente enche 40 kWh antes das 9h e ao
        # meio-dia ja nao ha o que carregar. Cravar a hora testaria o tamanho
        # da bateria, nao o comportamento.
        de_dia = [x for x in linhas if x["solar_kw"] > 0]
        na_ponta = [x for x in linhas if x["em_ponta"]]
        self.assertTrue(any(x["bateria_kw"] < 0 for x in de_dia),
                        "a bateria deveria carregar com o excedente de sol")
        self.assertTrue(any(x["bateria_kw"] > 0 for x in na_ponta),
                        "a bateria deveria devolver na ponta")
        # e o estado de carga sobe antes de descer
        pico = max(x["bateria_soc"] for x in de_dia)
        self.assertGreater(pico, 0.3)
        self.assertLess(na_ponta[-1]["bateria_soc"], pico)

    def test_rede_nunca_negativa(self):
        linhas = plano_do_dia(loja(solar_kwp=200.0, carga_base_kw=5.0), QUINTA)
        self.assertTrue(all(l["rede_kw"] >= 0 for l in linhas))


if __name__ == "__main__":
    unittest.main()
