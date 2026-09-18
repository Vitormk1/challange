"""Os cards do painel: a tela e o servidor precisam concordar.

`docs/painel/app.js` tem o objeto `CARDS`, que é o que a pessoa vê e arrasta.
`api/main.py` tem `CARDS_PERMITIDOS`, que é o que o servidor aceita gravar em
`paineis.cards`. São duas listas escritas à mão, em linguagens diferentes, e
nada obrigava as duas a serem a mesma.

Quando elas divergem o efeito é silencioso e específico: o card aparece no
seletor, é possível arrastá-lo, o painel salva sem erro nenhum — e some ao
recarregar, porque `normalizar_cards` descartou um id que não conhecia. Foi
exatamente o que aconteceu com `demanda`, `bateria` e `cashback`, e o que
demorou a ser achado porque a tela não tinha como saber que o servidor
discordou.

Este teste lê os dois arquivos como texto. Ler o JavaScript com expressão
regular é feio, e é de propósito: a alternativa seria manter a lista num
terceiro lugar e pedir que ninguém esqueça de atualizar os três.

    python -m unittest discover -s tests -v
"""

import re
import sys
import unittest
from pathlib import Path

RAIZ = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(RAIZ / "api"))


def cards_da_tela() -> dict[str, bool]:
    """Os ids de `CARDS` no app.js, e se cada um é financeiro."""
    js = (RAIZ / "docs" / "painel" / "app.js").read_text(encoding="utf-8")
    bloco = re.search(r"\bCARDS\s*=\s*\{(.*?)\n\};", js, re.S)
    assert bloco, "não achei o objeto CARDS em app.js"
    achados = {}
    for linha in bloco.group(1).splitlines():
        m = re.match(r"\s{2}(\w+):\s*\{(.*)", linha)
        if m:
            achados[m.group(1)] = "financeiro:true" in m.group(2).replace(" ", "")
    return achados


def conjunto_do_servidor(nome: str) -> set[str]:
    py = (RAIZ / "api" / "main.py").read_text(encoding="utf-8")
    bloco = re.search(rf"^{nome} = \{{(.*?)^\}}|^{nome} = \{{(.*?)\}}",
                      py, re.S | re.M)
    assert bloco, f"não achei {nome} em main.py"
    corpo = bloco.group(1) or bloco.group(2)
    corpo = re.sub(r"#[^\n]*", "", corpo)          # tira comentários
    return set(re.findall(r'"(\w+)"', corpo))


class TestCards(unittest.TestCase):

    def setUp(self):
        self.tela = cards_da_tela()
        self.permitidos = conjunto_do_servidor("CARDS_PERMITIDOS")
        self.financeiros = conjunto_do_servidor("CARDS_FINANCEIROS")

    def test_achou_os_dois_lados(self):
        """Se a regex parar de casar, o resto passaria vazio e sem avisar."""
        self.assertGreaterEqual(len(self.tela), 10)
        self.assertGreaterEqual(len(self.permitidos), 10)

    def test_todo_card_da_tela_o_servidor_aceita(self):
        faltam = sorted(set(self.tela) - self.permitidos)
        self.assertEqual(faltam, [], f"a tela desenha e o servidor descarta: {faltam}")

    def test_servidor_nao_aceita_card_que_nao_existe(self):
        """Id que a tela não conhece fica guardado para sempre e invisível."""
        sobram = sorted(self.permitidos - set(self.tela))
        self.assertEqual(sobram, [], f"o servidor aceita id que a tela não tem: {sobram}")

    def test_os_financeiros_sao_os_mesmos(self):
        """Divergir aqui vaza número de dinheiro para operador, ou esconde
        card de quem tem direito de ver."""
        na_tela = {k for k, fin in self.tela.items() if fin}
        self.assertEqual(na_tela, self.financeiros)

    def test_financeiro_e_subconjunto_do_permitido(self):
        self.assertTrue(self.financeiros <= self.permitidos)

    def test_normalizar_descarta_id_desconhecido(self):
        """A defesa que motiva a lista continua de pé."""
        from main import normalizar_cards
        saida = normalizar_cards([{"id": "bateria"}, {"id": "inventado"}])
        self.assertEqual([c["id"] for c in saida], ["bateria"])

    def test_normalizar_aceita_os_tres_que_sumiam(self):
        from main import normalizar_cards
        pedidos = [{"id": "demanda"}, {"id": "bateria"}, {"id": "cashback"}]
        saida = [c["id"] for c in normalizar_cards(pedidos)]
        self.assertEqual(saida, ["demanda", "bateria", "cashback"])


if __name__ == "__main__":
    unittest.main()
