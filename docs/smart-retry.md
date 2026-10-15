# Retomada explícita dos Reels

A retomada é uma ação do proprietário. Inspecionar um vídeo não apaga falhas, não libera reservas, não cria chamadas ao modelo e não altera a fila.

## Decisão por etapa

| Evidência atual | Ação |
| --- | --- |
| Análise aceita | Nenhuma nova execução |
| Resposta original salva no Storage | Reavaliar e persistir a mesma resposta e geração, sem inferência |
| Transcrição assíncrona com nome persistido | Consultar a operação existente |
| Etapa bloqueada antes de reserva ou submissão | Preservar diagnóstico, adquirir novamente a etapa e despachar |
| Download falhou sem mídia e seu custo preventivo já foi contabilizado | Uma tentativa filha, com autorização durável e cobertura própria |
| Gemini rejeitou o esquema com HTTP 400 confirmado, sem resultado | Uma tentativa filha na mesma revisão corrigida, reutilizando mídia e STT |
| Timeout, resultado desconhecido ou artefato sem confirmação | Reconciliação; ausência de resposta não autoriza repetir inferência |

`SmartRetry.inspect` resolve a revisão de análise vigente; não confunde os IDs v0, v3 e v4. O chamador injeta `googleOperations.inspectAnalysisArtifact` como `artifactInspector` para procurar o resultado original antes de propor uma inferência. `request` exige identificador de solicitação e referência de autorização explícita. Esses valores vêm do serviço autenticado que receberá o futuro botão; não se deve expor esta classe a um cliente sem validar a ação do proprietário. Esta entrega não adiciona o botão nem uma rota pública.

A autorização da tentativa filha tem validade de uma hora, digest do erro, vídeo, etapa, orçamento e referência da ação. O worker e o livro financeiro conferem novamente essas informações. A identidade da filha depende da tentativa original e permite somente uma recuperação. Novos cliques, entregas concorrentes e identificadores novos não multiplicam chamadas. Uma filha interrompida fica retida para diagnóstico; quando sua resposta está salva, a reconciliação pode persistir essa mesma resposta, sem autorizar outra inferência.

O livro original e os custos já contabilizados são preservados. A recuperação de download ou do esquema recebe uma reserva adicional dentro dos créditos e do teto existentes. Reconciliar uma resposta já contabilizada não cobra novamente. A reconciliação de dados salvos também funciona com fila e consumo pausados e mantém essa pausa.

`WorkerFlow.reconcileAnalysis` recebe opcionalmente `executionId`, limitado à execução original da revisão atual ou à sua filha determinística conferida, e lê a resposta pelo número de geração, verifica revisão e modelo, reaplica as regras de qualidade e persiste o resultado ou candidato. Uma falha de persistência retém a resposta e pode ser retomada explicitamente. Candidatos inválidos não substituem uma análise publicada. Nenhum dado desconhecido é promovido a conhecimento válido. Análises concluídas de outras revisões permanecem como histórico; trabalhos ativos/incertos ou outra execução da mesma revisão bloqueiam a reconciliação. A resposta da filha usa a própria reserva e mantém o pai intacto.

Quando há resposta salva, mas o claim continua `started` após perda do processo, a recuperação exige `verifyExecutionStopped` injetado pelo chamador confiável no servidor. Ele deve conferir que a execução anterior terminou e devolver `{ended: true, execution_id, claim_update_time, evidence_ref}`, vinculando a evidência ao ID e à versão atual do claim. Arquivo salvo, pausa global ou tempo decorrido não comprovam encerramento. Sem verificador, confirmação negativa/indisponível ou prova divergente, retorna `execution_stop_unconfirmed` sem gravar nem enfileirar. A prova permitida é registrada no claim; seu compare-and-set continua obrigatório antes de alterar vídeo/financeiro. Não aceitar esse comprovante diretamente do cliente ou preencher o verificador com um `true` fixo. O runtime conecta esse contrato ao adaptador interno `ExecutionStops`, descrito abaixo; a recuperação continua assistida, sem rota pública ou despacho automático.


### Comprovante interno de encerramento (MEG-100)

O servidor gera `execution_attempt_id` com UUID ao adquirir cada tentativa de análise e grava essa identidade e a revisão no claim antes de chamar adaptadores. O `finally` de `WorkerFlow.run` só produz o comprovante depois de aguardar operação, persistência e tratamento de erro. Os adaptadores reais devem aguardar também sua limpeza; não é permitido trabalho de análise em segundo plano após resolver o callback. Desconexão HTTP não encerra essa função nem gera prova antecipada. Timeout, pausa, idade e artefato salvo não são fontes de prova.

