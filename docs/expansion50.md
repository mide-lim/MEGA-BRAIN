# Expansão autorizada de cinquenta vídeos

O proprietário autorizou mais 50 vídeos e escolheu teto total de R$300 mantendo as reservas fixas por etapa. Quatro adicionais já foram aceitos; o quinto produziu resposta preservada com categoria específica e genérica redundantes. Restam 13 IDs do lote original sem tentativa e 32 links novos preparados. Os dois casos problemáticos anteriores permanecem preservados, sem repetição.

## Capacidade necessária

O perfil legado de 30 IDs/R$150 mantém limites de 200 operações e 400 objetos. O novo perfil exato de 62 IDs/R$300 permite 400 operações e 800 objetos. Não aceita combinações arbitrárias de quantidade e orçamento. A extensão adiciona exatamente 32 IDs novos, preservando os 30 anteriores, identidade do lote, jobs, custos contabilizados e reservas. Filas e controles continuam pausados na preparação. O limite de tamanho do documento, orçamento, vencimento, concorrência 1 e bloqueio de replay permanecem.

`node google-v0/scripts/extend-batch.mjs entrada.json plano.json` gera somente plano privado offline; não acessa Google nem inicia processamento. A entrada contém `financial`, `capacity`, `existing_video_ids`, 32 `candidates` com id/url e `authorized_budget_cents: 30000`. O script recusa sobrescrever o destino. O plano não é autorização automática para ativar.

Com as reservas de upload 50, transcrição 120 e análise 250 centavos, todos os 62 IDs completos exigiriam R$260,40 em etapas, mais R$24 de margem. O lote real consome menos porque o upload antigo abandonado não iniciou STT/IA. Esses números são envelopes conservadores; não são gasto medido ou fatura. Histórico de outras operações fica fora desse total de lote e permanece no livro da conta.

## Categoria genérica redundante

Quando exatamente dois IDs oficiais únicos incluem `tecnologia-geral` e uma categoria específica da mesma família Tecnologia, a revisão conserva somente a categoria específica e registra a remoção nas limitações. Não depende do ID do Reel, palavras-chave ou tema particular. Não corrige labels desconhecidos, categorias duplicadas, excesso de IDs, combinação com outra família ou `a-organizar`. O validador público continua rejeitando combinações inválidas.

A normalização ocorre na cópia analisada depois que o raw foi persistido. Fontes, evidências e raw original ficam intactos; as demais verificações continuam obrigatórias. Um replay offline da resposta já recebida do Pwnagotchi foi aceito em `hardware-setup`, com zero chamadas de IA. Isso não altera dados publicados por conta própria nem comprova fatos técnicos do autor.

## Aplicação depois da revisão/publicação

1. Confirmar versão publicada, fila vazia e pausada, controles desligados e nenhuma etapa do lote em andamento/incerta. Conferir os 32 candidatos e admitir cada nova mídia com os limites existentes; sucesso de metadados em outro ambiente não garante download no Cloud Run.
2. Gerar plano contra estado atualizado. Aplicar em commit condicional conjunto: lote 62/R$300, limite de claims 800, registro dos 32 vídeos e auditoria. Não trocar identidade de jobs, apagar histórico, renovar observações antigas ou zerar contadores. Atualizar configuração do worker com os mesmos 62 IDs antes de ativar; preservar quotes e demais parâmetros. Comparar todos os campos não alterados.
3. Recuperar a resposta preservada do Pwnagotchi somente após verificar hash, geração, job financeiro concluído e replay aceito da versão revisada. Publicar o report validado e auditoria; não submeter novo modelo ou cobrar a etapa novamente. Manter os dois casos anteriores pendentes.
4. Retomar um vídeo por vez até completar o pedido, com parada em falha operacional ou resultado que ainda exija revisão. Liberar reprodução apenas dos aceitos, preservando franquia/consumo. Conferir títulos e campos em português; nomes próprios/técnicos e evidências literais originais permanecem.

Não há novas categorias, graph database, novo serviço ou revisão de estimativa pelo uso neste escopo. A opção escolhida mantém o cálculo fixo; timestamps e melhorias de validação permanecem no backlog.
