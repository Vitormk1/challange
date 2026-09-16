"""Teste de navegador local com API simulada; nunca cria Pix real.

Instale playwright e Chromium, depois execute este arquivo.
"""
import base64
import copy
import json
import os
from datetime import datetime, timedelta, timezone
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parents[1]
os.environ.setdefault("PLAYWRIGHT_BROWSERS_PATH", str(Path(os.environ["TEMP"]) / "smartcharge-browsers"))
ORIGEM = "http://127.0.0.1:8000"
ARTEFATOS = ROOT / "artifacts" / "carteira"
ARTEFATOS.mkdir(parents=True, exist_ok=True)


def executar():
    with sync_playwright() as pw:
        navegador = pw.chromium.launch()
        for largura, altura, tema in [(390,844,"light"),(1280,900,"light"),(390,844,"dark")]:
            contexto = navegador.new_context(viewport={"width":largura,"height":altura}, color_scheme=tema)
            pagina = contexto.new_page()
            erros = []
            pagina.on("pageerror", lambda e: erros.append(str(e)))
            agora = datetime.now(timezone.utc)
            estado = {"saldo_brl":"0.00", "lancamentos":[], "cobrancas":[], "cashback_lojas":[],
                      "documento_necessario":True,"pix_disponivel":True,"modo_demo":False,"ambiente":"producao"}
            pix = {"id":"pay_simulado","valor_brl":"25.50","status":"PENDING","recebido_em":None,
                   "criado_em":agora.isoformat(),"expira_em":(agora+timedelta(hours=1)).isoformat(),
                   "copia_e_cola":"000201-CODIGO-SIMULADO-NAO-PAGAR",
                   "imagem_base64":base64.b64encode((ROOT/'docs/painel/img/logo.png').read_bytes()).decode()}
            pedidos = []
            def rota(route):
                req = route.request
                caminho = req.url.removeprefix(ORIGEM).split('?')[0]
                if not req.url.startswith(ORIGEM): raise AssertionError(f"Requisição externa no teste: {req.url}")
                dados = None
                if caminho == '/auth/eu': dados = {"usuario":{"papel":"motorista","nome":"Motorista Teste"}}
                elif caminho == '/carteira': dados = estado
                elif caminho == '/carteira/pix' and req.method == 'POST':
                    pedidos.append(req.post_data_json)
                    estado['cobrancas'] = [copy.deepcopy(pix)]; estado['documento_necessario'] = False
                    dados = pix
                elif caminho.endswith('/verificar'):
                    pix.update(status='RECEIVED',recebido_em=agora.isoformat())
                    estado.update(saldo_brl='25.50',cobrancas=[copy.deepcopy(pix)],lancamentos=[
                        {"id":1,"tipo":"recarga_pix","valor_brl":"25.50","descricao":"Pix confirmado <img src=x onerror=alert(1)>","criado_em":agora.isoformat()}])
                    dados = pix
                elif caminho.startswith('/carteira/pix/'): dados = pix
                if dados is not None:
                    route.fulfill(status=200,content_type='application/json',body=json.dumps(dados)); return
                arquivo = (ROOT/'docs'/caminho.lstrip('/')).resolve()
                assert arquivo.is_relative_to(ROOT/'docs')
                if not arquivo.is_file(): route.fulfill(status=404); return
                mime = {'.html':'text/html','.js':'application/javascript','.css':'text/css','.png':'image/png'}.get(arquivo.suffix,'application/octet-stream')
                route.fulfill(status=200,content_type=mime,body=arquivo.read_bytes(),headers={
                    'Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'"})
            pagina.route('**/*',rota)
            pagina.goto(ORIGEM+'/painel/carteira.html')
            pagina.locator('[data-form-pix]').wait_for(state='visible')
            assert pagina.locator('[data-saldo]').inner_text() == 'R$\xa00,00'
            assert pagina.locator('[data-pix]').is_hidden()
            pagina.locator('[data-valor-rapido="50"]').click()
            assert pagina.locator('[data-valor]').input_value() == '50,00'
            pagina.locator('[data-valor]').fill('25.50')
            pagina.locator('[data-cpf]').fill('52998224725')
            pagina.screenshot(path=str(ARTEFATOS/f'{largura}-{tema}-inicio.png'),full_page=True)
            pagina.locator('[data-enviar-pix]').click()
            pagina.locator('[data-pix]').wait_for(state='visible')
            assert pedidos[-1]['valor'] == '25.50', pedidos
            assert pagina.locator('[data-documento]').is_hidden()
            pagina.reload()
            pagina.locator('[data-pix]').wait_for(state='visible')
            assert pagina.locator('[data-copia]').input_value() == pix['copia_e_cola']
            assert pagina.locator('[data-qr]').is_visible()
            pagina.screenshot(path=str(ARTEFATOS/f'{largura}-{tema}-pix.png'),full_page=True)
            pagina.locator('[data-verificar]').click()
            pagina.locator('[data-pix].pix-confirmado').wait_for(state='visible')
            expect(pagina.locator('[data-saldo]')).to_have_text('R$\xa025,50')
            assert pagina.locator('[data-saldo]').inner_text() == 'R$\xa025,50'
            assert pagina.locator('[data-qr]').is_hidden()
            assert pagina.locator('[data-copiar]').is_disabled()
            assert pagina.locator('[data-extrato] img').count() == 0
            pagina.locator('[data-filtro="saidas"]').click()
            assert 'Nenhum movimento' in pagina.locator('[data-extrato]').inner_text()
            pagina.locator('[data-filtro="todos"]').click()
            with pagina.expect_download() as download: pagina.locator('[data-exportar]').click()
            download.value.save_as(str(ARTEFATOS/f'extrato-{largura}-{tema}.csv'))
            estado['cashback_lojas'] = [{'loja':'Loja teste','saldo_brl':'7.50','cupons':1}]
            pagina.locator('[data-atualizar]').click()
            expect(pagina.locator('[data-cashback]')).to_contain_text('Loja teste')
            assert pagina.evaluate('() => document.documentElement.scrollWidth <= innerWidth'), 'Rolagem horizontal'
            pagina.screenshot(path=str(ARTEFATOS/f'{largura}-{tema}-confirmado.png'),full_page=True)
            assert not erros, erros
            print(f'UI OK: {largura}px, {tema}, retomada Pix, 25.50, confirmação, filtros, CSV e texto escapado')
            contexto.close()
        navegador.close()


if __name__ == '__main__': executar()
