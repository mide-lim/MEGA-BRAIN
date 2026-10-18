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
