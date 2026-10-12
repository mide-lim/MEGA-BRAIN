# Classificação por categorias oficiais

O catálogo `google-v0/lib/category-taxonomy.mjs` define IDs, nomes, limites de uso e compatibilidade. A versão `categories-v2` organiza a navegação por um destino principal por fonte. Categorias e Livro usam o mesmo destino, inclusive no cartão do Livro.

## Destinos claros

| Destino | Finalidade |
| --- | --- |
| Alimentação / Receitas e preparo | Ensinar receitas e técnicas culinárias. Unifica Receitas e Culinária. |
| Alimentação / Nutrição e suplementação | Explicar alimentação, nutrientes, dietas e suplementos. Mencionar proteína numa receita não basta. |
| Viagens e lugares / Onde comer | Recomendar restaurantes, cafés e estabelecimentos. Não é preparo de comida. |

Os demais destinos têm seu limite descrito em `scope` no catálogo e no pedido de análise. O ID `receitas` permanece estável; o antigo ID `culinaria` é aceito na leitura e encaminhado para Receitas e preparo, mas não é mais gerado. `nutricao` permanece estável. Onde comer ganha o ID `onde-comer`.

## Novas análises

O primeiro ID de `categories` representa a finalidade principal do vídeo. Prefere-se uma categoria; no máximo uma segunda pode registrar outro assunto substancial e independente. Ingredientes, ferramenta usada, setor de uma marca e menções incidentais ficam nas palavras-chave. Apenas o destino principal participa da árvore: categorias secundárias não multiplicam os resultados.

O schema e a validação verificam IDs oficiais, lista não vazia, limite de dois e ausência de duplicatas. `a-organizar` e `tecnologia-geral` são exclusivos. O enum não prova adequação semântica: a qualidade de novas classificações exige avaliação com conteúdo novo. A taxonomia não confirma alegações do autor.

## Resultados anteriores

Nenhuma análise é reescrita. O resolver preserva os destinos candidatos, assuntos e rótulos pendentes, mas a navegação utiliza somente `primaryId`:

1. Interpretar os rótulos na ordem original e unir aliases equivalentes.
2. Preferir um destino específico a Tecnologia geral. Onde comer tem preferência sobre Destinos e experiências quando ambos estão presentes.
3. Usar o primeiro destino restante. Esta é uma compatibilidade determinística para o legado, não uma inferência semântica sobre todos os vídeos futuros.
4. Usar A organizar apenas quando nenhum destino válido existir. Um rótulo desconhecido junto de um destino válido continua em `unresolved`, sem acrescentar Outros temas.

Exemplos: Saúde + Nutrição fica em Nutrição e suplementação, mantendo Saúde pendente; Receitas + Culinária fica uma única vez em Receitas e preparo. Gastronomia isolada é ampla demais para distinguir preparo de recomendação de estabelecimento e fica pendente. Dicas de restaurantes vai para Onde comer. Rótulos amplos não inventam filhos específicos.

Os assuntos originais permanecem na análise, sem converter automaticamente rótulos antigos em palavras-chave com evidência. A leitura não altera transcrições, evidências, análises candidatas ou suplementos de conhecimento. Sem análise/categorias não se fabrica uma classificação.

## Verificação e publicação

Testes fictícios cobrem união, destino principal, desconhecidos, categorias genéricas, compatibilidade, contagens sem sobreposição e limites no worker. A comparação individual das 20 fontes e os motivos editoriais permanecem privados. O destino principal do legado depende da ordem e qualidade dos rótulos; os 20 casos foram conferidos, não os demais links do corpus.

Publicação requer revisão independente do commit final e aprovação do proprietário. A entrega não reanalisa vídeos nem amplia o corpus.
