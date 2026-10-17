# Preparação do piloto de operação web

A preparação distingue prova técnica de pré-ativação, elegibilidade atual e autorização de execução. Uma amostra pode estar tecnicamente preparada enquanto continua retida e inelegível. Nenhuma saída desta ferramenta ativa processamento, despacha tarefas ou libera holds/reservas. Orçamento permanece informativo.

O módulo puro `lib/reels-pilot-readiness.mjs` exporta `prepareReelsPilot({candidateCommit, observation, now})`. A saída usa campos fixos, sem reproduzir IDs, recursos, conteúdo de provedores ou caminhos privados. Mesmo quando `technicalPreflightReady:true`, mantém `executionReady:false`, `currentEligible:false`, `releaseRequired:true`, `processAuthorized:false` e `activationAllowed:false`. `technicalPrerequisitesMet` é alias do preparo técnico, para compatibilidade.

A CLI lê JSON sanitizado de até 1 MiB, sem rede ou opção de aplicação:

```sh
node google-v0/scripts/prepare-reels-pilot.mjs --observation /caminho/privado/observacao-sanitizada.json --candidate aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
```

O SHA é sintético. Código 0 indica preparo técnico na observação; 2 indica bloqueadores; 1 indica entrada inválida. Não significa teste real ou autorização.

## Observação sanitizada versão 2

- `schemaVersion:2`, `mode:"pre_activation"`, `candidateCommit` SHA completo exato e `observedAt` ISO, até 15 minutos e sem data futura.
- `processingEnabled:false` e `dispatchEnabled:false`, comprovados no runtime confiável. `bindings` contém booleanos para `web`, `acquisition`, `transcription`, `analysis`, positivos somente com imagem/entrada/rotas do candidato exato comprovadas. Código ainda não publicado mantém bloqueador de binding.
- `queues`: exatamente uma entrada por etapa, `state:"RUNNING"` ou `"PAUSED"`, `taskCount:0`, `maxConcurrentDispatches:1` e `retryPolicy` numérica: `maxAttempts:20`, `maxRetryDurationSeconds:3600`, `minBackoffSeconds:10`, `maxBackoffSeconds:60`, `maxDoublings:3`. RUNNING vazio é aceitável somente com runtime e despacho comprovadamente fechados. Fila vazia não prova término de executor.
- `iam`: `effectivePermissionsObserved:true`, `observedAt` atual e `tasksCreate`, `tasksGet`, `tasksFullView`, `actAs`, `runInvoker`, `firestore` positivos, vinculados aos sujeitos/recursos do pacote privado. Papel configurado, erro ou unknown não prova acesso efetivo.
- `candidates`: `count:1`, `registered:true`, `currentHeld:true`, `currentEligible:false`, `identityAndVersionBound:true`. Documento e updateTime exatos permanecem privados.
- `isolation`: `observedAt` atual, `proofKind:"positive_per_sample_inventory"`, `evidenceDigest` SHA256 do recibo privado, `legacyUncertainRemaining` inteiro não negativo e todos os booleanos abaixo positivos.
- `holdReleasePlan`: `count:1`, `exactIdentityAndVersionBound:true`, `compareAndSetRequired:true`, `onlyImportHoldActive:true`, `authorizationRequired:true`, `applied:false`. A futura operação limita-se a `import_hold.active` do documento/versão privados; a ferramenta não a implementa.
- `concurrency:1` por etapa.

Os booleanos obrigatórios do isolamento são `identityAndVersionBound`, `enumeratedScopeComplete`, `noLegacyJobOrClaimOverlap`, `noDispatchOrAdmissionOverlap`, `noFinancialOrCapacityOverlap`, `noV2ExecutionOrOutboxOverlap`, `noSavedMediaOrPaidResultOverlap`, `namespaceBoundariesVerified`, `legacyUncertainPreserved`.

Essa observação deve ser gerada de GETs autenticados e selecionados, com inventários completos no escopo declarado e hashes privados verificáveis: Reel/hold/updateTime, jobs/claims/tentativas, stops correspondentes, despacho/intents, reservas/financeiro/capacidade, execuções/outbox v2, referências de mídia/resultados e limites dos namespaces. Hash de capacidade opaco exige reconstrução comprovada; reutilizar a reconstrução anterior somente se manifestos, fragmentos, payloads e versões atuais forem exatamente iguais. Datas de sincronização não renovam observações antigas.

