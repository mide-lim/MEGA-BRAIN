# Retomada explícita de download

A tarefa autenticada upload/poll0 com recoverUpload:true e recoveryId permite uma única tentativa adicional. Exige falha terminal da ferramenta (exit1), etapa download_media, último marco metadata e causa não classificada; consulta de metadados da própria tentativa concluída com sucesso, nenhuma mídia referenciada no vídeo e original ausente no Storage. Isso não rotula o Reel como privado, removido ou válido definitivamente.

O worker verifica CAS, identidade, controle financeiro atual e objeto ausente antes de repetir. Mantém executionId, reserva e diagnóstico original; registra contador antes de baixar. Não altera STT ou análise. Falha de persistência, timeout, autenticação/quota explicitamente diagnosticada, ausência de probe, mídia existente ou contador consumido não admite retomada. Se a tentativa adicional falhar, conserva reserva e pausa; não há retry automático nem abandono/fechamento financeiro silencioso.

Após revisão humana e publicação, o operador confirma ausência de resultado, fila vazia/pausada, R$300 e observações válidas; envia exatamente uma tarefa de recuperação. Conferir mídia/áudio e etapas seguintes antes de continuar os24IDs novos. Não apagar registros nem reconstruir identidade para contornar proteção.
