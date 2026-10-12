# Matriz documental de decisão conceitual

Esta matriz aplica o [vocabulário e as regras de preservação](knowledge-concepts.md) aos seis exemplos sintéticos abaixo. As [propostas de mapeamento e seus limites](category-mapping-acceptance.md) orientam decisões futuras, sem aprovar destinos. Uma palavra isolada não tem classificação universal: seu papel depende da fonte, do contexto e do uso editorial.

## Baseline observado

No [código de apresentação e navegação](../google-v0/lib/category-display.mjs), `categoryName` contém o alias explícito `productivity` → `Produtividade`. A normalização de acentos, caixa e espaços serve à comparação de rótulos; não comprova identidade de entidades nem equivalência semântica geral. `categoryPaths` reconhece termos enumerados e encaminha termos não cobertos para **Outros temas / A organizar**, preservando as categorias originais. Esse comportamento existente é separado das hipóteses editoriais da matriz.

## Seis exemplos sintéticos

| Exemplo | Papéis possíveis | Evidência/contexto necessário | Decisão admissível | Estado/limite |
| --- | --- | --- | --- | --- |
| 1. `productivity` / `Produtividade` | Rótulo bruto de categoria e alias de apresentação. | Entrada explícita no mapa de aliases de `categoryName`; registrar o escopo de apresentação. | Reconhecer o alias já existente para apresentar o rótulo, conservando o valor bruto. | **Baseline confirmado no código**; não é resolução de entidade nem autorização para ampliar equivalências. |
| 2. Gemini / Google Gemini | Nome de entidade e alias candidatos; “Gemini” pode ter outros referentes. | Trecho da fonte que identifique o produto, fornecedor e contexto de uso; referência e localização que sustentem que os dois nomes apontam para a mesma entidade. | Propor entidade e alias apenas quando houver suporte de identidade no contexto; sem esse suporte, manter candidatos separados e pedir contexto. | **Pendente de contexto**; o revisor verifica o suporte, sem inferir equivalência pela semelhança dos nomes. |
| 3. Tecnologia / Inteligência artificial generativa | Categoria ampla e assunto específico; possível relação hierárquica. | Definição do recorte e evidência do assunto na fonte; critérios editoriais e aprovação do proprietário para inclusão na navegação. | Propor hierarquia, distinguindo tema amplo de assunto específico. O destino fictício Tecnologia / Inteligência artificial depende de aprovação. | **Hipótese editorial**; não renomear categorias brutas, criar alias entre esses termos ou considerar destino aprovado. |
| 4. Recuperação de informações | Tópico candidato que pode atravessar categorias. | Trechos que delimitem o assunto, referências às fontes e critérios de inclusão/exclusão; preservar contribuições e divergências entre fontes. | Propor tópico transversal, sujeito à revisão de seu recorte, sem tornar categorias próximas sinônimas. | **Candidato conceitual**; clustering não está implementado por esta entrega nem comprovado pelo exemplo. |
| 5. Turismo | Rótulo ambíguo: viagem/experiência ou atividade econômica; categoria ou tópico candidatos conforme o recorte. | Trechos e objetivo da fonte: destinos, itinerários e experiências, ou setor, emprego e impacto econômico; escopo editorial e justificativa do proprietário. | Manter a ambiguidade registrada e solicitar decisão do proprietário. Viagens e lugares / Destinos e experiências é apenas possibilidade fictícia do documento de origem. | **EM DISCUSSÃO**, sem destino aprovado; não presumir equivalência com dicas de viagem nem escolher destino pela palavra isolada. |
| 6. Batata em uma receita fictícia | Ingrediente, valor de campo extraído e entidade candidata no domínio da receita. | Trecho da receita que identifique ingrediente, papel e eventual quantidade; fonte/localização e contexto para uma identificação mais específica. | Registrar como ingrediente/campo com suporte; propor entidade se identificável no contexto. Uma afirmação completa exige conteúdo e evidência adicionais. | **Exemplo sintético limitado**; o nome sozinho não constitui item de conhecimento nem categoria automática. |

## Perguntas para decidir

1. Qual é a fonte, o trecho e o contexto de uso? Se faltarem dados essenciais ou houver mais de um referente possível, registrar a ambiguidade e deixar a decisão pendente.
2. Há suporte explícito de que dois nomes designam a mesma entidade ou o mesmo rótulo, dentro de um escopo definido? Se sim, registrar a justificativa do alias; similaridade de escrita ou assunto não basta para equivalência.
3. Um termo é uma classe ampla e o outro um assunto específico? Se houver suporte para essa relação, propor hierarquia com justificativa; o proprietário precisa aprovar seu uso na navegação, sem renomear o rótulo bruto.
4. O termo delimita um assunto que pode reunir informações de diferentes categorias? Propor tópico e critérios de recorte. Se identifica algo no domínio, propor entidade com evidência de identidade. Esses papéis podem coexistir conforme o contexto.
5. O que ainda falta e quem decide? O revisor verifica fonte, identidade e suporte; o proprietário decide recortes e destinos editoriais. Manter candidatos e pendências explícitos até essa avaliação.

## Preservação e limites da entrega

Conservar categorias brutas, fontes, análises originais e evidências, incluindo identidade, versão e localização quando aplicável. Registrar separadamente o valor extraído, a interpretação normalizada e a decisão editorial, com justificativa e escopo. Uma nova interpretação não substitui silenciosamente a origem; ausência de suporte não deve ser preenchida por plausibilidade.

Os seis exemplos são sintéticos e não representam resultados de amostra privada. A única confirmação operacional aqui é o baseline observado no código. Esta entrega documental não altera comportamento, dados ou categorias e não implementa conhecimento atômico, coleção de itens de conhecimento, resolução de entidades ou clustering. Validação de links e whitespace não prova qualidade semântica real nem economia de cota medida.

A revisão humana dos critérios permanece pendente. O operador audita escopo e fontes, publica o PR, acompanha o CI e cuida da disposição final; o proprietário revisa os critérios antes de merge.
