# Piloto Paperclip e Codex

O piloto valida o fluxo manual Paperclip → Codex → draft PR → GitHub CI para alterações de documentação neste repositório.

## Pré-requisitos

O operador deve publicar o baseline inicial e concluir os logins do ChatGPT e do GitHub antes da execução. O acesso ao modelo utiliza a assinatura ChatGPT, sem API paga.

## Limites de execução

- Um único agente, sem criação ou acionamento de outros agentes.
- Acionamento manual pelo operador, com uma autorização por execução.
- Concorrência máxima de 1 execução.
- Até 2 chamadas ao modelo em qualquer janela de 24 horas, com intervalo mínimo de 1 hora entre chamadas.
- Sem retry automático de modelo. Uma falha não autoriza uma nova chamada; qualquer nova execução depende de autorização e dos limites acima.

## Validação com ferramentas convencionais

Testes, CI e deploy usam ferramentas convencionais, sem chamadas adicionais ao modelo. Este piloto somente altera documentação: não altera infraestrutura, não executa deploy e não faz merge.

1. Criar a branch `docs/codex-pilot` a partir de `main`.
2. Atualizar esta documentação e seus links no README.
3. Executar `python3 scripts/check_links.py`.
4. Criar o commit e abrir um draft PR para `main` usando `gh`.
5. O operador verifica com `gh pr checks <numero-do-pr>` e, se necessário, `gh run view <id-da-execucao>`, que o workflow `Documentation CI` foi aprovado para o commit atual do PR.

O critério final é um PR aberto em modo draft e o `Documentation CI` aprovado, verificado pelo operador com `gh`, sem chamadas adicionais ao modelo. O merge permanece fora do escopo.

## Referências históricas

Backups históricos não comprovam serviços ativos nem a existência de serviços na VPS. Consulte as [referências históricas](HISTORY.md); qualquer avaliação operacional exige verificar o estado atual.

[Voltar ao início](../README.md)
