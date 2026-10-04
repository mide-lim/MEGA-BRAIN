# MEGA-BRAIN Google v0

Ambiente de desenvolvimento isolado. Autorização: construir o piloto Google com créditos, sem cobrança adicional autorizada. Em 2026-10-03 o proprietário determinou pausar a versão anterior e colocá-la no backlog; a pausa operacional foi executada sem excluir dados. Não retomar nem desenvolver a versão antiga. Ver docs/PROJECT-STATUS.md.

Não iniciar modelos adicionais, delegações ou automações. Usar ferramentas convencionais para builds, testes e operação. Não carregar ou registrar segredos.

O diretório web é um snapshot da aplicação atual, ainda conectado por código a PostgreSQL/R2. Não publicar esse snapshot: faltam os adaptadores Google e revisão de isolamento.

Escopo desta etapa: inventário somente de leitura da produção, documentação, planejamento de amostra e controles testáveis sem chamadas pagas. Saldo e validade foram confirmados pelo proprietário. O proprietário autorizou explicitamente a vinculação do projeto isolado à conta de cobrança e a habilitação das APIs Google, mantendo uploads, workloads e chamadas pagas desligados. Contas de serviço e IAM pertencem apenas ao novo projeto. Nenhum recurso pago deve ser provisionado, migrado ou executado nesta etapa de configuração.

Desenvolvimento e deploy usam projeto Google dedicado, banco, buckets, identidades e callback próprios. O projeto megabrain-stt e a VPS permanecem como fontes somente de leitura nesta etapa.

Não criar vínculo operacional entre versões: nenhum fallback para banco/serviços antigos, importação runtime do snapshot web, sincronização contínua ou compartilhamento de segredos de serviço. Reaproveitamento é cópia pontual verificada com importador transitório; o artefato Google não contém o snapshot histórico nem credenciais R2. A conta de faturamento compartilhada não altera esse isolamento.

O proprietário confirmou que o acervo Cloudflare deve ser preservado e a arquitetura nova persistirá integralmente no Google. Não migrar o acervo antigo por padrão. Novas mídias, transcrições e análises usam Storage Google; banco, fila e controles também são Google. O importador histórico é opcional e fica fora do runtime.

Uma migração preserva originais e transcrições, usa checksum e nunca remove a origem. Vídeos sem áudio esperado precisam de diagnóstico; uma cópia fiel não os corrige.

Na continuação de 2026-10-03, o proprietário pediu avançar na base Google e concentrar testes ao fechar integrações. Configurar buckets vazios privados, Firestore Standard com free tier e fila vazia pausada mantém uploads, workloads e inferências desligados. Não usar essa configuração como autorização para iniciar consumo pago ou migrar Cloudflare. Preservar testes existentes; executar apenas verificações direcionadas durante integração, com suíte ampla no fechamento.

Validar com: node --test tests/*.test.mjs web/tests/*.test.mjs e node scripts/preflight.mjs config/pilot.json.

## Autorização vigente — 2026-10-04

O proprietário autorizou publicar os serviços isolados e executar um piloto de até 20 vídeos, um por vez, reservando até R$ 150 dos créditos Google para implantação, transcrição, análise e armazenamento por até 30 dias. Essa autorização substitui a restrição anterior de configuração sem consumo somente nesse escopo. Não autoriza despesas fora dos créditos, piloto de 100 nem expansão ao acervo inteiro. Manter a versão antiga pausada e preservar os originais Cloudflare. O aceite jurídico da identidade OAuth deve ser concluído pessoalmente pelo proprietário conforme rejeição da revisão automática.

## Autorização vigente — livro de conhecimento

Em 04/10/2026, após a proposta de até R$50 adicionais, o proprietário autorizou novas análises dos 19 vídeos verificados. Envelope preventivo total R$200 em créditos, concorrência 1, apenas revisão v3; reutilizar mídias e STT já persistidos. Preservar histórico. Não autoriza expansão para 100/3 mil vídeos nem gastos fora dos créditos.
