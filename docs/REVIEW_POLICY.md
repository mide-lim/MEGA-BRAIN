# Revisão por risco

| Risco | Exemplos | Revisão exigida |
| --- | --- | --- |
| Baixo | Documentação, comentários, ajustes sem alteração de comportamento | CI e revisão humana do diff e dos critérios |
| Médio | Lógica, integrações ou mudança de comportamento | CI e Reviewer em sessão independente; aprovação humana antes do merge |
| Alto | Autenticação, permissões, migração, dados ou infraestrutura | Plano/ADR quando relevante, validação específica, Reviewer independente e aprovação humana antes de merge/deploy |

Código de validação e controles de execução contam pelo impacto sobre o fluxo, não pela extensão do arquivo. O operador classifica o risco antes de executar. Se o impacto aumentar, parar, atualizar o packet e rever o orçamento.

## Independência
O Reviewer recebe objetivo, critérios, diff e resultados de testes. Usa uma sessão nova, com permissões de leitura e credencial restrita ao repositório; não implementa a própria correção. Ele procura defeitos e evidências insuficientes, em vez de confirmar a narrativa do Worker.

Hoje só há um agente provisionado. Tarefas que exigem Reviewer independente não são consideradas prontas até essa revisão existir ou uma revisão humana independente cumprir explicitamente a etapa. Não registrar revisão de modelo que não foi executada.

## Decisão
Registrar: aprovar, solicitar alterações ou bloquear; commit revisado; critérios verificados; achados com caminhos e linhas; testes executados e limitações. Use o [modelo de revisão](templates/review.md).

Correções precisam de packet atualizado e autorização própria. Mudança relevante depois da revisão invalida a aprovação anterior. O operador confirma CI e revisão no commit final; nenhum agente faz merge ou deploy automaticamente.

[Fluxo](AGENT_WORKFLOW.md) · [Início](../README.md)
