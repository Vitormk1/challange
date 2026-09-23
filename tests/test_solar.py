"""Testes do lado da geracao: o que o telhado entregou e o que isso poupou.

`ai/demanda.py` ja era funcao pura, e as contas de solar seguiram a mesma
regra: recebem o `plano_do_dia` pronto e nao tocam em banco nem em relogio. E
isso que permite testar aqui o dia que ninguem quer esperar acontecer -- a
bateria chegando no piso as 20h, com a tarifa de ponta correndo.

    python -m unittest discover -s tests -v
"""

import sys
import unittest
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from ai.demanda import (  # noqa: E402
    FAIXAS_BATERIA, POTENCIA_PLACA_KWP, RESTO_UTIL_NO_PISO,
    Bateria, Local, Tarifa, autonomia_da_bateria, faixa_de_bateria,
    horas_de_sol_equivalentes, placas_do_telhado, placas_para_carregador,
    plano_do_dia, rateio_de_placas, resumo_solar_do_dia,
)

# Quinta-feira. Ponta so existe em dia util, e um teste escrito num sabado
# passaria por engano -- foi exatamente o que escondeu a bateria parada.
QUINTA = datetime(2026, 9, 24)

FORA, PONTA = 0.7890, 2.1500
TARIFA = Tarifa(fora_ponta_kwh=FORA, ponta_kwh=PONTA, ponta_inicio=18, ponta_fim=21)


def loja(**troca) -> Local:
    """A Pet & Cia Vila Mariana da demonstracao: 30 kWp e bateria de 20 kWh."""
    base = dict(demanda_contratada_kw=75.0, carga_base_kw=18.0, tarifa=TARIFA,
                solar_kwp=30.0,
                bateria=Bateria(capacidade_kwh=20.0, potencia_kw=10.0, soc=0.50))
    base.update(troca)
    return Local(**base)


def linha(**campos) -> dict:
    """Uma linha de `plano_do_dia`, com os campos que o teste nao liga em zero."""
    base = {"hora": 12, "base_kw": 0.0, "carregadores_kw": 0.0, "solar_kw": 0.0,
            "bateria_kw": 0.0, "rede_kw": 0.0, "bateria_soc": 0.5,
            "bateria_meta_soc": 0.0, "em_ponta": False, "ultrapassou": False}
    base.update(campos)
    return base


