# Diagnóstico de obtenção de mídia

Uma falha de upload continua pausando o lote e preservando a reserva. Não há repetição automática, mudança de formato, uso de cookies, nova chamada de IA ou nova infraestrutura.

O job registra `failure_diagnostic.operation_step`: `download_media`, `inspect_download` ou `persist_download`. Quando a falha ocorre na ferramenta de download, o campo `download` acrescenta:

- Última fase observada: metadados, seleção de formato, transferência, união de áudio/vídeo, remux ou validação do arquivo. Sem marcador reconhecido, registra `unknown`. `phase_source` distingue uma fronteira controlada pelo código de uma mensagem da ferramenta; não é uma prova da causa raiz.
- Causa relatada: HTTP 403/404/429, autenticação exigida, conteúdo indisponível, formato indisponível, rede, timeout, interrupção, saída excessiva ou arquivo inválido. Mensagens não reconhecidas permanecem desconhecidas. HTTP 403 não significa automaticamente login exigido, e 404 não comprova exclusão definitiva.
- Código de saída, duração da tentativa em milissegundos e versões reconhecidas de yt-dlp e FFmpeg. As consultas locais de versão têm limite de dois segundos cada, não fazem acesso à rede e só ocorrem após falha. Versão não obtida fica nula, sem substituir a falha original.

Mensagens persistidas são padronizadas. Não se guarda stderr/stdout bruto, comando, URL, título, caminho temporário, cabeçalho, cookie ou credencial. A saída da ferramenta é examinada somente em memória, com limite; o serializador revalida os campos antes de persistir. Até a exceção propagada pelo download substitui o texto bruto por uma mensagem segura.

O download continua sendo uma única chamada, com os mesmos limites de tamanho/tempo e todas as opções de retry em zero. O diagnóstico não dispensa a conciliação de uma tentativa anterior. Os testes simulam falhas, incluindo segredos em saídas, falha ao consultar versões, formato desconhecido, arquivo ausente, timeout e interrupção. Também verificam pausa, retenção de reserva e ausência de repetição/etapas pagas.

## Verificação no ambiente real

Os registros antigos que guardaram apenas código 1 não permitem recuperar retroativamente a mensagem perdida. Depois da revisão e publicação, começar por metadados no ambiente autorizado, sem download ou IA; registrar fase/código/versão, sem concluir que sucesso em outra máquina prova sucesso no Cloud Run. Acesso ou autenticação exigidos devem ser respeitados, sem fallback com cookies. Antes de outra tentativa de download, conferir artefatos e reserva da tentativa anterior e registrar a decisão. Não limpar jobs nem liberar reservas por suposição.

## Consulta restrita no worker

`POST /tasks/diagnose` usa a mesma verificação OIDC da identidade `v0-queue` e a mesma fila privada, com concorrência 1 e uma tentativa. O corpo contém somente `videoId` e `jobId` da tentativa de upload incerta. Exige vídeo elegível no lote configurado e pausado, automação desligada, reserva incerta e job original incerto. A origem vem do vídeo persistido, nunca do pedido. Não altera permissões nem cria serviço.

Antes de consultar a origem, cria atomicamente `jobs/probe_<jobId>`; pedidos duplicados ou uma interrupção não repetem a consulta. A pausa é conferida novamente depois do registro. O operador mantém o lote pausado durante a consulta. O diagnóstico usa `--skip-download`, o mesmo seletor de formato, retries zero, timeout de 20 segundos e saída em memória limitada a 1 MiB. Não chama transcrição/IA, não baixa nem persiste mídia, não despacha próxima etapa e não altera vídeo, tentativa original ou livro financeiro. O custo operacional pequeno do worker/metadados pertence à margem de infraestrutura já autorizada; não se presume custo zero de nuvem.

O registro contém somente status e diagnóstico sanitizado. `metadata_available` confirma apenas a consulta de metadados e seleção de formato; não valida transferência, união, áudio ou persistência do arquivo. A causa do erro histórico pode continuar desconhecida. Falha na gravação ou interrupção deixa o registro `started` para conferência, sem liberação automática.

Procedimento após revisão e publicação:

1. Confirmar imagem/commit publicado, fila vazia, lote e automação pausados; conferir artefatos e reserva da tentativa original.
2. Criar deliberadamente uma tarefa com nome determinístico `probe_<jobId>`, rota `/tasks/diagnose`, corpo restrito e OIDC/audiência existentes. Manter a política da fila (concorrência 1, uma tentativa). Retomar a fila somente para essa consulta e pausá-la ao terminar; o processamento permanece desligado nos controles.
3. Ler `jobs/probe_<jobId>`. Falha de autenticação encerra a operação. Não usar cookies nem limpar o registro para tentar novamente. O resultado não autoriza conciliar uma reserva sem evidência nem iniciar outros vídeos.

## Validade financeira explícita

O limite máximo de `balance_max_age_seconds` passa a 86400 (24 horas). O padrão e valores existentes continuam em 3600: a ampliação exige ajuste operacional explícito após publicação. Observações de crédito e estimativas de custos persistentes são aceitas por até 24 horas; o prazo de encerramento dos custos persistentes também continua obrigatório.

Não renovar `balance_observed_at` ou `ongoing_costs_observed_at` para contornar validade. Preservar o horário real da observação já registrada. Saldo, margem da conta, teto do lote, custos persistentes, reservas, cobertura, margem de 72h antes do vencimento e bloqueio de repetição continuam sendo verificados em cada reserva/início. Uma observação não reativa o lote, não amplia por si só a janela configurada e não libera reserva incerta. Após 24h é necessária evidência atualizada.
