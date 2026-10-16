# Três filas e três workers

O download, a transcrição e a análise passam a ter serviços e filas separados. Os três usam a mesma imagem existente, com a etapa fixa no comando do processo. Este PR entrega o código e o exemplo de configuração; não cria recursos nem muda o fluxo em produção.

| Etapa | Fila | Comando na imagem |
| --- | --- | --- |
| Aquisição e preparo | `v0-acquisition` | `node /app/scripts/serve-stage-worker.mjs upload` |
| Transcrição e consulta da operação | `v0-transcription` | `node /app/scripts/serve-stage-worker.mjs transcription` |
| Análise e publicação do resultado | `v0-analysis` | `node /app/scripts/serve-stage-worker.mjs analysis` |

## O que é reaproveitado

O `WorkerFlow`, os adaptadores de download/STT/análise, os documentos de vídeo, os artefatos no Storage, o controle financeiro, os IDs determinísticos, a prova de encerramento e o limite de aquisição continuam existentes. A separação acrescenta roteamento e restrição de etapa; não cria outro motor de processamento.

O worker de aquisição também recebe a admissão já existente em `/tasks/admit`. Todos recebem suas tarefas em `/tasks/run`, com autenticação OIDC e audiência do serviço de destino. Uma tarefa de outra etapa é recusada antes do acesso ao banco ou ao provedor. As rotas assistidas e de diagnóstico do serviço antigo não pertencem aos novos workers. Não há quarto coordenador nem painel novo.

## Persistência, duplicatas e falhas

1. Aquisição grava mídia e conclui a etapa antes de enfileirar transcrição.
2. Transcrição grava o nome da operação assíncrona antes da primeira consulta. As consultas ficam na fila de transcrição e reutilizam essa operação. O texto e a conclusão financeira precedem o envio à análise.
3. Análise grava e publica o resultado usando o fluxo existente. Não há sucessor após a conclusão.

A outbox conserva os IDs atuais. Entrega duplicada reutiliza trabalho concluído, sem submeter novamente STT/análise. Se o resultado da operação ou da cobrança for incerto, o trabalho permanece retido para conferência. Não há retry pago automático por conta desta separação.

Uma outbox antiga com o mesmo ID e outra fila retorna `requires_queue_migration`, sem reescrever a prova nem reenfileirar. Esse bloqueio exige conferência na migração; não apagar claims, trocar IDs ou reenviar registros para contorná-lo. Uma falha de entrega depois da persistência conserva a conclusão para retomada segura.

## Áudio preparado e reutilizado

Nos novos workers, a aquisição prepara o FLAC a partir do MP4 local e grava o objeto imutável antes de entregar à transcrição. A referência conserva caminho, geração, bytes, checksum e caminho/geração do MP4 de origem. A transcrição verifica essa ligação e lê somente a geração de áudio registrada; não baixa novamente o MP4 nem converte outra vez.

Para manter os nomes de operação já existentes, o áudio usa o mesmo caminho canônico que o adaptador STT já utilizava. Um legado sem referência pode preparar e registrar o áudio antes da submissão; referências parciais, fonte divergente ou objeto órfão exigem conferência, sem sobrescrita ou chamada STT. Uma falha depois de submeter ao provedor continua incerta; preparar/reutilizar áudio não autoriza reenviar trabalho pago.

O caminho assistido legado continua limitado ao MP4. Esta mudança não amplia seu escopo, não migra artefatos antigos nem libera reservas.

## Pausar novas transcrições e coletar resultados

Usar o controle existente `settings/automation.transcription_enabled=false` para pausar novas submissões. Com a automação global habilitada, a coleta consulta o nome de operação já persistido e conserva a reserva existente; não inicia outra transcrição. Não é necessário adicionar outro botão ou uma nova configuração neste PR.

`settings/automation.enabled=false`, o serviço desabilitado e os bloqueios financeiros/de lote/de escopo continuam sendo paradas gerais. Um bloqueio detectado antes de consultar não transforma uma operação aguardando resultado em falha incerta. Pausar a fila inteira também pausa a coleta; para colher operações, manter sua entrega disponível e usar o controle de novas submissões.

Uma tarefa de submissão recebida durante a pausa não inicia STT nem reserva dinheiro. A inspeção e a retomada explícita existentes em WorkerRecovery permitem retomar esse trabalho após a despausa com nova intenção de entrega, mantendo o mesmo ID de execução paga. A retomada de uma consulta conhecida também funciona durante a pausa de novas submissões. Nenhuma dessas retomadas é acionada automaticamente por este PR.

A retomada segue os registros e os controles existentes. Não apagar outboxes/claims nem reenfileirar chamadas incertas para contornar uma pausa. As validações aqui são locais e não ativam nenhum controle de produção.

## Configuração e ativação posterior

O exemplo [stage-workers.example.json](../google-v0/config/stage-workers.example.json) é descritivo: nomes de origem são exemplos, a imagem precisa ser construída, as três filas estão pausadas e os serviços têm entradas fechadas. Os overrides precisam ser combinados com a configuração privada revisada existente; o arquivo não é uma configuração completa de execução.

Cada processo exige `worker_stage`, `worker_origin`, as três `stage_routes` e os booleanos explícitos `enabled`, `dispatch_enabled`, `admission_enabled`. Só aquisição pode admitir novos vídeos. Os controles assistidos devem estar desligados nos novos serviços. A configuração de etapa é recusada no entrypoint legado, para impedir retorno silencioso à fila antiga.

Preservar as quotes, preset/revisão, escopo de vídeos, lote e controles existentes. O controle `uploads_enabled` permanece com a semântica atual de autorização dos adaptadores; não foi renomeado nem removido. A imagem mantém a identidade de serviço existente, sem alterações de IAM neste PR. O comando padrão legado da imagem também permanece disponível para a operação atual.

Na publicação futura, cada serviço terá concorrência1, máximo1 instância e cada fila terá no máximo1 despacho simultâneo. O limite persistido de aquisição também deve ser conferido em1; são controles distintos. Filas diferentes permitem administrar as etapas separadamente, mas não autorizam aumentar os limites financeiros nem reenviar operações incertas.

Antes do corte, as tarefas existentes MEG-94 e MEG-99 precisam confirmar o inventário e a destinação das pendências. Manter os produtores antigos fechados; conferir destinos, autenticação, operações e artefatos já persistidos antes de direcionar qualquer registro. Validar primeiro sem rede e depois, com autorização própria, uma amostra real delimitada. Para reversão, fechar entradas e pausar as novas filas preservando dados; não religar consumidores antigos enquanto houver trabalho em curso nas novas etapas.

## Validação entregue

Os testes das etapas usam o fluxo e os controles financeiros reais com armazenamento/provedores simulados. Cobrem persistência antes do envio, operação STT reutilizada, duplicatas, falhas incertas, tarefa em etapa errada, outbox antiga e percurso completo. O smoke da imagem inicia os três entrypoints com configuração sintética fechada, sem credenciais e sem rede externa.

A suíte anterior e o smoke do worker legado continuam no CI. Esses testes demonstram integração de código e compatibilidade; não comprovam disponibilidade de download no Instagram nem substituem validação autorizada no ambiente real. Não houve conciliação, liberação de reserva, aquisição, análise ou deploy por esta implementação.
