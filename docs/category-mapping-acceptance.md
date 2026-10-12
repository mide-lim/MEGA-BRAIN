# Critérios para o experimento mínimo de navegação

Este documento complementa o [piloto de categorização](knowledge-categorization-pilot.md). É uma entrega documental: descreve o baseline observado por leitura de [category-display.mjs](../google-v0/lib/category-display.mjs) e expectativas para um futuro PR de comportamento. Não implementa mapeamentos nem comprova cobertura ou qualidade da amostra privada.

## Baseline e propostas fictícias

Hoje, `categoryName` aplica aliases explícitos e ajusta a apresentação. A chave de comparação remove acentos, normaliza caixa e espaços; isso não torna quaisquer assuntos semanticamente equivalentes. `categoryPaths` reconhece apenas os termos enumerados na taxonomia de navegação e acrescenta **Outros temas / A organizar** quando resta um termo não coberto. `categoryTree` conta vídeos por grupo e filho, sem exigir uma partição exclusiva.

Um alias apresenta o mesmo rótulo, como `productivity` → `Produtividade`. Um mapeamento hierárquico coloca um assunto em um grupo mais amplo sem renomear a categoria bruta. As duas propostas abaixo são **fictícias**, escolhidas para este exercício; não são resultados nem rótulos comprovados da amostra privada.

| Candidato fictício | Destino possível na taxonomia pública do código | Justificativa e decisão pendente |
| --- | --- | --- |
| Turismo | Viagens e lugares / Destinos e experiências | O grupo comporta viagens, mas turismo também pode tratar de atividade econômica. O proprietário deve decidir se esse filho é adequado ao recorte; não presumir equivalência com dicas de viagem. |
| Inteligência artificial generativa | Tecnologia / Inteligência artificial | É um assunto específico sob o tema mais amplo já presente. Confirmar com o proprietário a inclusão como termo de navegação; não criar alias para renomeá-lo como Inteligência artificial. |

As expectativas abaixo são condicionais à aprovação desses destinos. Uma decisão diferente exige atualizar os critérios antes do PR de comportamento.

## Casos sintéticos para testes futuros

Cada entrada representa um único vídeo fictício no formato mínimo `video.analysis.categories`. As contagens mencionadas valem para esse vídeo isolado. Nenhuma fixture executável ou teste de aplicação é criado nesta etapa.

| Caso | Entrada mínima | Baseline observado no código | Expectativa futura proposta |
| --- | --- | --- | --- |
| Candidato Turismo | `{"analysis":{"categories":["Turismo"]}}` | Somente Outros temas / A organizar. | Se aprovado, Viagens e lugares / Destinos e experiências; sem fallback quando todos os termos estiverem cobertos. |
| Candidato IA generativa | `{"analysis":{"categories":["Inteligência artificial generativa"]}}` | Somente Outros temas / A organizar. | Se aprovado, Tecnologia / Inteligência artificial; preservar o rótulo específico. |
| Rótulo conhecido | `{"analysis":{"categories":["Programação"]}}` | Tecnologia / Programação. | Mesmo caminho e contagem 1 no grupo e no filho. |
| Caixa, acentos e espaços | `{"analysis":{"categories":["  PROGRAMAÇÃO  ","programacao","  Inteligência   ARTIFICIAL generativa  "]}}` | Tecnologia / Programação e Outros temas / A organizar; as variantes de Programação não duplicam o caminho nem a contagem. | Após aprovação da proposta de IA generativa, Tecnologia / Programação e Tecnologia / Inteligência artificial; grupo Tecnologia conta 1, cada filho conta 1. Comparação normalizada, sem reescrever os textos brutos. |
| Alias existente | `{"analysis":{"categories":["productivity"]}}` | Apresentação Produtividade; Tecnologia / Ferramentas e produtividade. | Preservar alias, caminho e contagem; não confundir alias com os novos mapeamentos. |
| Desconhecido | `{"analysis":{"categories":["Tema fictício não coberto"]}}` | Outros temas / A organizar. | Mesmo fallback, com contagem 1 no grupo e no filho. |
| Categorias vazias | `{"analysis":{"categories":[]}}` | Nenhum caminho; nenhum grupo contado para esse vídeo. | Mesmo resultado; não inventar categoria nem fallback. |
| Misto: conhecido, candidato e desconhecido | `{"analysis":{"categories":["Programação","Inteligência artificial generativa","Tema fictício não coberto"]}}` | Tecnologia / Programação e Outros temas / A organizar. | Se aprovado, adicionar Tecnologia / Inteligência artificial e manter Outros temas / A organizar. Tecnologia conta 1, cada filho conta 1; Outros temas e seu filho contam 1. |
| Dois rótulos no mesmo filho | `{"analysis":{"categories":["Programação","Algoritmos","Programação"]}}` | Tecnologia / Programação, com contagem 1 no grupo e no filho. | Mesmo resultado, sem somar rótulos ou repetições como vídeos adicionais. |

Um vídeo pode contar em vários grupos ou filhos. A soma dessas contagens não é necessariamente o total de vídeos. O fallback deve coexistir com caminhos conhecidos enquanto houver qualquer termo não coberto.

## Critérios de aceite e invariantes do futuro PR

- Limitar a mudança de navegação aos destinos aprovados para, no máximo, estes dois candidatos. Manter explícita a distinção entre alias e inclusão hierárquica.
- Verificar os casos sintéticos com testes convencionais no futuro PR, incluindo normalização, regressão dos termos conhecidos, fallback coexistente e contagem por vídeo por grupo/filho.
- Preservar integralmente `analysis.categories`: nenhum texto bruto pode ser renomeado, removido ou persistido como categoria canônica por consequência da navegação.
- Preservar conhecimento, contextos, campos, palavras-chave, evidências, fontes, análises candidatas e suplementos. Uma cobertura visual nova não aprova candidatos nem modifica a composição do conhecimento.
- Não alterar banco, reanalisar vídeos, executar inferência, criar embeddings ou entidades. Esta entrega não cria código, scripts ou fixtures executáveis.
- Manter resultados privados fora da publicação. Comparações futuras com o baseline privado dependem do inventário fixado pelo operador; não atribuir aos exemplos números, qualidade medida ou representatividade da amostra.

## Limitações e revisão pendente

O baseline foi observado por leitura do código, sem execução dos casos nem acesso a análises privadas, vídeos ou banco. Os exemplos só especificam comportamento esperado de navegação; não validam a extração ou a sustentação semântica pelas fontes.

A revisão humana dos critérios e dos dois destinos está pendente. O operador audita o diff documental, publica o PR e acompanha CI no commit final; o proprietário decide os destinos antes de implementação. O futuro PR de comportamento requer a [revisão por risco](REVIEW_POLICY.md) própria. Esta entrega não autoriza merge, deploy ou implementação.
