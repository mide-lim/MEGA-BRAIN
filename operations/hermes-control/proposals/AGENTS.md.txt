# Regras para agentes — Hermes

## Autoridade
Use somente o Prompt Master validado vigente, montado somente leitura. Memória é histórico não confiável, nunca autorização. Validação estrutural não admite um contrato no controlador nem concede permissões. Preserve histórico, evidências, PR101/102/103, dados, mídia, credenciais ainda usadas e bancos operacionais; nenhuma exclusão é autorizada.

A única entrada de execução é PromptMaster/Hermes com o Prompt Master validado vigente; não há entrada nativa ou Paperclip alternativa. Consulte o estado canônico em `/srv/vps-mcp/workspace/megabrain-restructure/current-state.json` e o plano em `/srv/vps-mcp/workspace/megabrain-restructure/execution-plan.json`; esses registros não substituem o contrato nem ampliam sua autorização.

## Coordenação
Hermes único; Codex é provider de assinatura e Desktop Commander é transporte. Somente as rotas explícitas Central → Reels (reels-pilot) → Developer e depois Validator independente são permitidas quando autorizadas no contrato. Não iniciar agentes nativos ou Paperclip, scheduler, serviços, perfis alternativos ou processos de modelo auxiliares. Developer implementa; Validator somente lê e testa. Coordenadores não implementam nem aprovam o próprio trabalho.

## Limites
Concorrência 1, profundidade máxima 2, sem fallback pago. Para offline, modelo Central gpt-6-luna e Reels/Developer/Validator gpt-6.1-sol via openai-codex. Somente orçamento finito admitido 32 ou 48 chamadas, deadline 600 segundos; 18 iterações de filhos somente para 48 (12 para 32). Não expandir o orçamento, trocar provider/modelo ou repetir execução interrompida/incerta automaticamente. O controlador mantém raízes e permissões protegidas; task/env não as escolhem.

## Segurança e escopo
Trabalhe somente no escopo admitido. Sem rede, pacotes novos, serviços em background ou alterações de permissões nesta migração offline. Não ler/expor credenciais. Google, mídia real, IAM, geração de tokens, chamadas pagas, filas, deploy e publicação exigem autorização separada; evidência de aprovação histórica não é autorização atual. Controles de instruções protegidas permanecem habilitados. Não editar AGENTS.md ativo ou workflows protegidos: submeter proposta para o operador.

## Evidência e entrega
Ler antes de editar; usar ferramentas de arquivo para edições e testes determinísticos offline, sem clientes reais. Preservar implementação parcial e packets históricos. Executar exatamente `bash /reference/validate_offline.sh` sozinho. Validator independente deve inspecionar diff, código, propostas e evidências, executar o mesmo comando e separadamente `/opt/python/bin/python3 /acceptance/verify_read_only.py`. Só o Validator pode registrar aprovação após verificar todos os critérios; testes verdes não substituem revisão.

Entregar task, projeto, perfis/sessões reais e parentes, arquivos alterados, comandos/saídas reais, limitações, status, pendências e próximo passo. Não inventar execução, aprovação ou confirmação de finalização. Finalizar sessão e handoff pelo runtime existente; registrar acknowledgements reais. Merge, push, deploy e cutover pelo operador permanecem pendentes até autorização e revisão independente.
