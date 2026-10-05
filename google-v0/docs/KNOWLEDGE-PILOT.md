# Livro de conhecimento — piloto v3

Escopo preparado: reanalisar somente os 19 vídeos verificados do piloto existente, um por vez. Reutilizar vídeos e transcrições no projeto Google próprio; não baixar novamente nem chamar STT. A entrada sem áudio continua em diagnóstico.

## Resultado

Gemini recebe vídeo e transcrição juntos. O preset v3 devolve palavras-chave com evidências, contexto predominante e campos específicos: receita, ingredientes, quantidades explícitas, preparo, tempo, rendimento; ferramentas, conceitos e requisitos; lugares e atividades; práticas, alegações e cuidados; produtos e materiais. Ausências ficam explícitas. Alegações científicas não são fatos verificados.

Livro de conhecimento: navegação por contexto, busca pelos títulos, palavras-chave, nomes e valores dos campos. Cada entrada abre o vídeo, relatório e evidências; mantém link para Instagram. Categorias e relatórios originais não são apagados.

## Evidências e limites

Citações da transcrição devem ser literais; timestamps devem caber na duração. Evidência visual/áudio é descrição do modelo, ainda sujeita a revisão humana. Campos ou palavras-chave sem evidência válida são omitidos; resposta bruta permanece imutável no Storage. Transcrição vazia nunca pode ser apresentada como clara. Até 20 palavras-chave e 40 campos aceitos; preset solicita até 12 e 24 respectivamente.

## Execução

Revisão fixa `megabrain-video-text-v3`, execução própria por vídeo. Histórico anterior preservado em Firestore antes da chamada; respostas brutas usam novo caminho imutável no Storage. Entregas duplicadas convergem na mesma execução. Sem repetição automática após timeout ou resultado incerto. Concorrência 1; fila encerrada ao concluir a amostra. Publicação web e worker privados mantêm identidades e login próprios.

## Financeiro — ativação pendente

O envelope anterior de R$150 já está comprometido pelas estimativas conservadoras de etapas, reprodução e manutenção. Preparar a nova análise não libera novas chamadas.

Proposta: até R$50 adicionais exclusivamente dos créditos Google, total preventivo do piloto R$200. Reserva por análise R$2,50 × 19 = R$47,50, com R$2,50 de margem. Não autoriza 100 vídeos, acervo completo, novo STT ou despesa fora dos créditos. Consultar saldo e vencimento atualizados antes de ativar. Custos persistentes mantêm o prazo original de encerramento. Controle local não é teto imposto pelo Google.

## Validação

91 testes offline passaram, incluindo omissão de citações inventadas, transcrição vazia, reserva por revisão, histórico preservado e duplicação bloqueada. Build e revisão do pacote integrado antecedem ativação financeira. Não foram feitas novas inferências nesta preparação.

## Autorização recebida

O proprietário autorizou as análises após a proposta de R$50 adicionais em créditos. Total preventivo R$200, restrito à revisão v3 dos 19 vídeos, concorrência 1. A ativação deve respeitar saldo recente e vencimento, parar em resultado incerto e preservar o prazo original de manutenção.

## Resultado executado

A amostra concluiu 19 revisões v3, com 110 campos e 81 palavras-chave extraídos. Contagens representam ocorrências por fonte. Uma extração permanece sinalizada para revisão por evidência textual incompatível com STT vazio. A busca por ingrediente e a abertura de detalhes/fonte foram conferidas no site autenticado.

Fila e novos trabalhos pagos voltaram a ficar pausados, sem reserva de análise aberta. Mídias, STT e versões anteriores preservados. Backup incremental de resultados e documentos teve cópia de restauração conferida por hashes fora do Google. A nova análise é separada da expansão para 100 vídeos, que continua sem autorização.
