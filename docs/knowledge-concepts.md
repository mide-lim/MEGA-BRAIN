# Vocabulário conceitual do conhecimento

Proposta para a fase 1. Este documento define termos para revisão; não altera o schema, a taxonomia, as análises ou o banco.

## O que já existe

O código em [knowledge.mjs](../google-v0/lib/knowledge.mjs) representa conhecimento dentro de uma análise por vídeo: contexto, palavras-chave, campos tipados, evidências e informação ausente. O código em [category-display.mjs](../google-v0/lib/category-display.mjs) organiza rótulos em uma árvore de navegação, preservando as categorias originais.

Campos com evidência são uma base reutilizável. Eles não equivalem, por si só, a itens independentes com identidade estável, integração entre vídeos e controle de versões.

## Termos e responsabilidades

| Termo | Definição | Limite |
|---|---|---|
| Fonte | Material de origem, como vídeo, transcrição ou legenda capturada | Preservar identidade e versão; uma nova interpretação não substitui o original |
| Evidência | Trecho ou observação que sustenta uma informação, com referência à fonte e localização quando aplicável | Presença de evidência não comprova automaticamente interpretação correta |
| Campo extraído | Valor estruturado identificado na análise, com tipo e evidências | Um ingrediente ou nome de ferramenta não é necessariamente uma afirmação completa |
| Item de conhecimento | Afirmação útil e delimitada, vinculada às fontes e evidências que a sustentam | Modelo futuro da fase 2; ainda não é uma coleção implementada |
| Entidade | Algo identificável no domínio: ferramenta, organização, ingrediente, lugar ou produto | Não confundir o nome apresentado com sua identidade canônica |
| Alias | Nome alternativo verificado de uma mesma entidade ou rótulo | Semelhança de escrita ou assunto não basta para declarar equivalência |
| Tópico | Assunto específico que reúne conhecimentos relacionados | Pode atravessar categorias e evoluir; clustering será avaliado posteriormente |
| Categoria | Classe usada para organizar e filtrar o acervo | Uma decisão de navegação não constitui um fato sobre a fonte |
| Contexto | Tipo de situação que orienta a interpretação e os campos esperados | O enum atual é uma aproximação ampla; não substitui tópicos ou entidades |
| Relação | Vínculo explícito entre conhecimentos ou entidades, com tipo e suporte quando factual | Estar no mesmo tópico não prova relações como usa, contradiz ou é parte de |
| Candidato | Interpretação proposta que ainda precisa cumprir critérios de aceitação | Não misturar automaticamente com a análise ativa |
| Suplemento | Informação adicional vinculada à análise e às fontes correspondentes | Não apagar a origem nem transformar complemento em substituição silenciosa |

## Exemplo sintético de tecnologia

Este exemplo é fictício; não representa um resultado da amostra.

- Fonte: vídeo fictício de uma demonstração.
- Evidência: um trecho mostra uma ferramenta chamada Google Gemini sendo usada em uma atividade específica.
- Entidade candidata: Google Gemini. A equivalência com Gemini depende do contexto; não vale para qualquer uso desse nome.
- Tópico: a atividade demonstrada, por exemplo, recuperação de informações.
- Categoria de navegação proposta: Tecnologia.
- Contexto atual possível: technology.
- Item de conhecimento futuro: uma afirmação sobre o uso efetivamente demonstrado, com a evidência correspondente.
- Relação futura: usa, somente se a fonte a sustentar. Uma menção isolada à ferramenta não prova seu uso.

Uma entidade, um tópico e uma categoria podem aparecer na mesma análise sem serem termos intercambiáveis.

## Exemplo sintético de receita

Também fictício: um campo ingredient com valor batata, sustentado por uma legenda, registra um ingrediente. Um procedimento com quantidade e tempo pode apoiar um item de conhecimento mais completo.

Não deduzir quantidades, rendimento, substituições ou benefícios sem suporte. O contexto recipe orienta a extração; a categoria Receitas facilita a navegação. Uma variação culinária pode ser um tópico. Esses papéis são diferentes.

## Regras de preservação

1. Conservar fontes, análises originais e evidências.
2. Distinguir valor extraído, informação normalizada e decisão editorial.
3. Registrar a justificativa de um alias e seu escopo.
4. Não tratar categorias próximas como sinônimos: um tema amplo e um subtópico podem ter relação hierárquica.
5. Não confundir similaridade com equivalência ou ausência de contradição.
6. Uma afirmação sem suporte deve permanecer ausente, limitada ou candidata; não completar lacunas por plausibilidade.
7. Integração entre vídeos deve preservar contribuições de cada fonte e registrar divergências.

## Evolução proposta

| Fase | Entrega delimitada |
|---|---|
| 0 | Inventário privado do estado atual e de suas limitações |
| 1 | Revisão deste vocabulário e dos critérios do piloto |
| 2 | Proposta de identidade e ciclo de vida de itens de conhecimento |
| 3–4 | Entidades, aliases e relações, com critérios próprios |
| 5–9 | Similaridade, integração, tópicos, síntese e recuperação após estabelecer unidades e avaliação |
| 10–12 | Interface, necessidade real de grafo e escala autorizada |

Não criar embeddings, índice vetorial ou graph database para corrigir apenas cobertura de uma tabela de navegação.

Próximo passo: [piloto de categorização](knowledge-categorization-pilot.md).
