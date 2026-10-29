# Controles históricos Paperclip — não executar

Arquitetura atual: Hermes único, provider Codex e transporte Desktop Commander. Estes controles são preservados como evidência histórica, não são instruções de ativação. A cópia exata do workflow está em `history/paperclip-control.workflow.yml`; o workflow ativo permanece intocado até revisão independente e cutover pelo operador. Ver `../hermes/cutover.json` e `../../docs/HERMES-MIGRATION-2026-10-28.md`. Nenhum serviço ou contêiner foi alterado nesta tarefa offline.

Estes arquivos registram controles de execução para `/opt/paperclip`. A presença no repositório não comprova que a versão está instalada. Não contêm credenciais.

- `codex-pilot`: launcher montado somente para leitura no contêiner; exige login ChatGPT, trava global, packet válido, hash, tarefa, orçamento e autorização de uso único. Aceita execução Worker e correção explicitamente solicitada; recusa app-server e bypass do sandbox.
- `authorize-packet.py`: helper root para emitir uma autorização; valida packet, tarefa Paperclip, commit base, histórico e limites. `--dry-run` não cria autorização. Nunca inicia o agente.
- `admin_api.py`: acesso administrativo convencional com cookie em arquivo restrito; não incluir esse arquivo de cookie no Git.

A cópia de `scripts/check_task_packets.py` em `/opt/paperclip/packet-preflight.py` é montada somente para leitura como `/usr/local/bin/packet-preflight.py`. Alterar o verificador no repositório não promove automaticamente a nova versão para a trava instalada; a promoção é uma operação do administrador após revisão.

O runtime histórico Paperclip não provisionava Reviewer. O caminho Hermes usa Validator independente somente leitura; não criar autorizações Paperclip para esse papel com o helper histórico.

[Fluxo](../../docs/AGENT_WORKFLOW.md)

[Proposta de controle de tentativa única](SINGLE_ATTEMPT.md) — requer revisão independente e promoção administrativa.
