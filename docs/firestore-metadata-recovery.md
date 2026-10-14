# Retomada de falhas confirmadas de metadados Firestore

A recuperação trata a fase interrompida, não qualquer HTTP429. É explícita, limitada a uma tentativa e separada da recuperação de download Instagram e da recuperação de resposta Gemini429. Timeouts, identidade inválida, diagnóstico desconhecido e análises submetidas continuam retidos.

## Evidência e autorização

O operador confirma o serviço que rejeitou a escrita pelos logs/diagnóstico e pelo estado financeiro. Com fila pausada, reconcilia documentos fragmentados, artefatos Storage, controles, capacidade e versão publicada. Nunca altera o diagnóstico para fazê-lo caber na regra. Nenhuma autorização é criada pelo frontend ou pelo payload da tarefa.

Depois da revisão humana independente e publicação, criar somente uma autorização `jobs/firestore_recovery_<original_execution_id>` com:

| Campo | Valor exigido |
| --- | --- |
| schema_version / status | `1` / `authorized` |
| kind / verified_service | `confirmed_firestore_metadata_rejection` / `firestore.googleapis.com` |
| original_execution_id / video_id / stage | Execução original e vídeo conferidos; `upload` ou `transcription` |
| maximum_cents | Mesmo máximo da etapa original e configuração atual |
| failure_digest | SHA256 do diagnóstico original em JSON com chaves ordenadas; usar `failureDigest` do módulo |
| recovery_id | Identificador explícito de 16 a 64 caracteres, igual ao payload |
| authorization_ref | Referência ao veredito do operador/tarefa |
| authorized_at / expires_at | Horários reais, janela positiva de até24h, ainda vigente |
| evidence | Upload: `media_absence_verified`; STT: `provider_not_submitted` |

Despacho autenticado: `{videoId, stage, poll:0, recoveryId, recoverFirestoreWrite:true}`. Não combinar com outros flags. A autorização não altera controles globais, crédito, orçamento, corpus ou paralelismo. Documentos de claim e despacho determinísticos tornam a tentativa única mesmo com entregas concorrentes. A autorização permanece como auditoria; não precisa ser apagada.

## Download

Exige claim original incerto, diagnóstico `persist_download` com429/RESOURCE_EXHAUSTED, ausência de mídia/resultados e entrada original concluída pelo máximo integral, com marcador de reconciliação `confirmed_firestore_metadata_rejection_full_estimate_accounted_upload_pending`. Não presume sucesso do upload a partir dessa contabilidade.

`prepareUploadRecovery` verifica novamente a ausência do objeto original no Storage antes de reserva e download. Objeto existente ou ausência não confirmada bloqueiam. A nova execução é `uploadRecoveryId(originalId)`; seu claim e entrada financeira usam `recovery_of`. A entrada e claim anteriores são preservados integralmente. A nova reserva recebe cobertura própria e os dois valores continuam no teto acumulado; não são apresentados como cobrança faturada.

O caso DFF6g22JoUt se enquadra somente se a prova fresca de ausência continuar válida. Não codificar esse ID como regra.

## Transcrição

Exige claim bloqueado, diagnóstico `adapter_or_reservation` com429/RESOURCE_EXHAUSTED e reserva original ainda `reserved`. Essa transição falhou antes do adaptador; `started`, `uncertain`, nome de operação, tentativas de análise ou artefato impedem recuperação. Mídia verificada, geração e áudio presente são obrigatórios.

O claim é tomado com CAS e contador único. A reserva original passa a `started`, sem uma segunda reserva e sem zerar contadores. A operação assíncrona persiste seu nome e segue apenas por polls. O caso DGdj6qIRPRb exige essa conferência; não codificar esse ID como regra.

## Publicação e aceite operacional

1. Revisar o head final, CI e testes; publicar mantendo fila pausada e configuração protegida.
2. Conferir os dois estados novamente, a ausência do objeto do download e a falta de submissão/artefatos STT; registrar autorizações com horários reais.
3. Despachar essas recuperações e completar quatro vídeos validados no lote existente, máximo4 simultâneos, tetoR$1.200/reservaR$250.
4. Conferir Storage, resultado curado, transcrição, reprodução e sincronização automática no site. Candidatos retidos não contam como aceitos.
5. Na reconciliação do download, considerar três etapas atuais mais exatamente uma entrada original integralmente reconciliada, vinculada pelo filho concluído. A antiga regra operacional de exatamente três entradas precisa dessa distinção; não descartar a quarta entrada nem somar somente três valores.
6. Continuar elegíveis apenas após esse aceite. Acompanhamento Codex recorrente permanece desativado.

Qualquer falha nova preserva a tentativa e cobertura. Não criar outro recoveryId para contornar o claim único, repetir inferência incerta ou liberar um segundo retry automaticamente.

[Revisão exigida](REVIEW_POLICY.md)