class TestaFaixaDeBateria(unittest.TestCase):

    def test_os_quatro_cortes(self):
        for soc, esperado in ((1.00, "excelente"), (0.80, "excelente"),
                              (0.799, "bom"),      (0.55, "bom"),
                              (0.549, "alerta"),   (0.35, "alerta"),
                              (0.349, "critico"),  (0.00, "critico")):
            self.assertEqual(faixa_de_bateria(soc).nome, esperado, f"soc={soc}")

    def test_todo_soc_cai_em_exatamente_uma_faixa(self):
        """A especificacao que chegou punha o 55 em duas faixas e deixava um
        buraco entre 79 e 80. Este teste e o que trava a correcao.

        A faixa esperada e derivada de outro jeito -- filtrando TODOS os cortes
        que o soc alcanca e exigindo que exista exatamente um candidato de
        maior corte. Se dois cortes empatassem, ou se nenhum alcancasse, o
        teste quebra antes de olhar o resultado da funcao.
        """
        for passo in range(0, 1001):
            soc = passo / 1000.0
            alcancados = [(corte, nome) for nome, corte, _ in FAIXAS_BATERIA
                          if soc >= corte]
            self.assertTrue(alcancados, f"soc={soc:.3f} nao alcanca faixa nenhuma")
            maior = max(c for c, _ in alcancados)
            candidatos = [n for c, n in alcancados if c == maior]
            self.assertEqual(len(candidatos), 1, f"soc={soc:.3f} empatou: {candidatos}")
            f = faixa_de_bateria(soc)
            self.assertEqual(f.nome, candidatos[0], f"soc={soc:.3f}")
            self.assertTrue(f.rotulo and f.tom)

    def test_o_79_do_pedido_continua_em_bom(self):
        self.assertEqual(faixa_de_bateria(0.79).nome, "bom")

    def test_o_piso_vem_do_modelo_e_nao_de_constante_nova(self):
        """Se alguem mudar `Bateria.soc_minimo`, a tela tem de acompanhar."""
        self.assertEqual(faixa_de_bateria(0.10).piso_pct,
                         round(Bateria(1.0, 1.0).soc_minimo * 100, 1))

    def test_troca_para_rede_quando_a_energia_util_acaba(self):
        """Nao e `soc == piso`: a descarga freia perto do piso e nunca encosta.
        Uma bateria real para em 0,102 com piso de 0,100."""
        self.assertTrue(faixa_de_bateria(0.102).troca_para_rede)
        self.assertTrue(faixa_de_bateria(0.100).troca_para_rede)
        self.assertFalse(faixa_de_bateria(0.120).troca_para_rede)
        self.assertFalse(faixa_de_bateria(0.500).troca_para_rede)

    def test_o_criterio_do_piso_e_relativo(self):
        """O mesmo resto util decide igual em qualquer piso."""
        acima = RESTO_UTIL_NO_PISO * 2
        for piso in (0.05, 0.10, 0.30):
            util = 1.0 - piso
            self.assertTrue(faixa_de_bateria(piso, piso).troca_para_rede)
            self.assertFalse(faixa_de_bateria(piso + acima * util, piso).troca_para_rede)

    def test_sobra_util_e_do_utilizavel_e_nao_do_total(self):
        """Bateria em 10% com piso de 10% esta cheia de energia inacessivel."""
        self.assertEqual(faixa_de_bateria(0.10).acima_do_piso_pct, 0.0)
        self.assertEqual(faixa_de_bateria(1.00).acima_do_piso_pct, 100.0)

    def test_soc_fora_da_faixa_nao_quebra(self):
        self.assertEqual(faixa_de_bateria(-5.0).nome, "critico")
        self.assertEqual(faixa_de_bateria(9.0).nome, "excelente")


