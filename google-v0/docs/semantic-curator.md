# Curadoria semântica do acervo salvo

O curador compara o significado e a finalidade do conhecimento já publicado. Ele usa textos das análises, legendas e transcrições preservadas. Não baixa Reels, não envia vídeo/áudio ao modelo e não refaz STT.

## Produto e responsabilidades

- **Filas** acompanha aquisição, transcrição e análise até uma publicação aceita.
- **Categorias** organiza o conhecimento publicado: contextos, formatos, padrões, propostas, critérios e evidências.
- **Biblioteca** usa a mesma árvore e os mesmos membros aprovados. Ingredientes são filtros; não se transformam em uma categoria por ocorrência.
- Receita única e Várias receitas usam os formatos canônicos. Ingredientes, etapas e variações incompletas não contam como preparações independentes.
- Edições manuais têm prioridade. Lacuna de conhecimento e abstenção semântica não são falhas de processamento.

## Execução durável

A prévia fixa IDs, revisões das fontes, política e limite de chamadas. Criar um trabalho persiste a autorização/coorte e uma entrega antes de iniciar a inferência. GETs nunca iniciam inferência.

O trabalho tem três fases: extração em lotes de textos, consolidação das definições e verificação das associações contra os textos originais. As respostas recebidas são guardadas antes de analisar JSON ou aceitar evidências. Modelo, solicitação, uso, fonte e revisão ficam registrados.

A fila dedicada `v0-curation` entrega apenas IDs persistidos à rota `/tasks/curation` do serviço de análise, com a identidade OIDC existente. A continuidade não depende da página aberta. Essa rota tem autorização própria de metadados e não abre `/tasks/run` ou `/tasks/control`.

O pacote inicial se limita às 499 publicações salvas, com 301 fontes principais nativas e 198 preservadas do legado. Os 738 documentos originais permanecem intactos. O ensaio com provedor sintético verifica essa cobertura e preservação; ele não mede precisão semântica.

## Qualidade e promoção

Uma proposta registra definição, aliases, critérios positivos/negativos, membros, papel do elemento, unidades e citações com campo de origem. A verificação é outra fase de IA com recibo próprio; não é, sozinha, uma medição independente de acurácia.

A promoção automática exige política habilitada, fontes atuais, verificação dos membros e calibração da definição exata. O avaliador offline compara as associações salvas com anotações independentes, separando treino e holdout. Exige ao menos 20 exemplos de holdout por definição, cinco positivos e cinco negativos corretamente reconhecidos, precisão mínima de95% e recall mínimo de80%. Abstenções positivas contam como falsos negativos. Rótulos de formato não certificam segmentos de outro assunto.

Sem calibração suficiente, as propostas continuam consultáveis e podem receber aprovação editorial explícita. Não declarar os 499 como semanticamente certificados só porque a leitura terminou.

O comando `reconcile_saved` reaplica somente um resultado já persistido, com conferência das versões. Resultado pago incerto sem resposta durável permanece separado; não há repetição automática da chamada.

## Catálogo no worker final

O worker carrega o catálogo vigente imediatamente antes de montar cada nova solicitação de análise final. A leitura usa definições aprovadas, critérios, versões e proteção manual atuais, sem reutilizar um snapshot antigo da configuração.

A solicitação e a resposta bruta ficam vinculadas ao snapshot e a seu recibo. Catálogo indisponível, desatualizado ou acima do limite é explícito. Conferir uma resposta já salva não recarrega o vídeo nem repete inferência.

Novas publicações ou mudanças de fonte não concedem automaticamente autorização para outra curadoria paga. A autorização finita e os limites de processamento dos Reels continuam separados.

## CI e operação

Todos os testes, a preparação e os builds de produto rodam no GitHub Actions:

- `Semantic curator`: contratos adversariais, acervo salvo499 com provedor sintético e jornada do Workspace com API real.
- `Google v0 integration`: integração, imagens, importações empacotadas e bloqueios de execução.
- `Frontend browser QA`: regressão de navegação, comandos e atualização silenciosa.
- A calibração offline usa `google-v0/scripts/calibrate-semantic-curator.mjs`, somente com avaliações e fontes salvas.

O pacote de recursos revisado deve criar a fila vazia, pausá-la e conferir seu estado antes de conceder produtores. As únicas novas permissões propostas são o papel existente `taskDispatcher` para `v0-web` e `v0-worker` nessa fila. O papel contém apenas criar e conferir tarefas. A conta OIDC e o acesso ao serviço de análise já existem.

