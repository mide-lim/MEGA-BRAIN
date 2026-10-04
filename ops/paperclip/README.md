# Controle de execução na VPS

Estes arquivos registram a implementação instalada em `/opt/paperclip`. Não contêm credenciais.

- `codex-pilot`: launcher montado somente para leitura no contêiner; exige login ChatGPT, trava global, packet válido, hash, tarefa, orçamento e autorização de uso único. Aceita execução Worker e correção explicitamente solicitada; recusa app-server e bypass do sandbox.
- `authorize-packet.py`: helper root para emitir uma autorização; valida packet, tarefa Paperclip, commit base, histórico e limites. `--dry-run` não cria autorização. Nunca inicia o agente.
- `admin_api.py`: acesso administrativo convencional com cookie em arquivo restrito; não incluir esse arquivo de cookie no Git.

A cópia de `scripts/check_task_packets.py` em `/opt/paperclip/packet-preflight.py` é montada somente para leitura como `/usr/local/bin/packet-preflight.py`. Alterar o verificador no repositório não promove automaticamente a nova versão para a trava instalada; a promoção é uma operação do administrador após revisão.

O runtime atual não provisiona Reviewer. Uma revisão por modelo exigirá sessão e ambiente de leitura independentes antes de habilitar o papel. Não criar autorizações para esse papel com o helper atual.

[Fluxo](../../docs/AGENT_WORKFLOW.md)