class TestaResumoSolar(unittest.TestCase):

    def test_dia_sem_sol_nao_quebra_nem_credita(self):
        r = resumo_solar_do_dia([linha(hora=h, base_kw=10.0) for h in range(24)], TARIFA)
        self.assertEqual(r.gerado_kwh, 0.0)
        self.assertEqual(r.custo_evitado_brl, 0.0)
        self.assertEqual(r.aproveitamento_pct, 0.0)   # sem ZeroDivisionError
        self.assertIsNone(r.pico_hora)

    def test_plano_vazio_nao_quebra(self):
        r = resumo_solar_do_dia([], TARIFA)
        self.assertEqual(r.gerado_kwh, 0.0)
        self.assertEqual(r.cobertura_dia_pct, 0.0)

    def test_sem_tarifa_conta_energia_mas_nao_dinheiro(self):
        r = resumo_solar_do_dia([linha(solar_kw=10.0, base_kw=10.0)], None)
        self.assertEqual(r.gerado_kwh, 10.0)
        self.assertEqual(r.custo_evitado_brl, 0.0)

    def test_conservacao_da_energia(self):
        """Todo kWh gerado foi para exatamente um destino."""
        plano = plano_do_dia(loja(), QUINTA, {h: 14.8 for h in (12, 13, 18, 19, 20)})
        r = resumo_solar_do_dia(plano, TARIFA)
        soma = (r.para_carros_kwh + r.para_loja_kwh
                + r.para_bateria_kwh + r.excedente_kwh)
        self.assertAlmostEqual(soma, r.gerado_kwh, places=1)

    def test_o_mesmo_kwh_vale_mais_na_ponta(self):
        barato = resumo_solar_do_dia([linha(solar_kw=10.0, base_kw=10.0)], TARIFA)
        caro = resumo_solar_do_dia([linha(solar_kw=10.0, base_kw=10.0, em_ponta=True)], TARIFA)
        self.assertAlmostEqual(caro.custo_evitado_brl / barato.custo_evitado_brl,
                               PONTA / FORA, places=3)

    def test_o_sol_nao_se_credita_alem_do_consumo(self):
        """50 kW de sol para 10 kW de consumo poupam 10, nao 50."""
        r = resumo_solar_do_dia([linha(solar_kw=50.0, base_kw=10.0)], TARIFA)
        self.assertAlmostEqual(r.para_carros_kwh + r.para_loja_kwh, 10.0, places=2)
        self.assertAlmostEqual(r.custo_evitado_brl, 10.0 * FORA, places=2)
        self.assertAlmostEqual(r.excedente_kwh, 40.0, places=2)

    def test_sem_carregador_nada_e_atribuido_a_carro(self):
        r = resumo_solar_do_dia([linha(solar_kw=10.0, base_kw=20.0)], TARIFA)
        self.assertEqual(r.para_carros_kwh, 0.0)
        self.assertAlmostEqual(r.para_loja_kwh, 10.0, places=2)

    def test_o_rateio_entre_carro_e_loja_segue_o_consumo(self):
        r = resumo_solar_do_dia(
            [linha(solar_kw=10.0, base_kw=5.0, carregadores_kw=15.0)], TARIFA)
        self.assertAlmostEqual(r.para_carros_kwh, 7.5, places=2)   # 15 de 20
        self.assertAlmostEqual(r.para_loja_kwh, 2.5, places=2)

    def test_sol_guardado_ao_meio_dia_vale_a_tarifa_da_ponta(self):
        """E a conta que paga a bateria: guarda a R$ 0,789, devolve a R$ 2,15."""
        plano = [linha(hora=12, solar_kw=10.0, base_kw=0.0, bateria_kw=-10.0),
                 linha(hora=19, solar_kw=0.0, base_kw=10.0, bateria_kw=10.0, em_ponta=True)]
        r = resumo_solar_do_dia(plano, TARIFA)
        self.assertAlmostEqual(r.para_bateria_kwh, 10.0, places=2)
        self.assertAlmostEqual(r.evitado_bateria_brl, 10.0 * PONTA, places=2)
        self.assertEqual(r.evitado_direto_brl, 0.0)

    def test_bateria_carregada_da_rede_nao_e_economia_do_sol(self):
        """Descarregar energia comprada da rede e arbitragem de tarifa, nao
        geracao. Creditar isso ao telhado inflaria a conta que decide se vale
        instalar placa."""
        plano = [linha(hora=3, solar_kw=0.0, base_kw=5.0, bateria_kw=-10.0),
                 linha(hora=19, solar_kw=0.0, base_kw=10.0, bateria_kw=10.0, em_ponta=True)]
        r = resumo_solar_do_dia(plano, TARIFA)
        self.assertEqual(r.para_bateria_kwh, 0.0)
        self.assertEqual(r.evitado_bateria_brl, 0.0)
        self.assertEqual(r.custo_evitado_brl, 0.0)

    def test_aproveitamento_nao_e_o_rendimento_disfarcado(self):
        """`aproveitado / gerado`, e nao `gerado / nominal`. Sol que a loja
        consumiu inteiro e 100% de aproveitamento, mesmo com rendimento 0,80."""
        r = resumo_solar_do_dia([linha(solar_kw=10.0, base_kw=50.0)], TARIFA)
        self.assertEqual(r.aproveitamento_pct, 100.0)

    def test_excedente_derruba_o_aproveitamento(self):
        r = resumo_solar_do_dia([linha(solar_kw=10.0, base_kw=5.0)], TARIFA)
        self.assertAlmostEqual(r.excedente_kwh, 5.0, places=2)
        self.assertEqual(r.aproveitamento_pct, 50.0)

    def test_cobertura_do_dia_nunca_passa_de_cem(self):
        r = resumo_solar_do_dia([linha(solar_kw=100.0, base_kw=1.0)], TARIFA)
        self.assertLessEqual(r.cobertura_dia_pct, 100.0)

    def test_passo_de_quinze_minutos(self):
        r = resumo_solar_do_dia([linha(solar_kw=8.0, base_kw=8.0)], TARIFA, passo_min=15)
        self.assertAlmostEqual(r.gerado_kwh, 2.0, places=2)