A evidência create-only fica em `execution_stops/<execution_id>_<attempt_id>` no Firestore existente, com vídeo, etapa, revisão, versão exata do claim e data de saída. O verificador deriva o caminho da identidade interna e confere todos esses campos. Não recebe comprovantes de payload, não consulta serviços antigos e não precisa de serviço, fila, cron ou permissão IAM nova. O acesso de escrita continua restrito aos componentes internos com a identidade Firestore já existente; nenhuma rota de cliente foi adicionada.

No runtime integrado, claims `started` ou `uncertain` e claims concluídos ainda pendentes de reconciliação exigem a prova; até um `uncertain` pode estar com tratamento de erro ativo. Registros antigos sem identidade interna/comprovante não são liberados por ausência desses campos. A restauração permanece limitada à própria execução/geração e usa o compare-and-set existente antes de alterar vídeo ou livro financeiro. A prova verificada é preservada como auditoria em `reconciliation_stop_proof`. Retomadas em `reconciling_result` ou `reconciliation_failed` também exigem verificação: a identidade da tentativa e a auditoria de aquisição devem corresponder ao comprovante original imutável (execução, vídeo, etapa, revisão, referência e versão anterior ao primeiro CAS). O CAS da retomada usa a versão atual do claim; a auditoria original não é regravada com essa versão nova. Assim, interrupções repetidas mantêm a retomada idempotente comprovada, enquanto status legado sem prova ou evidência indisponível/divergente bloqueia antes da restauração e das gravações.

Morte abrupta antes do `finally`, escrita de prova indisponível ou registro antigo `started` sem identidade/comprovante continuam bloqueados. Não criar atestados retroativos por idade, timeout ou declaração manual. Esta primeira integração não oferece importação de evidência externa: confirmar externamente uma morte abrupta exigiria caminho interno próprio e evidência positiva vinculada à tentativa, fora desta entrega. Uma falha ao gravar a prova não mascara o resultado/erro da tentativa nem libera replay. A coleção só é escrita quando o código for executado; a implementação e os testes offline não criam dados em produção.

Um vídeo aceito não é reportado como concluído enquanto o claim ou a reserva da análise configurada estiverem pendentes. Quando a filha determinística já concluiu seu claim e sua reserva, publicou a própria chave/geração aceita e mantém o vínculo com o pai integralmente contabilizado, o pai incerto permanece como histórico e não impede reconhecer a conclusão. Essa decisão independe do inspetor de artefatos e do adaptador de reconciliação; vínculos ou registros incompletos continuam exigindo conferência. Revisão ausente e `null` representam a mesma identidade v0 na comparação de concorrência.

Para uma etapa bloqueada sem submissão, `request` grava `retry_ready` e a identidade de recuperação antes do despacho. Uma interrupção nesse ponto permite continuar a mesma solicitação. Cliques posteriores reutilizam a identidade persistida, inclusive com IDs de solicitação diferentes; um outbox existente, inclusive incerto, não é reenviado. Registros `retry_ready` antigos sem essa identidade devem ser retomados com o identificador original da solicitação.

## Diagnóstico e aquisição

O extrator passa a identificar resposta vazia de mídia como falha procedural, sem afirmar que o Reel foi removido ou está privado. Quando o download fornece uma descrição válida do mesmo Reel, ela é capturada na mesma extração e reaproveitada na análise. Os metadados brutos ficam somente na pasta temporária, removida ao final; URLs assinadas e saída bruta da ferramenta não são persistidas no diagnóstico.

## Operação e publicação

A fotografia e a operação de 14/10/2026 são registradas separadamente nos recibos do operador. Os vídeos já aceitos não entram na retomada. A autorização de retry não aumenta o teto financeiro. Não reenfileirar resultados incertos sem procurar o artefato original e conferir a etapa.

Antes de publicar, executar os testes e a revisão independente exigida pela [política de revisão](REVIEW_POLICY.md). Merge e deploy exigem autorização específica. O botão futuro deve apresentar a etapa que será retomada e o motivo quando a ação exige reconciliação, usar o serviço autenticado e reutilizar a mesma solicitação enquanto ela estiver pendente.
