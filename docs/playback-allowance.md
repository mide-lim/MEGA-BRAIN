# Reprodução do lote atual

O bloqueio observado tinha duas causas independentes: `allowed_ids` ainda continha somente os 20 vídeos iniciais e `requests` chegou a 200. Cada trecho HTTP Range consome uma requisição; esse contador não representa quantidade de vídeos assistidos. O consumo já registrado era 382698648 bytes e deve ser preservado.

## Correção

`maximum_requests` passa a ser configurável até 2000; ausente, mantém o padrão anterior de 200. A transferência pode ser configurada até 1 GiB, com leitura de no máximo 2 MiB por resposta. Ambos são tetos cumulativos, não franquias renovadas automaticamente. IDs continuam explicitamente autorizados e cada mídia precisa estar verificada. Mensagens de metadados distinguem vídeo não liberado, requisições esgotadas e transferência esgotada.

A reserva financeira mínima cresce proporcionalmente ao envelope conservador existente de 420 centavos por 400 MiB, arredondada para cima, com piso de 420 e teto de 1100 centavos. Isso é uma margem interna, não uma tarifa Google ou fatura. Para 1 GiB, são exigidos ao menos 1076 centavos; a operação proposta reserva 1100. Crédito, cobertura, prazo e saldo reservado continuam obrigatórios. Pausar análises não pausa reprodução já financiada.

## Aplicação após revisão e publicação

1. Confirmar a versão publicada, lote e fila pausados, ausência de tarefas; ler com versão os documentos financeiro e de reprodução.
2. Conferir os dez IDs aceitos do lote, mídia verificada, chave/geração próprias. Acrescentá-los aos IDs antigos; não incluir os dois casos pendentes. Não alterar o corpus nem iniciar análise.
3. Em um único commit condicional, ampliar `maximum_bytes` para 1073741824 e `maximum_requests` para 2000; preservar `used_bytes`, `requests`, validade e IDs antigos. Ampliar a reserva `media_pilot_delivery.maximum_cents` de 420 para 1100 e somar somente a diferença de 680 a `reserved_cents`. Preservar seu estado iniciado, custo já contabilizado, demais reservas, crédito observado e pausa. Registrar auditoria com valores anteriores e novos, sem apagar histórico. A margem de reprodução de R$11 integra a margem operacional autorizada; não amplia o teto de R$150.
4. Antes do commit, verificar disponibilidade da conta descontando compromissos e reservas, cobertura, validade e margem operacional. Se estados/custos mudarem, recalcular e parar se insuficientes. Nunca zerar contadores para liberar acesso.
5. Validar no site autenticado um dos novos vídeos: autorização, resposta parcial e reprodução efetiva. Confirmar incremento dos contadores e permanência da pausa de processamento. Atualizar a página limpa a mensagem de erro anterior no componente.

Os testes cobrem compatibilidade com o limite antigo, expansão financiada sem apagar consumo, reserva insuficiente, limites inválidos/esgotados, acesso não autorizado, respostas parciais e concorrência no último trecho permitido. A validação no navegador só pode ocorrer após publicação e aplicação da política; testes locais não comprovam reprodução em produção.
