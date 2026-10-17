# Integração operacional — contrato desta entrega

Base imutável: 696fd21cfecf7b850a3799174e2e79bb63acb8ee. Tarefa Paperclip MEG-93; plano canônico v2.0. Este documento define implementação e simulação; não autoriza processamento, chamadas a provedores, limpeza, alteração Google, merge ou deploy. Dados reais e holds de importação permanecem intactos.

## Propriedade e interfaces

Desenvolvedor de pipeline: ReelsService, ReelsPipeline, ReelsDispatcher, reels-google-runtime, reels-runtime, entrada worker e testes respectivos. Desenvolvedor de conciliação: novo ReelsReconciliation, reels-api, cliente/componentes e testes respectivos. Orquestrador: composição web, contrato, CI integrado, packet e preparação do piloto. Alterações de interface são alinhadas entre agentes e registradas aqui pelo Orquestrador. Não editar arquivos de outro dono sem alinhar.

API preserva envelopes e idempotencyKey. Lote/todos cria operação durável com seleção congelada e progresso; o processamento de admissão ocorre em páginas limitadas e retomáveis. GET de operação é leitura, nunca despacha. POST repetido com a mesma chave recupera a operação. A interface acompanha status pending/running/completed, progresso e exclusões sem afirmar execução por mero aceite do comando.

Conciliação: GET /api/reels/reconciliations/:executionId inspeciona evidência e ações possíveis; POST /api/reels/reconciliations recebe somente identificador, chave idempotente e ação permitida. ReelsReconciliation é módulo próprio e não aceita resultado ou garantia fornecida pelo navegador. O desenvolvedor informa ao Orquestrador o construtor/métodos antes da composição. Resultados históricos sem vínculo demonstrado com a execução incerta não comprovam o desfecho.

## Despacho e recuperação

Usar as três filas e serviços existentes, sem quarta análise paga. Preferir controle de drenagem autenticado no serviço de aquisição e na fila de aquisição; alinhar alternativa antes de implementar novos recursos. IDs determinísticos, outbox persistente e precondições CAS. Resposta de criação perdida exige conciliação; 409 isolado não comprova tarefa correta. Uma interrupção entre admissão e criação de outbox precisa retomada demonstrada. Não depender de promessa em segundo plano depois da resposta web nem de scheduler para corrigir o fluxo.

Pausa bloqueia novas submissões e preserva coleta e gravação já iniciadas. Capacidade permanece ocupada para execução paga incerta até prova de término. Despacho e rotina de admissão devem reentrar após falha/reentrega sem duplicar execução paga. Concorrência técnica por etapa é distinta da configuração solicitada; orçamento é informativo.

## Evidências e travas

Processamento e despacho reais continuam desligados por padrão. O navegador não consegue habilitá-los. Testes habilitam somente dependências sintéticas em ambiente isolado no GitHub Actions, sem credenciais e sem rede de provedores. Conciliação pode reutilizar rawResult/operationName persistidos e comprovados, nunca repetir submissão paga por timeout nem liberar reserva por ausência local. Aplicação de resultado salvo deve respeitar identidade, versão, posse e publicação atual.

Cobertura integrada: uma seleção individual, lote, todos os 3.005 sintéticos, reinício do servidor/controlador, duplo clique, resposta de fila perdida, entrega duplicada, STT pendente, pausa, resultado salvo e erro em uma etapa. Nenhum teste usa IDs, análises, mídia ou manifesto privados reais.

## Piloto preparado, não executado

Preparar um pacote de ativação separado com versão/rotas fixas, preflight de identidades, configuração, filas e retenções; amostra limitada e critérios de parada. Holds atuais não são removidos nesta entrega. A preparação informa bloqueios reais e nunca declara o piloto executado ou pronto para processamento sem a ativação autorizada.

## Contratos implementados

- `reelsWebRuntime({repository,api,config,clock})` compõe service, pipeline sem adaptadores de provedor, dispatcher e reconciliation. Somente a configuração protegida `reels_runtime_version: "v2"` junto de `reels_processing_enabled: true` habilita a operação. Ausência continua fechada; combinações inválidas falham. Três rotas precisam corresponder aos serviços e filas do projeto autorizado.
- `ReelsService.command` congela `selected`, `stagePlan`, exclusões e fingerprint. Persiste o comando antes de despachar controle. Entrega incerta retorna o ID recuperável; o mesmo comando/chave retoma. `drain({operationId,pageSize:25})` avança o cursor por CAS. `ReelsCommandRunner.run({operationId,sequence})` garante a próxima entrega antes de responder. Aceite significa admissão, não conclusão de análise.
- Controle: aquisição `/tasks/control`, envelope `{operationId,sequence,outboxId}`. Etapas: `/tasks/run`, envelope `{executionId,poll,outboxId}`. O worker confirma recebimento da outbox vinculada. Criação usa FULL; conflito só se confirma comparando URL, payload, método e identidade. Tombstone ou evidência ausente continua incerto.
- `ReelsReconciliation({repository,pipeline,processingEnabled,clock})`: `inspect(executionId)` somente leitura; `command({executionId,idempotencyKey,action})`. Ações: `apply_saved_result` e `collect_saved_operation`. Recibos em `reels_reconciliations`; prova exige execução, Reel, operação, etapa, posse e hash do resultado ou mesmo nome STT. Aplicação pode retomar uma cadeia sucessora comprovada. Coleta exige posse exata e gera uma nova intenção de polling da operação já registrada, sem instalar adaptador pago na web.
- A entrada existente `serve-stage-worker.mjs` conserva os argumentos upload/transcription/analysis. `fixedStageRuntime` seleciona v2 somente por configuração explícita; a imagem carrega a dependência completa. O caminho legado permanece selecionado sem a versão v2.
- Retry exige falha vinculada à execução/etapa e comprovadamente retentável. Booleano histórico, resultado salvo e candidato recusado não liberam uma nova submissão. Pausa é revalidada antes de STT/Gemini e não impede coletar a operação já iniciada.

## Validação e publicação futura

GitHub Actions executa as suítes, o fluxo completo sintético, os navegadores e builds das imagens. Os smokes das imagens usam rede desabilitada. O novo navegador operacional usa transporte de tarefas em memória, API e componentes reais, sem adaptadores de provedores; a suíte anterior continua comprovando o bloqueio 423.

Preparação detalhada: [reels-pilot-preparation.md](reels-pilot-preparation.md). A observação das filas em 17/10/2026 encontrou `maxAttempts: 1`; o plano propõe política de reentrega para as três etapas, sem aplicar. O legado precisa conciliação explícita de ocupação: `active: []` de v2 não demonstra que reservas antigas terminaram. Permissões desconhecidas, retenções, versão ainda não publicada ou identidade não comprovada mantêm o piloto bloqueado.

Limite de recuperação: esta entrega concilia provas já vinculadas ao documento da execução. Artefato salvo somente no Storage sem recibo correspondente, ou execução histórica sem vínculo verificável, permanece retido para conferência específica. A existência de arquivo e a ausência de recibo não confirmam falha nem autorizam nova submissão.
