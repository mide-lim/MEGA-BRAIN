# Preparação do piloto de operação web

Esta entrega prepara a proposta. Não executa piloto, consulta Google, publica imagens, altera filas/IAM, libera reservas, remove holds ou processa Reels. A autorização de implementação de MEG-93 não autoriza ativação. O orçamento continua informativo.

O módulo puro `lib/reels-pilot-readiness.mjs` exporta `prepareReelsPilot({candidateCommit, observation, now})`. `candidateCommit` exige SHA completo em minúsculas; `now` é um timestamp em milissegundos para testes. A saída é uma projeção de campos fixos: nunca copia IDs, nomes de recurso, análises ou conteúdo arbitrário da observação. Um resultado com verificações atendidas continua `prepared_not_run`, `processAuthorized:false` e `activationAllowed:false`.

A ferramenta lê somente um JSON sanitizado de até 1 MiB e imprime a proposta em stdout:

```sh
node google-v0/scripts/prepare-reels-pilot.mjs --observation /caminho/privado/observacao-sanitizada.json --candidate aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
```

O SHA acima é sintético. O Orquestrador gera a proposta privada depois do commit final. Código de saída 0 significa pré-requisitos técnicos atendidos na observação fornecida; 2 significa proposta com bloqueadores; 1 significa entrada inválida. Nenhum desses resultados autoriza execução. Não existe opção `--apply` nem acesso de rede.

## Contrato da observação sanitizada

- `schemaVersion:1`, `candidateCommit` exato e `observedAt` em ISO: observação atual, até 15 minutos, sem datas futuras.
- `processingEnabled:false`, `dispatchEnabled:false`: publicação inicial e estado observado mantêm as duas portas fechadas. Ausência ou qualquer outro valor bloqueia.
- `bindings`: `web`, `acquisition`, `transcription`, `analysis` booleanos. `true` só após comprovar imagem/entrada/rotas do candidato exato; compatibilidade desconhecida ou imagem antiga permanece `false` até publicação autorizada.
- `queues`: uma observação por `stage` (`acquisition`, `transcription`, `analysis`), com `paused:true`, `taskCount:0` e `retryPolicy` numérica no formato abaixo. Uma fila duplicada ou desconhecida não substitui uma das três.
- `iam`: `effectivePermissionsObserved:true`, `observedAt` atual e booleanos `tasksCreate`, `tasksGet`, `tasksFullView`, `actAs`, `runInvoker`, `firestore`. `true` representa evidência efetiva para os sujeitos/recursos do pacote privado, nunca apenas um papel configurado. Ausência/`unknown` bloqueia.
- `legacyOccupancyReconciled:true` e `proofFreshAt` atual: prova explícita da conciliação de ocupações e reservas legadas com v2. `active:[]` de v2, silêncio ou metadados de fila vazia não suprem essa prova.
- `candidates`: `count:1`, `unheld:true`, `identityBound:true`, `noActiveOrUncertain:true`. A identidade e a versão ficam no pacote privado; nenhum ID real entra no repositório. Holds não são removidos pela preparação.
- `concurrency:1`: proposta inicial limitada a um executor por etapa.

## Política proposta, nunca aplicada

Somente as três filas das etapas recebem esta proposta: `maxAttempts:20`, `maxRetryDurationSeconds:3600`, `minBackoffSeconds:10`, `maxBackoffSeconds:60`. Uma observação com `maxAttempts:1` gera bloqueador individual em cada etapa. A fila antiga `v0-processing` permanece intacta e fora dessa proposta. A alteração futura depende de autorização explícita e nova verificação de metadados.

A repetição limitada serve à entrega autenticada, ao controle e à recuperação durável. Não autoriza nova inferência: execução paga incerta permanece ocupada e exige conciliação com o mesmo identificador. Depois da janela de repetição, uma tarefa expirada exige diagnóstico por evidência, sem concluir falha paga por ausência local.

## Sequência futura sujeita a autorização

1. Fixar o commit revisado, resultados Actions e imagem; reunir observações atuais e resolver cada bloqueador. Manter evidências de sujeitos IAM, recursos, IDs/versões e acervo no diretório privado do Orquestrador.
2. Obter autorização correspondente para publicação e alterações de configuração concretas. Publicar inicialmente com processamento e despacho desabilitados, mantendo filas fechadas e holds existentes.
3. Reobservar imagens/entradas/rotas, permissões efetivas, políticas e ocupações. Fixar uma amostra privada de um cadastro elegível, sem execução ativa/incerta ou hold, e concorrência um por etapa. Uma retenção existente não é removida implicitamente para obter a amostra.
4. Pedir autorização separada de ativação do candidato exato e da amostra. Só então executar o plano operacional revisado, acompanhar os três estágios e preservar evidência. A ferramenta desta entrega não implementa essa ativação.
5. Interromper novas entradas diante de duplicação paga, resultado incerto, divergência de posse/versão, falha compartilhada ou perda de persistência. Manter coleta e gravação de operações já enviadas, conservando acervo, publicação, candidatos e reservas.

A reversão suspende novas entradas e despacho; não apaga tarefas, registros ou artefatos e não libera ocupação por timeout. Uma reversão de imagem exige versão revisada e autorização correspondente. Esta preparação não comprova operação ao vivo; os testes são sintéticos e executados exclusivamente no GitHub Actions.
