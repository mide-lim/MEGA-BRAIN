# Classificação por categorias oficiais

A navegação e as próximas análises usam o catálogo de `google-v0/lib/category-taxonomy.mjs`. Ele contém IDs estáveis, nomes de exibição e destinos de rótulos antigos. Não cria novos ramos; aproveita os nomes integrados no PR 17.

## Novas análises

O pedido ao Gemini inclui opções de categoria derivadas do catálogo. O schema restringe `categories` aos IDs oficiais. A entrada de resposta no worker verifica IDs, lista não vazia e duplicatas antes de publicar. A resposta bruta continua preservada pelo fluxo existente. A análise revisada recebe `category_taxonomy_version`.

Uma fonte pode receber várias categorias. Quando a árvore não servir, o modelo deve usar `a-organizar`. Assuntos específicos permanecem nas palavras-chave com evidências. Escolher um ID válido não prova que o enquadramento está correto; a revisão editorial continua necessária.

## Resultados anteriores

As categorias originais não são reescritas. A navegação interpreta IDs novos e os rótulos antigos pelo mesmo catálogo. Os agrupamentos abaixo são decisões editoriais de navegação, não declarações de sinonímia exata.

| Rótulo antigo | Decisão |
| --- | --- |
| Casa e Arquitetura | Casa e estilo / Casa e decoração |
| Alimentação Saudável | Alimentação / Nutrição |
| Viagens e Turismo | Viagens e lugares / Destinos e experiências |
| Dicas de Restaurantes | Alimentação / Culinária e Viagens e lugares / Destinos e experiências |
| Gadgets | Tecnologia / Hardware e setup |
| Branding | Trabalho e negócios / Marketing e comunicação |
| Casa | Coberto quando já existe um caminho em Casa e estilo; caso contrário, A organizar |
| Negócios | Coberto quando já existe um caminho em Trabalho e negócios; caso contrário, A organizar |
| Saúde | Coberto quando já existe um caminho em Saúde e bem-estar; caso contrário, A organizar |
| Pães, Café da Manhã, Inovação, Esportes, Pratos Principais, Petiscos | Assuntos preservados no rótulo original; não criam ramo nem caminho adicional |

Um assunto sozinho fica em A organizar. Se uma categoria já organiza a fonte, esses assuntos não criam uma pendência artificial. Rótulos desconhecidos continuam gerando A organizar mesmo quando coexistem com categorias conhecidas. Isso não equivale a ignorar automaticamente qualquer novo rótulo.

Os termos amplos não escolhem um filho por aproximação. Por exemplo, Saúde com Nutrição mantém Nutrição e uma pendência para Saúde: a árvore não possui um filho geral de saúde. O conteúdo não é descartado nem forçado para Exercício físico ou Bem-estar.

## Verificação e publicação

Testes com fontes fictícias cobrem a correspondência entre schema e navegação, múltiplas categorias, nomes equivalentes, assuntos, termos amplos, desconhecidos e resposta inválida no adaptador do worker. Os dados reais e a conferência individual do piloto ficam privados.

A entrega não reanalisa vídeos. Publicação requer revisão independente do commit final e aprovação do proprietário. O processamento e a ampliação do corpus continuam sujeitos aos controles existentes.