class TestaPlacas(unittest.TestCase):

    def test_nunca_subconta_placa(self):
        for kwp in (0.1, 5.0, 20.0, 30.0, 79.9, 120.0):
            n = placas_do_telhado(kwp)
            self.assertGreaterEqual(n * POTENCIA_PLACA_KWP, kwp - 1e-9, f"{kwp} kWp")

    def test_sem_telhado_nao_ha_placa(self):
        self.assertEqual(placas_do_telhado(0), 0)
        self.assertEqual(placas_do_telhado(-5), 0)

    def test_horas_de_sol_saem_do_proprio_dia(self):
        """Em Sao Paulo, em setembro, o valor real fica entre 3 e 7 horas de
        sol pleno. Banda de sanidade: o valor exato ja esta travado pelos
        testes de `solar_kw`."""
        hse = horas_de_sol_equivalentes(plano_do_dia(loja(), QUINTA), 30.0)
        self.assertGreater(hse, 3.0)
        self.assertLess(hse, 7.0)

    def test_sem_telhado_nao_ha_horas_de_sol(self):
        self.assertEqual(horas_de_sol_equivalentes(plano_do_dia(loja(solar_kwp=0.0),
                                                                QUINTA), 0.0), 0.0)

    def test_placas_para_uma_vaga_crescem_com_a_potencia(self):
        p7 = placas_para_carregador(7.4, 2.0, 5.0)
        p22 = placas_para_carregador(22.0, 2.0, 5.0)
        p50 = placas_para_carregador(50.0, 2.0, 5.0)
        self.assertLess(p7, p22)
        self.assertLess(p22, p50)

    def test_vaga_sem_uso_nao_pede_placa(self):
        self.assertEqual(placas_para_carregador(22.0, 0.0, 5.0), 0)
        self.assertEqual(placas_para_carregador(0.0, 2.0, 5.0), 0)

    def test_dia_sem_sol_nao_dimensiona(self):
        """Dividir por zero horas de sol daria infinito de placas."""
        self.assertEqual(placas_para_carregador(22.0, 2.0, 0.0), 0)

    def test_rateio_divide_o_telhado_entre_as_vagas(self):
        r = rateio_de_placas(30.0, [7.4, 7.4], 5.67)
        self.assertEqual(r.total, placas_do_telhado(30.0))
        self.assertEqual(r.carregadores, 2)
        self.assertAlmostEqual(r.por_carregador, r.total / 2, places=1)
        self.assertEqual(len(r.necessarias), 2)
        self.assertEqual(r.necessarias_por_carregador, max(r.necessarias))
        self.assertEqual(r.necessarias_total, sum(r.necessarias))

    def test_loja_sem_vaga_nao_divide_por_zero(self):
        r = rateio_de_placas(30.0, [], 5.67)
        self.assertEqual(r.por_carregador, 0.0)
        self.assertEqual(r.necessarias_total, 0)
        self.assertTrue(r.cobre)

    def test_telhado_pequeno_nao_cobre_e_diz_quanto_falta(self):
        r = rateio_de_placas(2.0, [50.0, 50.0, 50.0], 5.0)
        self.assertFalse(r.cobre)
        self.assertEqual(r.falta, r.necessarias_total - r.total)
        self.assertGreater(r.falta, 0)


