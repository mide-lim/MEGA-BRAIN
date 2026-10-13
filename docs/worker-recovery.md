# Isolamento individual do worker

No perfil de 262 vídeos, um timeout de análise conferido pode deixar de bloquear outros vídeos. Isso exige decisão explícita do operador; status `uncertain` sozinho nunca autoriza continuidade.

## Procedimento

1. Pausar admissão e confirmar que a chamada acabou. Conferir o diagnóstico, as tentativas, o vídeo e os artefatos antes de autorizar isolamento.
2. Usar `FinancialLedger.isolateAnalysisTimeout(executionId, {authorizationRef, verifiedFailure: 'client_timeout'})` com referência rastreável da autorização. O claim deve estar incerto em `submit_analysis`, sem HTTP recebido, com última tentativa incerta e diagnóstico `TimeoutError`. Não pode haver análise ou candidato publicado.
3. Para o diagnóstico legado sem nome de erro, o operador deve conferir o cancelamento 499 nas métricas da mesma chamada e o código local 23 no claim. Somente então acrescentar `legacyServerStatus: 499`. Esse campo documenta evidência operacional, não altera o HTTP do diagnóstico original.
4. O método registra o motivo, a referência, o horário e a evidência no financeiro, preservando a reserva integral, o claim e todas as tentativas. Remove apenas a via daquele vídeo. A gravação financeira e a remoção da via usam a mesma atualização CAS.
5. Conferir outros motivos de pausa e retomar explicitamente apenas quando os controles financeiros, de cobertura, infraestrutura e automação permitirem. O método não muda `paused`, os controles nem o saldo observado.

O vídeo isolado fica pendente. Ele não pode reservar outra etapa nem repetir a chamada. Outros vídeos podem ocupar até quatro vias; as reservas incertas continuam contando contra todos os envelopes. Um outro resultado incerto não isolado mantém o bloqueio global. Perfis anteriores de 30/62 vídeos mantêm o comportamento original.

## Limite desta entrega

Não implementa nova chamada paga após timeout. A recuperação existente de HTTP429 continua exigindo resposta429 confirmada; um timeout jamais é recodificado como429. Recuperação paga de timeout precisa de outra entrega: autorização explícita, identidade nova vinculada à original, reserva adicional preservando a reserva incerta anterior, claim atômico e artefato separado. Não apagar execução, reserva ou histórico para permitir retry.

A interface acima é um primitivo para o operador, não uma rota pública ou admissão automática de fila. Publicação exige revisão humana independente e CI. Testes simulam contenção CAS, reinício, quatro vias, duplicatas, controles globais e evidência inválida sem chamadas externas.

[Revisão por risco](REVIEW_POLICY.md) · [Packet MEG-76](../tasks/MEG-76.json)
