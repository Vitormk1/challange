"""Põe no banco os pontos que o mapa mostra.

    python api/semear_mapa.py

Até aqui o mapa era desenho: os 12 pontos nasciam de um gerador com semente
fixa dentro do mapa.js, e nenhum deles existia no banco. Servia para mostrar a
ideia, e parou de servir quando a reserva entrou — não dá para reservar uma
vaga que só existe como constante de JavaScript.

Este script cria as mesmas 12 lojas, nas mesmas coordenadas, com a mesma
potência e o mesmo preço que o gerador produzia. O mapa continua idêntico; a
diferença é que agora cada marcador é uma linha com id.

NÃO APAGA NADA. É seguro rodar de novo: reconhece as lojas pelo nome e só
completa o que faltar. É o contrário do seed.py, que trunca dez tabelas.

As coordenadas são fictícias, e continuam sendo — o aviso no mapa segue
verdadeiro. O que deixou de ser fictício é a existência do ponto.
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from db import conectar


# O mesmo gerador linear congruente do mapa.js, com a mesma semente. Copiado em
# vez de importado porque o original é JavaScript; os valores foram conferidos
# contra os 12 nomes que a página mostra, na ordem.
def _semente(n: int):
    estado = {"n": n}

    def proximo() -> float:
        estado["n"] = (estado["n"] * 1664525 + 1013904223) % 4294967296
        return estado["n"] / 4294967296

    return proximo


CENTRO = (-23.5866, -46.6396)          # Vila Mariana, São Paulo
BAIRROS = ["Vila Mariana", "Pinheiros", "Moema", "Itaim Bibi", "Perdizes",
           "Santana", "Tatuapé", "Butantã", "Saúde", "Lapa", "Ipiranga",
           "Campo Belo", "Vila Madalena", "Brooklin", "Higienópolis"]
LOJAS = [("Pet & Cia", "pet"), ("Mercado Bom Dia", "mercado"),
         ("Academia Pulso", "academia"), ("Cantina do Vale", "restaurante"),
         ("Farmácia Vida", "farmacia"), ("Shopping Sul", "shopping"),
         ("Mercado Central", "mercado"), ("Pet Feliz", "pet"),
         ("Padaria Aurora", "restaurante"), ("Drogaria Norte", "farmacia"),
         ("Studio Corpo", "academia"), ("Empório Leste", "mercado")]
CONECTORES = ["Tipo 2", "CCS2", "Tipo 2", "CCS2", "Tipo 2"]
POTENCIAS = [7.4, 11, 22, 22, 50]


def pontos() -> list[dict]:
    rnd = _semente(20260907)
    saida = []
    for nome, segmento in LOJAS:
        bairro = BAIRROS[int(rnd() * len(BAIRROS))]
        ponto = {
            "nome": f"{nome} {bairro}",
            "segmento": segmento,
            "lat": round(CENTRO[0] + (rnd() - 0.5) * 0.18, 6),
            "lng": round(CENTRO[1] + (rnd() - 0.5) * 0.18, 6),
            "potencia": POTENCIAS[int(rnd() * len(POTENCIAS))],
            "conector": CONECTORES[int(rnd() * len(CONECTORES))],
            "vagas": 1 + int(rnd() * 3),
            "preco": round(0.79 + rnd() * 0.9, 2),
            "cashback": 5 + int(rnd() * 11),
        }
        # O gerador do mapa.js sorteia `livre` aqui. O valor não é guardado —
        # disponibilidade agora vem das reservas —, mas o sorteio precisa ser
        # consumido, senão todos os pontos seguintes saem deslocados.
        rnd()
        saida.append(ponto)
    return saida


def semear() -> None:
    criadas = atualizadas = carregadores = 0
    with conectar() as con, con.cursor() as cur:
        for p in pontos():
            cur.execute("SELECT id, lat, lng FROM estabelecimentos WHERE nome = %s", (p["nome"],))
            loja = cur.fetchone()

            if loja is None:
                cur.execute(
                    "INSERT INTO estabelecimentos (nome, segmento, lat, lng, tarifa_kwh_brl) "
                    "VALUES (%s, %s, %s, %s, 0.789) RETURNING id",
                    (p["nome"], p["segmento"], p["lat"], p["lng"]))
                loja_id = cur.fetchone()["id"]
                criadas += 1
            else:
                loja_id = loja["id"]
                if loja["lat"] is None:
                    cur.execute("UPDATE estabelecimentos SET lat=%s, lng=%s WHERE id=%s",
                                (p["lat"], p["lng"], loja_id))
                    atualizadas += 1

            # Uma vaga por carregador, numeradas. O `vagas` do gerador virava só
            # um número na tela; aqui vira linha, porque cada uma é reservável
            # em separado.
            cur.execute("SELECT count(*) AS n FROM carregadores WHERE estabelecimento_id = %s", (loja_id,))
            faltam = p["vagas"] - cur.fetchone()["n"]
            for i in range(faltam):
                cur.execute(
                    "INSERT INTO carregadores (estabelecimento_id, nome, potencia_kw, conector, "
                    "                          preco_kwh_brl, cashback_pct) "
                    "VALUES (%s, %s, %s, %s, %s, %s)",
                    (loja_id, f"Vaga {i + 1}", p["potencia"], p["conector"],
                     p["preco"], p["cashback"]))
                carregadores += 1
        con.commit()

    print(f"lojas criadas: {criadas}")
    print(f"lojas que ganharam coordenada: {atualizadas}")
    print(f"carregadores criados: {carregadores}")
    if not (criadas or atualizadas or carregadores):
        print("nada a fazer — o mapa já está no banco")


if __name__ == "__main__":
    semear()
