# Resolução das falhas atuais — complemento do PR32

## Combinação de categorias

O schema anterior restringia IDs e quantidade, mas não codificava a regra já existente de categoria geral usada sozinha. O prompt descrevia a regra; ainda assim duas respostas combinaram uma específica com tecnologia-geral. O schema agora usa anyOf para escolher entre uma categoria geral única ou uma/duas específicas. O validador local permanece obrigatório, inclusive para duplicatas. Não muda destinos, escopos nem a normalização entre grupos.

Campos suportados pelo Google: [structured output](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/capabilities/control-generated-output): anyOf, minItems, maxItems e enum de strings. Verificação local do contrato não substitui observação da próxima chamada real após publicação. Não chamar modelo só para testar o schema.

## Respostas já recebidas

reviewSavedCategorySelection retorna apenas uma proposta, com justificativa e categorias antes/depois. Exige resposta STOP, conflito geral/específica conhecido e seleção explícita de IDs já propostos. Executa toda a validação existente de relatório/evidências. Preserva o original, não chama Google, não escreve dados nem retoma a fila. Não é correção automática por fallback.

Propostas após leitura dos originais, ainda não aplicadas:

- DbR4syfRHbs: bem-estar. A finalidade é um exercício de autoconhecimento; Instagram é o instrumento. Manter Instagram e algoritmo nas palavras-chave sustentadas.
- DbM3NNGsbhv: tecnologia-geral. O vídeo apresenta comunidade, hackathons e iniciativas para2036. Green Gardens é um exemplo vencedor, não uma aula de sustentabilidade alimentar. Preservar nomes e alegações sustentadas.

Após revisão/publicação do PR, preparar a proposta com o artefato original e a transcrição atual; verificar campos/evidências remanescentes. A aplicação requer vínculo à revisão, escrita condicional, artefato derivado imutável e registro da seleção sem alterar tentativas, contadores ou histórico financeiro. Este PR não aplica essas propostas ao banco.

## Timeout Google

PR31 foi mergeado em13/10/2026 e contém diagnóstico detalhado, prazo configurável e isolamento explícito com reserva preservada. Merge não significa publicação/ativação. O caso C4QdRq1ofV3 continua incerto e não deve ser repetido. Após publicação, handoff explícito e conferência do financeiro, usar o isolamento previsto no PR31; não declarar sucesso nem cobrança real. Ajuste de prazo exige telemetria, não remover deadlines.

## Firestore429

A falha capturada é de banda de gravação, não de quota Gemini nem prova de antirrobô. Não introduzir retry genérico em operações pagas ou gravações com resultado desconhecido. Fazer revisão da quantidade de gravações e picos antes de definir backoff/redução; um arquivo isolado não demonstra recorrência atual.

## Instagram e retomada

22 pendências de fonte permanecem para o veredito do usuário; sem classificar automaticamente privado/excluído. O controlador do PR31 já permite liberar vagas de falhas terminais contabilizadas e registradas. Não repetir essas fontes nem o timeout ao retomar os110 candidatos pendentes. Duas rejeições de categoria seguem retidas até aplicação conferida. Acompanhamento Codex continua desativado. OrçamentoR$1200/reservaR$250 e concorrência4 preservados. Conferir validade dos créditos e estado consistente antes do handoff.

## Simulação com os dois artefatos reais

Sem chamada Google nem escrita no banco, as duas propostas passaram na validação existente: DbR4syfRHbs manteve3 campos,4 palavras-chave e2 informações úteis;2 campos/palavras-chave e1 informação foram omitidos pela validação de evidências já existente. DbM3NNGsbhv manteve3 campos,3 palavras-chave e3 informações úteis. Os originais permanecem intactos. Passar na validação é condição técnica, não publicação nem revisão humana do conteúdo.
