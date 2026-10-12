# Tarefa delimitada e encerramento

## Antes do trabalho
Confirme Task Packet e atribuição. Não escolha outra tarefa nesta execução.
Checkout é obrigatório, salvo a exceção de chat externo realmente verificado: nesse caso leia modes.md antes de usar a exceção.

Checkout convencional: POST /api/issues/{issueId}/checkout, com Authorization e X-Paperclip-Run-Id do run atual, corpo agentId e expectedStatuses aceitos. 409 significa conflito de posse: pare, não repita nem force. Não entre em in_progress só para anunciar intenção; checkout estabelece a execução.

Use primeiro o wake payload disponível e depois, se necessário, GET /api/issues/{issueId}/heartbeat-context. Para comentário específico, consulte seu ID; para novidades, use cursor after e ordem asc. Leia a thread completa somente quando o contexto compacto/incremental não bastar. Se não houver tarefa explícita, este perfil para; seleção de inbox exige fluxo autorizado próprio.

## Trabalho e escrita
Uma tarefa acionável precisa de trabalho concreto na mesma execução, salvo pedido explícito de plano ou revisão. Respeite as validações do packet; não amplie caminhos por conveniência.

Inclua X-Paperclip-Run-Id em todas as escritas e confirme o JSON retornado. Uma atualização deve refletir o estado/comentário enviado. Resposta vazia é falha, mesmo que o comando termine com sucesso; não esconda resultado/status em pipelines. Duas falhas consecutivas da mesma escrita encerram suas tentativas; isso não autoriza outra execução de modelo.

Se aparecer executionState em in_review, leia decisions.md antes de registrar decisão. Se houver bloqueio de dependência sem contexto novo, não faça checkout nem repita comentários de bloqueio. Contexto novo pode justificar nova decisão, mas não fornece permit automaticamente.

## Disposição final
- done: trabalho e validações desta tarefa concluídos, entregas acessíveis e nenhum seguimento obrigatório nela.
- in_review: existe participante de revisão, responsável humano, aprovação/interação pendente vinculada ou outro caminho real aceito pelo servidor. Não basta atribuir a si mesmo e comentar “revisar depois”.
- blocked: existe blockedByIssueIds ou unblockDescriptor válido, com dono e ação. Um agente só pode declarar a si como dono de desbloqueio; não atribuir esse poder ao board, usuário ou outro agente.
- in_progress: exige run ativo, continuação autorizada já existente ou mecanismo real aceito. Este perfil não cria continuação de modelo/monitor automaticamente.
- backlog: tarefa estacionada; cancelled: abandono deliberado autorizado, não fechamento por conveniência.

Human-input waits usam interação salva e in_review; dependências de outra tarefa usam bloqueio de primeira classe. Leia decisions.md antes de criar esses caminhos.
Se um usuário pedir a tarefa de volta, faça a atribuição humana autorizada e a disposição apropriada, geralmente in_review, confirmando a resposta. Nunca cancele trabalho de outra equipe; escale ao responsável dentro do escopo.

No fim, reporte o resultado real, inclusive falhas de escrita e limites. Não atribua ao Worker arquivos preparados pelo operador.
