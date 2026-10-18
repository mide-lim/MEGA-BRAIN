# Catálogo contextual das publicações salvas

## Navegação e significado

A Biblioteca conserva os grandes grupos e as classificações existentes. Em
Alimentação → Receitas e preparo, os formatos são **Receita única** e **Várias
receitas**. Um vídeo com duas porções, muitos ingredientes, várias etapas ou uma
substituição continua podendo ser uma receita. Uma coleção exige preparações
independentes identificáveis na fonte salva.

Frango, Ovo e outros ingredientes são filtros contextuais. Eles não representam
categorias por vídeo nem afirmam ingrediente principal, presença em todas as
preparações ou completude da receita. O volume é contado por identidade única do
Reel. Filtros combinados na mesma preparação exigem associação comprovada; a
revisão do formato não inventa essa associação.

Limites de acompanhamento e variações ambíguas ficam desconhecidos. Essa lacuna
não cria falha de processamento e não dispara uma análise paga.

## Fontes preservadas e cobertura

O bootstrap desta entrega usa a observação identificada do acervo publicado e
suas análises salvas. A fonte nativa aceita tem prioridade; o conteúdo legado é
fonte principal somente quando não há publicação nativa disponível. Uma cópia
legada alternativa não é uma segunda publicação nem uma dependência semântica da
publicação nativa.

Cada identidade recebe uma contribuição ou um diagnóstico explícito de falta de
fonte. Avaliar documentalmente todo o inventário não certifica a precisão
semântica dos vídeos. Contextos salvos, provas literais, atributos não verificados,
ausências e incertezas são mostrados separadamente. O acervo legado continua na
Biblioteca mesmo quando não tem os campos estruturados novos.

Anotações independentes são feitas pelo cargo Revisor em execução Codex nativa,
sem novo provedor ou reprodução audiovisual. Elas são seladas antes de comparar
previsões. Uma anotação usada como entrada de revisão não é uma amostra de
validação externa do mesmo formato. Os hashes vinculam a publicação original,
o texto salvo, a regra e a revisão; mudanças invalidam a contribuição anterior.

## Atualização por publicação

O catálogo mantém uma contribuição metadata-only por Reel em
`reels_index/contextual_{id}`. Uma publicação aceita, correção ou mudança
editorial substitui somente a contribuição afetada. Identidade de publicação,
versões de fonte, prova, política e edição determinam a chave de idempotência.

A transação verifica as versões da fonte, taxonomia, revisão independente e
contribuição anterior. Evento antigo não substitui publicação nova. Edições
manuais e supressões prevalecem. Consultas GET não escrevem e não chamam
Instagram, transcrição ou modelos; o detalhe de um único Reel pode carregar suas
provas salvas sob demanda.

Uma publicação já durável não vira falha nem repete análise por erro de índice.
O marcador de manutenção e sua recuperação devem sobreviver ao intervalo entre
a publicação e a atualização do catálogo. Recuperação dessa manutenção trata
apenas dados salvos.

## Bootstrap e visibilidade

O plano é preparado exclusivamente no GitHub Actions. Fontes brutas e anotações
seguem em artefatos privados temporários, com limites, hashes e identidade de
cada execução; os corpos não entram no histórico Git.

O operador revisado escreve somente contribuições, revisões derivadas e os dois
registros de configuração previstos. Não reescreve análises, mídia, históricos
ou casos operacionais incertos. Como o pacote pode exceder quinhentas gravações,
os lotes usam transações próprias e permanecem invisíveis enquanto o manifesto
está ausente. A transação final relê as fontes e dados determinantes antes de
ativar o manifesto e a taxonomia juntos.

Um manifesto ativo de outra operação interrompe o bootstrap antes de gravar.
A repetição da mesma operação só é concluída como idempotente após conferir
todos os dados. Resultado de gravação incerto exige leitura de conciliação,
nunca repetição de provedores. Falha de lote preserva os dados já gravados sem
expor um catálogo parcialmente ativo.

## Validação e operação

Contratos, Firestore isolado, corrida de versões, mudança manual, replay de
evento, revogação de revisão, conjunto exato de membros, navegação e imagens são
testados no GitHub. O parecer final se vincula ao commit e pacote exatos.

Instalar código de atualização incremental não autoriza processamento. A
publicação desta entrega conserva admissão, automação, filas e três etapas
fechadas. Uma execução futura de Reels exige a autorização operacional vigente.
