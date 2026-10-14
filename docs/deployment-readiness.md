# Verificação e diagnóstico de publicação

O CI anterior publicou revisões saudáveis, verificou parte das rotas e depois reverteu as imagens. O aviso genérico não identificou a etapa/causa. A publicação posterior pela mesma rotina passou; isso não prova a causa exata da falha anterior.

A rotina passa a registrar fase (`worker_update`, `web_readiness`, `web_smoke` etc.) e causa com códigos restritos, como `smoke_video_http_503`, `google_transport` ou `readiness_timeout`. Não publica mensagens remotas, URLs, tokens ou configuração.

Depois de cada PATCH único, consulta a prontidão até30 vezes, com intervalo1s. Aceita apenas a imagem anterior ou candidata e exige todas as configurações protegidas iguais. Qualquer imagem terceira ou alteração de identidade, segredo, tráfego ou escala exige intervenção. Não repete PATCH após timeout desconhecido.

Verificações anônimas GET têm no máximo três tentativas somente em transporte/timeout/502/503/504, com esperas1s/2s. Login e CSS devem retornar200; APIs devem retornar401; callback inválido deve retornar403. Resposta200 em API protegida, conteúdo inválido ou outra divergência falham imediatamente. Não há retry de processamento, login OAuth, gravação Firestore ou chamadas pagas.

As regras de reversão permanecem: restaurar apenas imagens conhecidas quando estado/configuração permitem; operação em reconciliação ou edição concorrente não é sobrescrita. Fila deve estar pausada antes e depois. CI verde não substitui revisão humana independente e autorização de publicação.

[Revisão exigida](REVIEW_POLICY.md) · [Retomada controlada](firestore-metadata-recovery.md)