Criação, concessões e ativação dependem da autorização do pacote exato. Não criar contas/chaves, conceder papéis no projeto, retomar filas de Reels, modificar os49 resultados incertos ou apagar fontes. Publicar código fechado e passar no CI não equivale a executar a curadoria real.

Modelos e limites são configurados na política finita. O modelo planejado para a primeira operação de texto é `gemini-3.5-flash`, com saídas estruturadas e sem ferramentas externas; a disponibilidade e o contrato são documentados pela [Google](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/gemini/3-5-flash). O uso não herda autorização para reanalisar vídeo/áudio.


## Structured transport and verification coverage

The provider transport uses the versioned flat schema. Types, finite IDs and enums constrain generation; the server contract remains responsible for exact cardinalities, literal quotations, recipe formats, facet dimensions and all cross-field rules. Reducing schema complexity is not proof that a remote provider accepts it or that its semantic conclusions are accurate.

Verification eligibility is computed from the same current memberships and negative examples used by normal verification. An empty eligible range receives a `semantic_no_targets` receipt with `semanticVerified: false`, source and group epochs, and zero calls. Job, policy, ledger, source, existing group and exclusive-coordinator checks are committed together. The coordinator enforces the existing single-writer protocol; this is not a collection transaction against arbitrary external database writers. `verificationProcessed` records ranges traversed for compatibility; `verificationSkippedSources` and `verificationTargetDecisions` distinguish skipped sources from actual decisions.

## Historical finite corrective owner operation

A rejected-attempt preparation receipt cannot execute work. The separate owner capability is restricted to the recorded incident, original cohort, policy, source epochs and approved prompt. It preserves the old intent and consumed counter; a corrective submission receives a new attempt identity and consumes the third attempt. It then stops at the exact 16-source/3-attempt checkpoint. The original normal 16/2 checkpoint remains separate. No browser request may manufacture this capability or supply its own approval actor.

The owner client has `prepare` and `apply` modes. Preparation reads current metadata and emits a bounded review request. Application requires pinned packet, deployment, approval and independent-review files, verifies the private owner account, refreshes the same protected conditions and attempts one three-write transaction. An ambiguous acknowledgement permits one readback and no commit retry. It cannot call inference, storage media, worker endpoints or mutate queues. Queue delivery remains a separate explicitly authorized operation.

Builds, contract checks, rehearsal and HTTP/browser fixtures run in GitHub Actions. The owner source archive contains tracked application libraries and the operator only, without Reel inputs, runtime credentials or temporary historical provider copies. Live release and any corrective inference still require their explicit authorization and the real quality checkpoint; synthetic completion does not certify the published collection.


## Domain curation of saved publications

Domain profiles specialize interpretation for Food, Technology, Health, Work, Home, Travel and unresolved destinations while sharing one versioned contextual catalogue. A routing hint from an existing category is not a newly certified semantic classification. Unresolved destinations retain their original analysis and show source/acceptance gaps or supported destination suggestions; an isolated ingredient does not become a category.

The read-only domain view and manual editorial controls render independently of category-tree loading. Ordinary editable categories, semantic groups and virtual format views expose different capabilities. Navigating or refreshing never starts inference. Domain filters apply before pagination and to both facet queries.

New domain execution is opt-in and needs a source-bound manifest and an independently reviewed owner authority. The legacy job and its uncertain attempt remain preserved. A versioned quarantine must prevent old deliveries from submitting again before a different authorized job can acquire the global coordinator. Previously applied sources and protected uncertain sources are excluded from new extraction. The global authorization pool includes historical attempts; its ceiling is shared rather than multiplied by the number of profiles.

Request planning measures the complete serialized body including instructions, response schema, catalogue and source text. Byte counts are exact; the conservative token proxy is explicitly an estimate, not CountTokens or provider usage. Oversized sources and insufficient authorization are reported instead of silently dropping evidence. The model reference currently documents a 1,048,576-token context window for Gemini 3.5 Flash; a request size in bytes alone does not establish that the historical400 was a context overflow. See [model reference](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/gemini/3-5-flash) and [structured output considerations](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/capabilities/control-generated-output).

GitHub Actions is the only product test/build/rehearsal environment. Saved-source domain measurements, synthetic runtime tests and browser journeys validate preservation and orchestration; they do not certify live Gemini acceptance, semantic precision or actual reclassification of the current archive.

The prior corrective-owner packet is historical and is not a domain activation capability. The domain manifest, quarantine authority and shared pool require their own exact review; installing this code or opening a domain never installs that authority.
