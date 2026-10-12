# Piloto de diagnóstico da categorização

Este piloto cobre as fases 0 e 1 do [vocabulário conceitual](knowledge-concepts.md). Não implementa recategorização, entidades ou itens independentes.

## Pergunta do piloto

A dificuldade de navegação vem de rótulos sem cobertura na taxonomia, de mistura de níveis conceituais, de extração inadequada ou de uma combinação desses fatores?

Responder por observação e critérios verificáveis antes de mudar o banco ou reanalisar vídeos.

## Observações no código

| Estrutura | Responsabilidade atual | O que não comprova |
|---|---|---|
| analysis.categories | Rótulos da análise por vídeo | Existência de uma categoria canônica compartilhada |
| categoryName | Apresentação e um conjunto explícito de aliases | Resolução geral de entidades ou equivalência semântica |
| categoryPaths | Mapeamento de termos conhecidos para navegação | Cobertura completa dos rótulos futuros |
| categoryTree | Contagem de vídeos em grupos e filhos | Partição exclusiva; um vídeo pode pertencer a mais de um grupo |
| analysis.knowledge.context | Contexto amplo da análise | Identidade de um tópico |
| knowledge.fields e keywords | Extração estruturada vinculada a evidências | Itens independentes integrados entre vídeos |
| combinedKnowledge | Composição prevista de análise e suplemento | Aceitação de qualquer candidato ou suplemento sem revisão |

Quando um rótulo não corresponde aos termos conhecidos, categoryPaths acrescenta Outros temas / A organizar. Isso é um comportamento de navegação; não significa que o vídeo esteja sem conhecimento.

## Fotografar a amostra de forma privada

O operador registra o conjunto fixado e a data, mantendo conteúdo e identificadores fora da publicação pública. O inventário deve incluir:

- Quantidade de vídeos esperados, encontrados e com análise ativa.
- Categorias brutas, variantes de apresentação e cobertura na árvore atual.
- Contextos, tipos de campo e palavras-chave.
- Presença e tipo das evidências; rejeições pela validação técnica existente.
- Análises candidatas, suplementos e sinalizações de qualidade, separados da análise ativa.
- Limitações: presença de evidência e aprovação estrutural não substituem revisão semântica.

O levantamento é de leitura. Não habilitar filas, novas análises ou importações. Não apresentar aqui resultados numéricos da amostra privada nem estimativas de qualidade não medidas.

## Hipóteses a distinguir

1. **Cobertura de navegação:** rótulos válidos não aparecem entre os termos conhecidos.
2. **Granularidade:** rótulos amplos, assuntos específicos e nomes de entidades são usados como se tivessem o mesmo papel.
3. **Extração:** a informação produzida não é sustentada pela fonte ou não descreve bem o assunto.
4. **Integração:** informações existentes em vídeos diferentes ainda não compartilham identidade ou relações explícitas.

Uma correção da primeira hipótese não resolve automaticamente as demais.

## Próximo experimento mínimo proposto

Somente após revisar o inventário e este documento:

1. Escolher até dois rótulos sem cobertura e justificar seu destino.
2. Preparar fixtures sintéticas com o mesmo formato do schema, sem copiar conteúdo privado.
3. Distinguir alias de mapeamento hierárquico: assuntos próximos não precisam ter o mesmo nome canônico.
4. Testar a cobertura proposta de maneira convencional.
5. Demonstrar que categorias brutas, conhecimento, evidências e análises candidatas permanecem intactos.
6. Comparar com o baseline privado, sem novas inferências.
7. Submeter um PR específico para a mudança de comportamento; ele tem revisão de risco própria.

Exemplos de fixtures devem ser identificados como fictícios. Não transformar os exemplos em evidência de cobertura da amostra real.

Os [critérios de aceite e casos sintéticos](category-mapping-acceptance.md) detalham o baseline e as expectativas propostas para revisão antes do PR de comportamento.

## Critérios de aceite desta etapa documental

- Conceitos distintos e vinculados ao schema observado.
- Separação explícita entre implementação existente e proposta futura.
- Diagnóstico privado reproduzível sobre o conjunto fixado.
- Nenhum dado individual, transcrição, URL de origem ou credencial publicado.
- Nenhuma alteração de código, dados, aliases, infraestrutura ou processamento.
- Documentos passam pela verificação de links.
- O registro operacional distingue entrega do operador de uma execução real de agente.

A etapa fica pronta para revisão documental. Não declarar conhecimento atômico, canonicalização ou orquestração independente implementados por consequência deste piloto.

## Orquestração e autoria

O agente, quando liberado por um Task Packet válido, deve produzir apenas a entrega delimitada. O operador verifica o diff, publica o PR com a identidade autorizada e acompanha CI por ferramentas convencionais.

Uma falha antes do modelo é uma falha do fluxo e deve ser registrada. Não atribuir ao Worker documentos preparados pelo operador, não reativar automaticamente o modelo e não declarar piloto ponta a ponta bem-sucedido apenas porque a CI dos documentos passou.
