# Segredos e ferramentas governadas

## Escopo
Não acessar ou propor segredos sem necessidade e autorização da tarefa. Credenciais administrativas ou de infraestrutura permanecem com o operador. Uma referência lida ou interação aceita não concede acesso.

Quando um segredo for autorizado: liste apenas metadata disponível ao run antes de buscar o valor específico necessário. Use o run JWT atual; não tente chave longa, token de review, bridge sem esse alcance ou outro tipo recusado. Nunca imprima, persista ou cole o valor em comentários/planos/arquivos/logs. A leitura é auditada, inclusive falhas. Não aumente bindings por conta própria.

Se receber credencial autorizada, use a proposta segura de segredo, sem reproduzir o valor. Antes de propor ou buscar, a integração precisa disponibilizar o schema upstream de secret proposals/secret reads. Na ausência dele, pare e solicite ao operador o canal apropriado; não escreva o segredo em arquivo “temporário” ou na descrição.

## Aprovação MCP
Ferramenta ask first pode retornar approval_required. Não repetir enquanto pendente; concluir trabalho independente permitido, registrar espera e manter caminho real em in_review.
Aprovação significa aprovar e executar os argumentos armazenados. Se o wake informar execução, use o resultado e não chame novamente.
Rejeição significa que não executou; seguir o motivo, sem repetir a mesma chamada.
Expiração/idempotência precisam do estado real do gateway. Este perfil não relança modelo para renovar uma aprovação.
approval_path_missing indica ausência de tarefa checked out: não contorne a associação. Confirme contexto/checkout na execução autorizada; se impossível, pare.

Não troque autenticação nem enfraqueça validação de identidade para resolver 401/403. Informe endpoint/estado sem token e escale a correção ao operador.
