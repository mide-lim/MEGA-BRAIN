# Task Packets

Um packet reúne o necessário para uma tarefa e deixa explícitos objetivo, aceitação, risco, commit de partida, caminhos permitidos, contexto selecionado, comandos e orçamento.

## Preparar
Copie [o modelo JSON](templates/task-packet.json) para `tasks/<identificador>.json`. Substitua todos os campos de exemplo, associe o UUID da tarefa Paperclip e fixe o commit base. Escolha caminhos específicos; um caminho terminado em `/` autoriza a subárvore, sem globbing. Nunca use caminhos absolutos, `..`, `.git`, arquivos de credenciais ou backups privados.

Para o contexto, indique arquivo, motivo, seções ou trechos, e um limite planejado de caracteres. O preflight aceita até 8 referências e 12.000 caracteres planejados somados. Isso limita o contexto selecionado, não todo o prompt interno do Codex/Paperclip. Não anexar a documentação inteira por padrão.

## Validar antes do modelo
- `python3 scripts/check_task_packets.py`: valida os packets em `tasks/`.
- `python3 scripts/check_task_packets.py --packet tasks/MEG-2.json --diff-base <commit-base> --diff-head HEAD`: também confere caminhos alterados e confirma o commit base.

O CI valida a estrutura e os links; o operador verifica o diff contra o packet da tarefa. O arquivo JSON não concede permissões do sistema nem restringe a credencial GitHub àquele repositório.

## Autorizar e executar
Na VPS, o operador usa `/opt/paperclip/authorize-packet.py --packet <caminho-no-host> --role worker`. O helper confere a tarefa, o orçamento e o histórico de execuções antes de emitir a autorização. Ele não inicia nem retoma o agente. O launcher verifica identidade da tarefa, hash, validade e packet antes de iniciar o Codex.

Uma autorização de reviewer exige o packet revisado com review independente, papel correto, outra sessão e configuração somente de leitura. O helper atual autoriza worker e uma correção (`--role fix`) registrada como `changes_requested`; reviewer permanece uma etapa manual até existir um ambiente de revisão independente. A documentação não habilita esse agente automaticamente.

Os limites globais continuam valendo. O packet [MEG-2](../tasks/MEG-2.json) exemplifica uma entrega convencional com orçamento de modelo zero; ele não pode autorizar o Codex.

[Revisão por risco](REVIEW_POLICY.md) · [Início](../README.md)
