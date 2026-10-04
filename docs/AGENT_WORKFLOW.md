# Fluxo de agentes com cota controlada

Demanda → triagem → Task Packet validado → Worker → testes/CI → revisão por risco → PR pronto para aprovação.

## Papéis e acionamento
Tech Lead, Worker e Reviewer são papéis. Hoje existe somente o Codex Pilot; não há novos agentes provisionados. O operador assume triagem e revisão humana de baixo risco. Um Tech Lead por modelo pode preparar um lote quando houver decisões concretas; uma revisão independente será uma execução separada, contabilizada na mesma cota.

Paperclip registra tarefa, responsável, estado, evidências e histórico. Mover uma tarefa para outro estado não deve iniciar o modelo automaticamente. Agentes ficam pausados, sem heartbeat periódico; a execução é autorizada explicitamente e retorna à pausa ao terminar.

## Cota compartilhada
A trava do launcher é global ao piloto: concorrência 1, até 2 execuções em 24 horas móveis, intervalo mínimo de 1 hora, timeout de 15 minutos. Esses limites são próprios; não representam a franquia oficial do Plus. Planejamento, execução, revisão e correção por modelos compartilham essa contagem. Uma revisão pode precisar esperar a próxima janela disponível.

Cada autorização é de uso único, vinculada à tarefa, ao papel e ao hash do packet, com validade de 15 minutos. Alterar o packet exige nova autorização. O preflight ocorre antes do modelo; uma falha de preflight não consome uma execução de modelo. O launcher não aceita um daemon app-server.

Retries de ferramentas convencionais podem ocorrer de forma limitada e justificada. Uma nova execução de modelo sempre exige autorização; falha de autenticação ou cota encerra a etapa. O Worker não fica esperando CI: entrega as alterações e o operador acompanha o CI com `gh`.

## Contexto e arquitetura
AGENTS.md guarda somente regras operacionais. C4 e arc42 serão mantidos de forma enxuta e consultados por trecho. ADR registra decisões relevantes; DDD orienta vocabulário e limites quando os domínios reais estiverem definidos. Nada disso exige um agente exclusivo.

O packet seleciona contexto; CocoIndex e Hermes ficam para uma etapa posterior. A decisão está no [ADR 0001](adr/0001-demand-driven-agents.md).

## Evidências e melhoria
Para cada tarefa, registrar commit base/final, PR, checks, revisão, execuções, duração e tokens disponíveis. Comparar tarefas semelhantes após algumas entregas: execuções por PR aceito, correções, falhas e contexto acumulado. Tokens em cache não equivalem a uso gratuito da assinatura; não converter tokens em percentual de cota ou preço de API.

O [baseline do piloto](metrics/pilot-baseline.json) é uma observação inicial, não uma estimativa de capacidade da assinatura. Esta implementação foi feita com ferramentas convencionais, sem iniciar outra execução do Codex na VPS.

[Task Packets](TASK_PACKETS.md) · [Revisão por risco](REVIEW_POLICY.md) · [Início](../README.md)

## Limite dos controles atuais
O launcher controla o caminho normal de execução do Paperclip. Não é uma barreira contra código malicioso executado com o mesmo usuário: o CLI real e os arquivos de estado continuam disponíveis no contêiner. A credencial GitHub atual também tem alcance de conta. Antes de adicionar projetos ou executar código não confiável, separar runtime, credenciais por repositório e controle de autorização fora do usuário do Worker.
