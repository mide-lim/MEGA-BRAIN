# Recorrência finita de Reels — MB-REELS-RECURRENCE-IMPLEMENT-20261029-027

Implementação offline, sem admissão operacional executada. Primeiro lote real
continua **PENDING**, dependendo de aprovação humana consolidada. Nenhuma nova
chamada paga é autorizada por este documento. Instruções históricas permanecem
históricas; o Prompt Master atual prevalece.

## Arquitetura e limites

`operations/reels-pilot/recurrence.py` usa o mesmo `attempts.sqlite3`, identidade
privada de arquivo/diretório verificada pelo Ledger, transações BEGIN IMMEDIATE,
FULL synchronous e tabelas adicionais `recurrence_batches`, `recurrence_members`,
`recurrence_slot`. Não há daemon, timer, scheduler, banco alternativo, lease,
retry, fallback, refund ou promoção ACCEPTED. Cada invocação `run-one` executa
somente um membro, nunca inicia o seguinte. O slot de recorrência permanece
ocupado mesmo depois de o Pipeline liberar `pilot_slot` por persistência.
Slots existentes e qualquer tentativa histórica não PERSISTED bloqueiam claim.
Não se alteram reservas/linhas históricas, inclusive as reservas históricas.

Estados: PENDING → AUTHORIZED → RUNNING → PERSISTED → NEEDS_REVIEW/FAILED.
UNKNOWN/RESERVED/ausência de tentativa após claim → BLOCKED sem reenvio.
`persisted`, `cleanup`, `review` são informações separadas, não autorização.
Uma resposta válida v2 continua NEEDS_REVIEW mesmo com model quality false.
ACCEPTED é reservado e nunca produzido. HTTP incerto não pode liberar o slot.

Um lote contém até três membros, USD3 no máximo por membro, até USD9 total,
uma chamada por membro, WIP1, retries0 e fallbackfalse. Valores monetários são
strings Decimal positivas finitas; contagens rejeitam booleanos. O alvo completo
(project/model/global/dedicated service_account) deve coincidir com a política
Root existente. Novas análises exigem `reels-pilot-run.v2`. O manifesto completo,
request SHA, código e auth descriptor continuam verificados pelo grant Ed25519.
`worker.version_pins()` inclui recurrence.py; Root deve revisar e integrar os
novos pins/policy/public manifests, sem reutilizar grants antigos para nova IO.
As três rotas históricas de recuperação do worker não foram modificadas.

## Inventário e preparação (operador confiável, não Hermes)

Não são permitidos paths de política/binário/token/transport configuráveis na
CLI, nem `--synthetic`. A política é sempre
`/etc/megabrain/reels-pilot/policy.json`; execução real exige o UID worker fixado.
Arquivos de controle são sempre:

```
/etc/megabrain/reels-pilot/recurrence/BATCH_ID/inventory.json
/etc/megabrain/reels-pilot/recurrence/BATCH_ID/history.json
/etc/megabrain/reels-pilot/recurrence/BATCH_ID/approval.json
/etc/megabrain/reels-pilot/recurrence/BATCH_ID/REEL_ID.grant.json
/etc/megabrain/reels-pilot/recurrence/BATCH_ID/REEL_ID.cleanup.json
```

Root fornece arquivos regulares root-owned, sem symlinks ou ancestrais graváveis,
legíveis pelo worker (por exemplo 0640, grupo worker), após revisão. CLI não
escreve esses arquivos nem cria aprovações. Root faz backup e revisa as tabelas
aditivas antes de disponibilizar o worker. O comando `bootstrap` usa
`Queue(policy, bootstrap=True)` sob o UID worker real, mantendo a validação da
política e da identidade do Ledger. Não há override Root da identidade runtime.
Exige recibo protegido fixo
`/etc/megabrain/reels-pilot/recurrence/schema-approval.json` com campos exatos:
decision=`APPLY_REELS_QUEUE_SCHEMA`, ledger_identity igual à política,
schema_sha256=`sha(canonical(SCHEMA_SQL))` e
version_pins_sha256=`sha(canonical(policy.version_pins))`. O recibo autoriza apenas
DDL aditivo idempotente, sem alterar tabelas/linhas antigas, owner ou permissões;
não autoriza mídia, dinheiro ou dispatch. Nenhum bootstrap operacional foi
realizado aqui. Depois de backup/revisão e recibo provisionado por Root, o
operador worker pode executar (sem batchID):

```sh
/opt/python/bin/python3 operations/reels-pilot/recurrence.py bootstrap
```

