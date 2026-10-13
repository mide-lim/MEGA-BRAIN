# Sincronização da biblioteca Google (MEG-79)

O site carregava apenas a primeira página de40 vídeos. Indicadores, categorias e busca eram calculados sobre essa página; Atualizar recarregava o mesmo subconjunto. Resultados seguintes existiam no Firestore, mas ficavam fora da apresentação inicial.

O cliente agora percorre todos os cursores de `/api/library`, preserva chamadas limitadas a40 registros e substitui o acervo somente após leitura completa. Deduplica IDs e rejeita cursores repetidos e respostas inválidas. Os detalhes abertos recebem o mesmo resultado atualizado.

A tela visível atualiza a cada60segundos e ao retornar à aba. Uma única leitura completa pode estar ativa, e as requisições são canceladas ao desmontar a tela. Atualizar continua disponível. Falha mantém o último acervo completo e exibe erro. O painel mostra Vídeos cadastrados e horário da atualização.

É leitura completa pelo cliente, sem listener Firestore ou alterações no processamento. Custo por ciclo visível: ceil(N/40) requisições,8 para282 registros ou75 para3000. Uma estratégia incremental no servidor é uma otimização futura. Não há chamadas de modelo, replay, alteração financeira, escrita em vídeos nem início automático da fila.

Validação: testes de paginação, falha, cancelamento e visibilidade; navegador headless com282 registros, resultado na última página, falha intermediária e atualização automática para283. Dados sintéticos, sem Google real ou modelos. Após publicação, comparar a tela ao banco: o total inclui resultados anteriores aos65 aceitos deste lote. Revisão humana independente necessária antes de merge e publicação.
