# Recuperação limitada de análise após429

Somente a chamada generateContent com resposta HTTP429 explícita pode ser repetida. Máximo três chamadas durante toda a execução, incluindo a primeira; esperas5 e15 segundos. Timeout,401/403,5xx, falha ao salvar ou resposta de qualidade insuficiente não autorizam repetição. As tentativas são persistidas antes da submissão; cada nova chamada revalida pausa, validade do saldo, orçamento e reserva iniciada. Uma resposta recebida nunca é gerada novamente para reparar persistência.

A recuperação de um job antigo exige tarefa autenticada analysis/poll0 com recoverAnalysis429:true e recoveryId único, job uncertain/submit_analysis429 e reserva uncertain correspondente. O worker conserva o executionId e a reserva, contabiliza a chamada antiga como tentativa1 e usa CAS para impedir concorrência. Nenhum upload ou STT é submetido novamente. Resultado publicado, candidato ou objeto analysis.json existente bloqueia inferência. Não apagar jobs, zerar contadores, mudar revisão nem liberar reserva.

Antes de enviar a tarefa, publicar somente o commit revisado, conferir ausência de resultado, ativar os controles aprovados e verificar crédito vigente/R$300. Após recuperar, verificar análise aceita, transcrição e reprodução; continuar os31 pendentes sequencialmente. Se as três chamadas retornarem429 ou houver erro sem confirmação, pausar e conservar a reserva. Não aumentar orçamento ou adquirir capacidade automaticamente.

Diagnóstico guarda HTTPstatus, etapa e mensagem limitada/redigida do Google. Corpo inválido ou maior que8192bytes não é armazenado. A causa específica só pode ser atribuída quando a mensagem recebida permite;429 sozinho não distingue quota de sobrecarga.

Validação local utiliza respostas simuladas, sem inferência paga. Revisão humana independente é exigida antes de merge/deploy.