Formato `inventory.json` (campos exatos; `manifest` é o manifesto v2 completo
produzido pelo processo existente, não uma referência de caminho):

```json
{
  "batch_id": "owner-batch-001",
  "members": [{
    "manifest": {"manifest_version": "reels-pilot-run.v2", "task": "REPLACE_WITH_FULL_EXISTING_TASK_OBJECT", "request_sha256": "REPLACE_WITH_ACTUAL_REQUEST_SHA256"},
    "target": {"project": "ROOT_POLICY_PROJECT", "service_account": "ROOT_POLICY_DEDICATED_SA", "model": "gemini-3.8-flash", "location": "global"},
    "max_calls": 1, "max_gross_USD": "3", "currency": "USD"
  }],
  "currency": "USD", "max_calls": 1, "max_gross_USD": "3",
  "wip": 1, "retries": 0, "fallback": false
}
```

Este exemplo é um template deliberadamente não executável/não autorizante.
Preparação pode consumir inventário Root de candidatos observado com o
StoredMediaReader/probe existente. Não baixa mídia. A preparação verifica mídia,
metadata, duração/audio/bytes e request SHA com o reader existente. Futuro scan
on-demand deve continuar limitado a até três candidatos e raízes aprovadas.
Dedup usa ReelID/sourceSHA/metadataSHA em todos os lotes e nas duas tabelas
históricas de tentativas. Cada tentativa PERSISTED exige refs.artifact_prefix,
FileStore.verify e SHA do manifest imutável coincidente com refs.manifest_sha256.
MetadataSHA vem da provenance.json imutável verificada, confrontada com
analysis.v1.json.identity.source_metadata_reference.sha256 quando não nula
(o pipeline sintético produz referência nula). Não se adivinham hashes do grant.
Referências ausentes/corrompidas bloqueiam; qualquer tentativa histórica não
PERSISTED bloqueia nova execução. Linhas antigas não são reescritas.
Histórico Windows deve estar previamente importado em arquivos `history*.json`
ou `analysis*.json` sob media_root/media/reels e result_root: leitura recursiva
limitada a 20.000 entradas, sem symlinks, falhando fechado por tamanho/formato/
colisão. Qualquer diretório no result_root nomeado pelo ReelID candidato bloqueia,
mesmo vazio/parcial. Não se varre todo vault/backups nem o inventário Root do
novo lote. Não há consulta remota ao Windows.

Antes de prepare (inclusive idempotente) e em cada verificação de NEW dispatch,
exige-se `BATCH_ID/history.json` protegido, com campos exatos:
decision=`CONFIRM_REELS_HISTORY`, batch_id, manifest_sha256 do lote canônico,
roots contendo EXATAMENTE media_root/result_root e seus bindings completos da
política, checked_at timezone-aware não futuro e com idade máxima de 24 horas,
complete=true. Root deve produzir isso após auditoria real de storage/Ledger e
demais históricos conhecidos, inclusive os fora do scan local. É atestado de
completude vinculado aos membros/raízes, não permissão paga. Ausência ou
inconsistência bloqueia antes da leitura de mídia/dispatch. A varredura local e
as duas tabelas são relidas antes do claim e nas verificações do worker; só se
ignora a tentativa base do source/grantID exatos do membro já RUNNING e vinculado
no queue. Outras colisões continuam bloqueando. Recover de persistência não
requer novo atestado nem varre mídia. Completude remota continua dependente da
auditoria Root, não demonstrada pelos testes sintéticos.
Mesmo batchID + mesmos bytes canônicos é idempotente; mudança/expansão rejeita.

Comandos completos para operador, após integração/revisão e schema provisionado
(exemplos não executados por Hermes; executar com o UID worker instalado):

```sh
/opt/python/bin/python3 operations/reels-pilot/recurrence.py prepare owner-batch-001
/opt/python/bin/python3 operations/reels-pilot/recurrence.py status owner-batch-001
/opt/python/bin/python3 operations/reels-pilot/recurrence.py next owner-batch-001
```

PARE em PENDING para aprovação humana consolidada. `prepare` não autoriza envio.

## Aprovação e execução deliberada

