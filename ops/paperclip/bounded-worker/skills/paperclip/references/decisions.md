# Decisões e caminhos de espera

A autorização do Task Packet e do operador limita estas ações. Não crie uma continuação de modelo para resolver uma espera.

## Revisão de execução
Em in_review com executionState, confira currentStageType, currentParticipant, returnAssignee e lastDecisionOutcome. Só o participante atual registra decisão.
PATCH status done com comentário de aprovação registra o veredito; se houver outra etapa, o servidor mantém in_review e encaminha ao próximo participante.
PATCH status in_progress com pedido de mudança devolve ao returnAssignee conforme a política.
Confirme a resposta; não force a etapa de outro ator nem suponha uma decisão independente que não ocorreu.

## Planos e interação
Plano solicitado é documento da tarefa com key plan; revisões atualizam esse documento com baseRevisionId obtido de latestRevisionId. Conflito de revisão exige ler e reconciliar, sem sobrescrita cega. Não marcar done um plano que espera confirmação/implementação.

Antes de implementar plano que exige aprovação, use interação vinculada à revisão atual e postura in_review. Se o usuário pediu a tarefa de volta, atribua ao usuário correto do contexto. Ser capaz de executar uma ação não dispensa sua autorização.

Interações são registros de coordenação, não permissões para gastar, contratar, acessar segredos ou executar ações governadas. A integração futura precisa fornecer o schema upstream para criar cards; sem schema, pare e entregue a decisão pendente ao operador.
Mesma tarefa usa interação; efeitos sobre outras tarefas usam decisão/bundle apropriados, somente quando autorizados.
Target, revisão, idempotencyKey e staleness devem ser preservados. Não reaplicar efeito confirmado nem recriar cards pendentes.

Restrições human_only/not_creator ou destinatário específico só devem ser pedidas quando necessárias à decisão e nunca ampliam autoridade. Aprovação humana de segurança ou gasto continua humana quando a política assim exigir.

## Bloqueio e monitor
blockedByIssueIds identifica dependência real; parentId sozinho não bloqueia. unblockDescriptor precisa do dono permitido e da ação concreta. Agente não pode nomear usuário/board/outro agente como dono de desbloqueio.

in_review exige caminho real: participante, responsável humano, aprovação ou interação salva. Prosa não programa um wake.
Monitores requerem estado persistido e condições de elegibilidade do servidor, incluindo assigneeAgentId, ausência de assigneeUserId, estado e horário corretos. Não criar ou prometer monitor no perfil de uma execução sem autorização explícita. Nunca prometer monitor vivo em tarefa done.

Delegação, criação de subtarefas e espera por outro modelo ficam fora deste perfil até existir packet/orçamento e decisão do operador. Não faça busy-poll de agentes, tarefas ou sessões.