class TestaAutonomia(unittest.TestCase):

    def test_bateria_que_cobre_o_dia(self):
        plano = [linha(hora=h, bateria_soc=0.80) for h in range(24)]
        a = autonomia_da_bateria(plano, 20.0)
        self.assertTrue(a.cobre_o_dia)
        self.assertIsNone(a.hora_do_piso)
        self.assertEqual(a.deficit_kwh, 0.0)

    def test_acusa_a_hora_em_que_a_bateria_acaba(self):
        plano = ([linha(hora=h, bateria_soc=0.80) for h in range(20)]
                 + [linha(hora=h, bateria_soc=0.102, rede_kw=30.0, em_ponta=True)
                    for h in (20,)]
                 + [linha(hora=h, bateria_soc=0.102) for h in (21, 22, 23)])
        a = autonomia_da_bateria(plano, 20.0)
        self.assertFalse(a.cobre_o_dia)
        self.assertEqual(a.hora_do_piso, 20)
        self.assertEqual(a.troca_para_rede_em, 20)
        self.assertEqual(a.horas_no_piso, 4)
        self.assertAlmostEqual(a.deficit_kwh, 30.0, places=1)

    def test_deficit_conta_so_a_energia_cara(self):
        """Rede fora da ponta o lojista pagaria de qualquer jeito; contar isso
        inflaria o numero que mede o custo de a bateria ter acabado cedo."""
        plano = [linha(hora=2, bateria_soc=0.10, rede_kw=99.0, em_ponta=False)]
        self.assertEqual(autonomia_da_bateria(plano, 20.0).deficit_kwh, 0.0)

    def test_loja_sem_bateria_cobre_o_dia_por_vacuidade(self):
        a = autonomia_da_bateria([linha(bateria_soc=0.0)], 0.0)
        self.assertTrue(a.cobre_o_dia)
        self.assertIsNone(a.hora_do_piso)

    def test_o_dia_da_demonstracao_acaba_as_vinte(self):
        """O cenario real da Pet & Cia Vila Mariana, ponta a ponta."""
        plano = plano_do_dia(loja(), QUINTA, {h: 14.8 for h in (12, 13, 18, 19, 20)})
        a = autonomia_da_bateria(plano, 20.0)
        self.assertFalse(a.cobre_o_dia)
        self.assertEqual(a.hora_do_piso, 20)
        self.assertGreater(a.deficit_kwh, 0.0)


class TestaContratoDoPlano(unittest.TestCase):
    """Nao e teste de solar. E o seguro mais barato desta fatia.

    `desenharDemanda`, `desenharBateria`, a rota `/demanda`, a rota `/solar` e
    `resumo_solar_do_dia` leem as mesmas chaves de `plano_do_dia`. Uma
    renomeacao distraida quebraria cinco consumidores em silencio -- com este
    teste, quebra o CI.
    """

    CHAVES = {"hora", "base_kw", "carregadores_kw", "solar_kw", "bateria_kw",
              "rede_kw", "bateria_soc", "bateria_meta_soc", "em_ponta", "ultrapassou"}

    def test_as_chaves_da_linha_nao_mudaram(self):
        self.assertEqual(set(plano_do_dia(loja(), QUINTA)[12]), self.CHAVES)

    def test_vale_para_loja_sem_bateria_e_sem_sol(self):
        magra = loja(solar_kwp=0.0, bateria=None)
        self.assertEqual(set(plano_do_dia(magra, QUINTA)[12]), self.CHAVES)

    def test_o_sinal_da_bateria_nao_inverteu(self):
        """`bateria_kw < 0` guarda, `> 0` entrega. `resumo_solar_do_dia`
        depende disso para separar o que foi guardado do que foi devolvido."""
        plano = plano_do_dia(loja(), QUINTA, {h: 14.8 for h in (18, 19, 20)})
        guardando = [l for l in plano if l["bateria_kw"] < 0]
        entregando = [l for l in plano if l["bateria_kw"] > 0]
        self.assertTrue(guardando, "nenhuma hora guardando")
        self.assertTrue(entregando, "nenhuma hora entregando")
        self.assertTrue(all(not l["em_ponta"] for l in guardando))
        self.assertTrue(all(l["em_ponta"] for l in entregando))


if __name__ == "__main__":
    unittest.main()