O avaliador puro valida o contrato fornecido; ele não autentica JSON nem converte flags ou digest em atestado. O Orquestrador e o Revisor verificam procedência e completude privadas. Prova ausente/desconhecida bloqueia. IDs reais nunca entram no GitHub.

## Legado preservado e recuperação limitada

A conciliação global não é condição fictícia para uma amostra comprovadamente disjunta. `legacyOccupancyReconciled:false` permanece na saída; `legacyUncertainRemaining` registra o conjunto retido, com data/origem no recibo privado. Isso não declara que executores incertos continuam vivos, nem os encerra. Lease vencido, timeout, v2 vazio e fila vazia nunca provam parada paga.

Os parâmetros20 tentativas e3600s são condições conjuntas do Cloud Tasks: não são um teto estrito de20entregas nem uma parada garantida em1hora. Retries podem ultrapassar um desses valores até satisfazer ambos. A segurança das submissões pagas depende da idempotência, posse e evidência duráveis dos workers. A reentrega da fila recupera controle/persistência; não autoriza inferência repetida. O pipeline usa execução/outbox determinísticos, CAS de posse e resultados salvos antes de publicar. Executor interrompido após possível envio vira incerto e retém capacidade. STT conhecido é coletado pelo mesmo nome; resultado salvo é reaplicado por evidência vinculada. Controle retoma cursor durável e exige continuação confirmada.

`ops/prepare-reels-queue-recovery.py` captura as quatro filas, os quatro serviços fechados e o worker legado somente para comprovar preservação. O fingerprint inclui `stackdriverLoggingConfig` de cada fila. As imagens dos cinco serviços devem coincidir exatamente com a allowlist da publicação PR61 revisada; um digest desconhecido é bloqueado mesmo com fencev2. O operador revisa o fingerprint do snapshot privado e usa aplicação separada somente dentro da autorização correspondente. Só existem PATCHes de configuração das três filas existentes: retryConfig `20/3600s/10s/60s/maxDoublings3` e concorrência1; taxa, estado e fila legada são preservados. Não cria tarefa/fila, retoma fila, chama worker/provedor, altera dados/IAM ou libera hold.

Antes de cada PATCH e depois dele, releituras exigem filas vazias, legacy PAUSED e quatro serviços estáveis com tráfego100% na revisão imutável fechada `MEGABRAIN_REELS_CLOSED_RELEASE=v2`. A revisão servida, imagem e fence entram no fingerprint; revisão e imagem legadas são comparadas sem exigir o fence da versão nova. Os nomes de revisão seguem `projects/.../services/<service>/revisions/<revision>` e são vinculados ao serviço antes de qualquer GET. O transporte descarta todos os demais valores de ambiente. Snapshot expira em15min. Divergência ou resposta incerta interrompe; não há rollback/retry cego. Cloud Tasks não oferece ETag de fila: o fingerprint detecta drift nas releituras, mas não é CAS atômico entre serviços.

## Próxima autorização operacional

1. Revisar candidato exato, CI Actions, recibos privados de IAM/isolamento e alterações limitadas de filas. Publicação de código exige autorização do pacote concreto.
2. Publicar somente o pacote autorizado, inicialmente fechado, e reobservar imagem/rotas, IAM, políticas, amostra/versão e isolamento.
3. Obter autorização separada para liberar somente o hold da amostra por CAS e processar exatamente um Reel. Todas as demais retenções permanecem protegidas.
4. Na execução autorizada, interromper novas entradas por duplicação paga, resultado incerto, divergência de posse/versão, falha compartilhada ou perda de persistência. Preservar coleta e resultados de operações já enviadas.

Reversão suspende novas entradas/despacho sem apagar acervo, tarefas, resultados, candidatos ou reservas. Reversão de imagem tem versão revisada e autorização própria. Testes sintéticos são executados exclusivamente no GitHub Actions; não comprovam processamento real.