`approval.json` contém EXATAMENTE decision=`APPROVE_REELS_BATCH`, batch_id,
manifest_sha256 (SHA canônico retornado por prepare), approval_id, approved_by,
approved_at, expires_at, rights_and_global_privacy_accepted=true, max_calls,
max_gross_USD. Calls/amount devem coincidir exatamente com lote imutável.
Identidade dedicada/alvo/membros ficam vinculados pelo SHA do manifesto inteiro.
Cada grant individual continua obrigatório e assinado por Ed25519, incluindo
full manifest, request, runtime pins/auth descriptor, budget <= membro, mesmo
approval_id e approver do lote, approved_at não anterior ao lote, expiry não
posterior à do recibo. Grants successor são proibidos na recorrência.
Root cria o recibo somente depois da aprovação humana; não copie templates
como se fossem autorização. SHA/caminho do recibo são imutáveis no banco, mas
a autoridade vem dos bytes protegidos, nunca de um booleano/registro DB.
O recibo é relido e revalidado em cada verificação do worker antes da IO.

```sh
/opt/python/bin/python3 operations/reels-pilot/recurrence.py authorize owner-batch-001
/opt/python/bin/python3 operations/reels-pilot/recurrence.py run-one owner-batch-001 --executor-id trusted-worker-session-001
/opt/python/bin/python3 operations/reels-pilot/recurrence.py status owner-batch-001
```

`run-one` é ação paga potencial, somente para operador depois da aprovação;
NÃO executar automaticamente nem executar durante implementação offline.
A reserva de recorrência e RUNNING são duráveis antes de Pipeline.run. Qualquer
interrupção depois de claim não permite run novamente. Sem recibo válido ou
assinatura correta: zero media send/custo. Expiração não rearma tentativa.

## Recuperação e fechamento

```sh
/opt/python/bin/python3 operations/reels-pilot/recurrence.py recover owner-batch-001 --member-id REEL_ID --executor-id trusted-recovery-001
/opt/python/bin/python3 operations/reels-pilot/recurrence.py cleanup owner-batch-001 --member-id REEL_ID --executor-id trusted-cleanup-001
/opt/python/bin/python3 operations/reels-pilot/recurrence.py close owner-batch-001 --member-id REEL_ID --executor-id trusted-cleanup-001
/opt/python/bin/python3 operations/reels-pilot/recurrence.py next owner-batch-001
```

`close` é alias de cleanup. Recover só chama Pipeline.recover quando já há
resposta durável; nunca lê mídia/auth/provider. PERSISTED verifica arquivos
imutáveis offline. UNKNOWN/RESERVED/missing fica BLOCKED com slot/reserva retidos;
reconciliação manual, nunca refund/retry/rearm automático.

Recibo Root cleanup contém EXATAMENTE decision=`CLOSE_REELS_MEMBER`, batch_id,
member_id, grant_id, source_sha256, worker_result_sha256 (SHA canônico do retorno
worker persistido em recurrence_members.result_json), cleaned_at, e os três
booleanos true: token_copy_removed, temporary_bindings_removed,
other_bindings_preserved. Timestamp posterior ao persisted_at do Ledger e não
futuro. O pipeline verifica persistência antes de fechar; recibo protegido é
verificado novamente antes da liberação. Não há override booleano CLI. A limpeza
é declaração Root protegida de ações externas, não execução dessas ações aqui.
Só persistência + limpeza verificadas liberam o slot. O próximo membro ainda
exige invocação explícita e aprovação/grant válidos. Não há lote sucessor pago
automático nem fechamento de UNKNOWN por recibo falso.

## Prova offline

```sh
bash /reference/validate_offline.sh
```

Testes compõem o fixture existente WorkerProviderTests com Ed25519 real,
Ledger SQLite real e Pipeline completo, mas apenas bytes explicitamente
`SYNTHETIC TEST BYTES.` e FakeProvider existente; nenhuma credencial/mídia real.
Os 30 testes de recorrência compõem o fixture por módulo, sem importar a classe
TestCase no namespace de discovery (sem duplicar os testes do worker). Recibos
sintéticos de schema/history/approval/cleanup são root-owned 0640 sob uma árvore
temporária /opt com ancestrais não graváveis por grupo/outros. Apenas CONTROL é
redirecionado; protected() nunca é substituída, inclusive no ciclo completo
prepare/authorize/dispatch/restart/cleanup. Há rejeição de ancestral /tmp e
symlink, colisão somente de metadata nas duas tabelas, refs ausentes/corrompidas,
history ausente/expirada/inconsistente, diretório parcial e rechecagem após mídia.
Não é prova de integração Root/worker em produção nem de histórico Windows real.
Validador independente deve executar o driver e verify_read_only.py antes de
qualquer aprovação. Hermes developer não declara aprovação do validador.
