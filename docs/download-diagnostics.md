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
