# Carteira do motorista

Disponível em `/painel/carteira.html`, exclusivamente para contas de motorista.

O saldo entra por **três formas**: Pix, boleto e cartão. Não existe campo de
saldo: ele é a soma de `carteira_lancamentos`, então não há número guardado que
possa divergir do extrato.

**Cartão não passa por aqui.** A cobrança é criada por nós, mas o número é
digitado no checkout hospedado da Asaas (o `invoiceUrl` que toda cobrança
devolve). Nenhum dado de cartão entra neste servidor — o que mantém o projeto
inteiro fora do escopo do PCI-DSS. Receber o número aqui para repassar seria
menos código numa tela e muito mais responsabilidade em tudo: log, memória,
backup, e a hospedagem no meio.

Cashback é apresentado por loja, usando cupons ainda válidos de sessões
vinculadas à conta (`clientes.usuario_id`); não é dinheiro sacável e não entra
no saldo.

## Configurar no Render

- `ASAAS_API_KEY`: chave da conta Asaas, apenas no servidor.
- `ASAAS_WEBHOOK_TOKEN`: o mesmo token configurado na Asaas.
- `ASAAS_API_BASE`: opcional; vazio detecta produção pelo prefixo
  `$aact_prod_` e sandbox pelo prefixo `$aact_hmlg_`. Se preenchido, use
  `https://api.asaas.com/v3` ou `https://api-sandbox.asaas.com/v3`.
- `WALLET_DEMO_MODE=0`: mantenha desativado em produção. Em sandbox,
  `1` permite um único crédito fictício por motorista.

Webhook: `https://smartcharge.ia.br/webhooks/asaas`.

O `.env` local não é enviado ao Render. No serviço que atende o domínio,
abra Environment e configure as duas variáveis secretas acima, depois
escolha Save and deploy. Apenas Save only não ativa os valores no processo
que já está rodando. Os campos `sync: false` do Blueprint documentam os
nomes, mas não preenchem segredos em serviços que já existem.
A sonda `/saude` informa as pendências de configuração sem expor valores.

Selecione `PAYMENT_CONFIRMED`, `PAYMENT_RECEIVED`, `PAYMENT_OVERDUE`,
`PAYMENT_DELETED`, `PAYMENT_REFUNDED`, `PAYMENT_PARTIALLY_REFUNDED`,
`PAYMENT_UPDATED` e `PAYMENT_RESTORED`.

E mais três, que só existem no cartão: `PAYMENT_CHARGEBACK_REQUESTED`,
`PAYMENT_CHARGEBACK_DISPUTE` e `PAYMENT_AWAITING_CHARGEBACK_REVERSAL`. Sem eles
o webhook respondia "ignorado" e a pessoa ficava com o saldo enquanto o dinheiro
era retirado da nossa conta — um jeito silencioso de sacar dinheiro da empresa.
O tratamento é o mesmo de um estorno; a maquinaria já existia, só não era
alcançada por esses status porque antes não havia cartão.

A implementação segue a [autenticação oficial](https://docs.asaas.com/docs/authentication),
os [eventos de cobrança](https://docs.asaas.com/docs/payment-events) e o
[estado dos estornos](https://docs.asaas.com/docs/refunds).

## Comportamento

Uma cobrança pendente do mesmo valor **e da mesma forma** é reutilizada — um
boleto em aberto não impede gerar um Pix para pagar agora, que é justamente o
caso de quem desistiu de esperar a compensação. Cobranças de outro valor podem
ser criadas e aparecem no histórico. Fechar o código na tela não cancela a
cobrança.

O boleto vence em três dias; Pix e cartão são na hora. Para o boleto,
`expiracao_em` recebe o vencimento — é a mesma pergunta que a coluna já
respondia para o Pix, e reaproveitar faz a recuperação de pendente funcionar de
graça: enquanto não vencer, pedir outro devolve o mesmo em vez de emitir dois.
A validade é a retornada pela Asaas; não é um prazo inventado pelo aplicativo.

O navegador consulta apenas o estado local a cada seis segundos enquanto
a tela está visível. “Já paguei” consulta o pagamento na Asaas e reconcilia o
extrato. O webhook também consulta o estado atual, evitando aplicar um evento
antigo por cima de um estorno. Crédito e devoluções têm referências únicas.
Estornos parciais consideram somente devoluções `DONE` e somente a diferença
ainda não lançada. A carteira não solicita estornos nem transfere dinheiro.

Cadastro, referência de criação e cobrança são persistidos em etapas antes
da consulta do QR Code. Uma retomada busca a referência externa antes de
criar outra cobrança. Eventos antecipados da carteira recebem 503 e não são
marcados como processados; a Asaas pode reenviar depois da gravação.
Uma indisponibilidade ambígua do provedor ainda exige conferência por referência
na Asaas: o aplicativo não presume uma garantia de idempotência externa.

## Validação

`pip install -r requirements-dev.txt`  (precisa do `httpx2`, ver CONTRIBUTING.md)

`python -m unittest discover -s tests -v`

Os testes não usam banco remoto nem dinheiro real. Antes de movimentar dinheiro,
valide na sua conta sandbox criação, pagamento, webhook repetido, retomada do QR
e estorno. O schema adiciona colunas, sem reescrever dados de carteira.

O pagamento das recargas pela carteira ainda depende da integração operacional
com os carregadores. Esta versão adiciona e reconcilia saldo e mostra cashback
já vinculado ao motorista; não simula débitos nem inventa sessões.
