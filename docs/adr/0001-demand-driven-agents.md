# ADR 0001 — Agentes acionados por tarefas definidas

Status: proposto para aprovação no PR.

## Contexto
Usamos uma assinatura ChatGPT Plus, sem API paga. O piloto entregou um PR em uma execução, mas registrou entrada acumulada alta, incluindo cache. Agentes adicionais compartilham a cota da conta; a quantidade de execuções sozinha não estima o consumo real.

## Decisão
Manter um Worker provisionado e concorrência global 1. Triagem, validação, consulta de CI e operações previsíveis usam humanos ou ferramentas convencionais. Planejamento por modelo e Reviewer independente são acionados quando necessários, com packet e orçamento explícitos.

Exigir contexto selecionado, revisão por risco, uma autorização por execução e parada em falhas de autenticação/cota. Preservar o limite inicial de duas execuções em 24 horas e uma hora entre execuções. Adiar CocoIndex, Hermes e ampliação da equipe.

## Alternativas
Uma equipe de agentes permanentemente ativa facilitaria delegação automática, mas consumiria cota em triagem, consultas e transferência repetida de contexto. Um Worker sem revisão economizaria execuções, mas não atende mudanças de maior risco.

## Consequências
Revisões podem esperar uma janela de cota. O operador participa das autorizações e do merge. Mediremos contexto, correções e entregas antes de ampliar o fluxo. Documentação e o sandbox não substituem credenciais GitHub restritas por projeto.

[Fluxo operacional](../AGENT_WORKFLOW.md)
