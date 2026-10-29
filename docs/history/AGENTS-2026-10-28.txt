# Regras para agentes

## Coordenação nativa sob demanda — Sprint 2E

A autorização explícita do proprietário para esta Sprint permite subagentes nativos Desenvolvedor e Revisor, correções, PRs e merges após revisão independente e CI. Isso não altera os limites do launcher histórico nem habilita scheduler, heartbeat ou modelos externos.

Use o packet tasks/MEG-109-sprint2e.json e o escopo vigente. Inferência real, leitura/transmissão de mídia, IAM de inferência, billing e deploy permanecem sujeitos à autorização correspondente. Somente o Orquestrador integra o estado. Não invente tarefas ou identidades de execução.

As regras abaixo descrevem o fluxo histórico do launcher. A autorização nativa explícita desta Sprint prevalece em coordenação e merges; mantenha suas proteções de segredos, escopo, validação e revisão. Autorizações antigas de google-v0 não autorizam o novo pipeline.

## Antes de executar
O operador valida um Task Packet de `tasks/` antes de autorizar uma execução. Sem packet válido, não iniciar o modelo. O agente deve seguir o packet indicado pela tarefa e parar se faltar informação essencial.

Leia somente os arquivos e trechos de contexto indicados. Amplie o contexto apenas para resolver uma dependência concreta; registre o motivo. Não carregue toda a documentação ou o histórico por padrão.

## Escopo e segurança
Trabalhe somente no repositório, commit de partida e caminhos autorizados pelo packet. A lista de caminhos é verificada no diff; o sandbox restringe o projeto, não cada arquivo dessa lista.
Não leia nem exponha credenciais. Não acesse o MCP administrativo, outros repositórios, backups privados ou infraestrutura. Backups MegaBrain são referências históricas, não inventário de serviços.
Não crie agentes, subagentes, processos adicionais de modelos nem aumente o próprio orçamento. Não use API paga, modo Fast ou Ultrafast.

## Execução
Uma tarefa por execução. Preserve concorrência global 1, limites do launcher e autenticação pela assinatura ChatGPT. Use raciocínio baixo para tarefas simples; mudanças de complexidade exigem revisão do packet.
Use ferramentas convencionais para buscas, testes, builds, Git, CI e deploy. Não use o modelo para esperar CI ou consultar repetidamente estados.
Pare em falha de autenticação, limite de uso, escopo insuficiente ou orçamento esgotado. Não faça retries ou continuações automáticas do modelo.

## Entrega e revisão
Execute os comandos de validação do packet e entregue diff, resultados, limitações e link do PR. Não faça merge ou deploy sem autorização específica.
Siga a [revisão por risco](docs/REVIEW_POLICY.md). O Reviewer usa sessão independente e acesso de leitura; recebe packet, diff e testes, sem herdar a conversa do Worker.
Uma correção após revisão precisa de autorização e orçamento próprios. O CI deve passar no commit final; CI verde não substitui revisão de lógica e segurança.

## Comandos convencionais
- `python3 scripts/check_links.py`
- `python3 scripts/check_task_packets.py`
- `python3 scripts/check_task_packets.py --packet tasks/MEG-2.json --diff-base <commit-base> --diff-head HEAD`

[Fluxo operacional](docs/AGENT_WORKFLOW.md) · [Task Packet](docs/TASK_PACKETS.md)
