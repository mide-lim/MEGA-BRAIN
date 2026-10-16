# MEGABRAIN - Reels v2 — contrato de integração

Fonte: plano canônico megabrain-reels-produto-v2.0, pedido humano de implementação em16/10/2026. Runtime Codex nativo; o launcher legado e seus limites não governam esta coordenação. Ler AGENTS e estado oficial antes de agir; instrução humana atual permite delegação. Esta entrega NÃO processa Reels, NÃO chama Instagram/STT/Gemini e NÃO apaga dados reais. Migração somente ensaio em cópia; processamento fica negado por padrão no servidor.

## Fonte e propriedade
Base main b96356878bdcef86adc961f0d008d2022c130e02, árvore8ba2370a8270d3d1133ed001ee0efff6e4e21e3b. Nova interface/serviços, contratos validados reutilizados. Sem fixtures/DEMO no build de produção. Banco/mídia existentes somente leitura nesta fase de validação. A API exige sessão da conta autorizada e mesma origem nas escritas.

## API estável para interface
Prefixo /api/reels. Respostas JSON no-store. Erros: {error, code, operationId?}; preservar mensagem segura. Paginação com cursor opaco, limite50 padrão, máximo100; todos os elegíveis considera todas as páginas e fixa IDs por operação.
- GET /summary => {counts:{registered,queued,running,waiting,completed,published,attention,total},observedAt,processingAllowed:false,processingReason}
- GET /items?workspace=all|library&q=&status=&stage=&category=&language=&tag=&sort=newest|oldest|title&limit=&cursor= => {items,total,nextCursor,observedAt}. Busca/filtros no servidor. Categorias e library só publicação válida categorizada.
- GET /items/:id => {item}. Caption/transcript/analysis/media detalhados sob demanda.
- POST /register {links} => {created,alreadyPresent,automaticProcessingStarted:false}
- GET /queues => {stages:[{id,name,queued,running,waiting,failed,uncertain,paused,desiredConcurrency,effectiveConcurrency,observedAt}],processingAllowed,processingReason}
- POST /preview {selection:{ids:[...]}} OU {selection:{all:true,filters:{...}}} => {ids,eligible,total,excluded:[{id,reason}],selectionToken?}. Prévia não despacha.
- POST /commands {idempotencyKey,type:start|retry|complement|pause|resume|capacity,selection?,stage?,concurrency?} => {operation:{id,type,status,accepted,excluded,createdAt,...}}. GET /commands/:id recupera comando após recarga. start/retry/complement retornam423 PROCESSING_DISABLED nesta entrega; habilitação futura só servidor, nunca flag do cliente.
- GET /events?cursor=&stage=&worker=&reelId=&level=&limit= => {items:[{id,at,reelId,stage,worker,level,type,message,operationId}],nextCursor,hasMore,observedAt}. Cursor estável e eventos persistentes, reconexão sem perda.
- GET /categories => {nodes:[{id,parentId,name,count,directCount,evidenceCount,manual}],total,revision,observedAt}
- POST /categories {idempotencyKey,action:create|rename|move|merge|reclassify|segment,revision,...}. Prévia de impacto antes de mudança ampla; evitar ciclos, deduplicar IDs, respeitar overrides. Revisor verifica operações exatas. Não importar regra lexical PR18.
- GET /finance?from=YYYY-MM-DD&to=YYYY-MM-DD => {days:[{day,admitted,completed,published,failed,estimatedUsd,measuredUsd,billed,uncertain}],budget:{amount,currency},coverage,observedAt,note}. Dados ausentes null/desconhecido, estimativa distinta de fatura. FusoAmerica/Sao_Paulo.
- POST /finance {idempotencyKey,amount,currency} altera referência informativa, nunca execução.

## Item da lista e detalhe
Lista leve: {id,sourceUrl,title,creator,language,createdAt,updatedAt,status,stage,categoryIds,tags,media:{available,posterUrl?},publication:{available,revision,qualityStatus,summary},error:null|{code,message,destination,stage,worker,retryable,uncertain}}. Status: registered,queued,running,waiting,completed,failed,uncertain. Stage: acquisition,transcription,analysis ou null. Não confundir completed com published.
Detalhe acrescenta caption:{state:present|empty|missing,text,source}, transcript:{state,text,segments}, analysis:{publishedAt,version,knowledge:{context,fields,missingInformation,keywords},summary,insights,visual,evidence}, candidate:{available,state,reason}, media completa e execuções quando disponíveis. Preservar análise publicada distinta do candidato; faltas explícitas, sem conteúdo inventado. Player usa endpoints privados existentes /api/video/:id e /api/media/:id.

## Interface de persistência entre agentes
ReelsRepository({store,clock?}), em lib/reels-repository.mjs; export default ou named ReelsRepository. Métodos async: list(query), detail(id), summary(), queues(), events(filters), categories(), finance(filters), select(selection), raw(id), registerLinks(text). Propriedade .store expõe get/create/patch; .raw(id) retorna vídeo original ou null. select retorna {ids,eligible,total,excluded}; não muta. A implementação pode separar modelo/índices para evitar baixar transcrições/análises na consulta. Mutações de comandos/taxonomia/financeiro são propriedade do serviço operacional. Alinhar qualquer ampliação desta interface via mensagem antes de escrever consumidor.

## Execução e integridade
Três etapas existentes: aquisição/preparo, transcrição e análise/validação/publicação. Executores reaproveitam adaptadores existentes; nenhuma inferência nova em testes. IDs determinísticos, claims create-only, CAS/outbox, resposta salva antes de publicar, STT por operationName; retry de entrega não repete chamada paga. Incerto não vira falha confirmada. Parâmetros financeiros nunca são gates; capacidade, identidade e integridade continuam técnicos. Considerar operações STT externas abertas na capacidade. Somente itens afetados isolados; incidente comum pode pausar etapa. Pausa coleta trabalho já enviado quando possível. Capacidade desejada distinta da efetiva.

## Migração e aceite
Manifesto por ID: preservar sucesso e gerações/hash; erro confirmado pode entrar limpo em novo cadastro somente depois do ensaio validado; ativo/incerto retido para conciliação. Nunca limpar origem em comando de ensaio. Backup/restauração, corte de um único escritor, repetibilidade e reversão preservando escritas pós-corte. O produto completo inclui todos os workspaces; desenvolvimento não aparece no produto. Revisão independente sobre versão exata e testes significativos antes de publicação.

## Recorrências verificáveis e validação desta entrega

O contrato opcional v2 `analysis.taxonomySignals` descreve preparações completas, suas fontes literais e intervalos. Uma preparação sustenta Receita única; várias preparações independentes sustentam Lista de receitas. O serviço só cria filhos quando pelo menos três publicações sustentam o mesmo padrão, com confiança mínima de0,8, e preserva ajustes manuais. Sem sinais, a publicação permanece válida; a cobertura indica necessidade de complemento solicitado. Este primeiro contrato automático cobre estrutura de receitas. Outros padrões exigem contratos de evidência próprios, sem inferência por palavras soltas.

Novas publicações alimentam um índice compacto incremental; a avaliação manual do legado é explícita e limitada a500 publicações por chamada, com cursor de continuação. Comprovantes e recibos não devem crescer sem limite no documento raiz. GET de categorias apenas lê a última cobertura datada.

Builds, suites e jornadas de navegador desta versão rodam exclusivamente em GitHub Actions, sem credenciais de provedores. A VPS recebe somente operações leves de contexto/transporte/versionamento. Workers novos ficam desabilitados e a web fixa processamento emfalse; testes com adaptadores em memória não comprovam operação real. Nenhuma exclusão ou corte de escritor é executado pelo ensaio de migração.
