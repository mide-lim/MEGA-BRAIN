# Entrega de 200 videos adicionais em quatro vias

O lote atual concluiu 50 adicionais aceitos. Existem 82 registros, 80 com reproducao permitida e dois casos antigos que continuam pendentes. O novo perfil preserva a identidade e os 62 IDs do lote atual, adiciona exatamente 200 IDs novos e usa teto acumulado de R$1.200 autorizado pelo usuario, mantendo a reserva de R$250. As reservas atuais somam R$840 para 200 videos; sao controle conservador, nao faturamento real.

## Admissao e concorrencia

O perfil262 usa quatro identidades em `active_video_ids`. Uma identidade ocupa uma via desde a primeira reserva ate o encerramento financeiro da analise, inclusive entre etapas e durante STT assincrono. Completar upload ou transcricao nao libera a via. Uma quinta identidade e duas etapas simultaneas do mesmo video sao bloqueadas. Os perfis30/62 continuam sequenciais. Nao existem expiração automatica de via, limpeza de historico ou replay de operacao paga.

Reservas financeiras, encerramentos e capacidade recalculam os saldos depois de rejeicao definitiva por conflito de versao, usando ate oito tentativas de CAS. Timeout,429,503 ou erro ambiguo nao entram nessa repeticao. A operacao de modelo/download/upload fica fora do calculo repetido. Resultado incerto pausa novas chamadas e conserva reserva e via; respostas de operacoes ja em andamento podem ser salvas e encerradas. Resposta da analise que exige revisao tambem pausa o perfil262. Pausar nao cancela chamadas ja enviadas.

Os limites sao 1.200 reservas financeiras e 2.400 objetos; os 281 registros financeiros e 422 claims atuais sao preservados. O limite de 600KB do livro permanece e deve ser verificado com os documentos reais. O teste completa 200 workflows com historico preservado e 881 registros, sem inferencia paga. Esse perfil prepara uma entrega limitada; nao constitui validacao de capacidade para 3.000 videos.

## Publicacao e ativacao

1. Revisao humana independente e CI no commit final antes de merge/publicacao. Manter fila e automacao pausadas. Publicar imagens com baseline recente e verificar configuracao preservada.
2. Conferir manifesto privado de200IDs novos da lista original3005, excluir todos82existentes e conferir ausencia de tentativas pagas. Disponibilidade dos links ainda nao e garantida por selecao de IDs.
3. Ler todas as paginas dos videos/jobs; nao assumir que uma pagina100contem o inventario. Salvar snapshot e preparar extensao com `extendBatch200`. Manter a identidade/historico e estado pausado.
4. Adequar alocacao interna apenas aos creditos registrados, preservar25000centavos e atualizar planejamento de armazenamento/custos persistentes com dados atuais. Nao redefinir saldo observado, apagar reservas ou inventar data de faturamento. Validar os600novosjobs, capacidade de arquivos/objetos e tamanho dos documentos. Guardar autorizacaoR1200 e alteracoes no registroMEG73.
5. Cadastrar os200novos registros e pin de configuracao com262IDs. Definir paralelismo4 na automacao e maxConcurrentDispatches4 na fila. Configurar no maximo4instancias do worker com uma requisicao por instancia, preservando demais recursos e acessos; conferir que nao existe maximo de servico conflitante. A capacidade de modelos deve ser observada, nao presumida.
6. O operador convencional mantem janela de ate4videos: envia inicialmente4 uploads; repoe uma via apenas apos analise publicada e encerrada financeiramente e retirada de active_video_ids. Nao enfileirar200uploads de uma vez. STT e analise seguem o encadeamento deterministico existente; nao criar novos executionIds para contornar resultados incertos.
7. Verificar os primeiros4 resultados completos e o comportamento de recursos/429; se passarem, continuar a janela ate200 ou uma falha real. Em falha, parar reposicao, pausar novas chamadas e drenar/conferir as respostas ja em andamento. Registrar diagnostico e reservas; nao repetir ou substituir videos silenciosamente.
8. Liberar reproducao somente de resultados aceitos/midia verificada. Preservar contadores e franquia; maior quantidade de videos nao aumenta automaticamente bytes/requisicoes autorizados. No final auditar todos os resultados, pendencias, custos conservadores e estado pausado. Revisar campos informativos em portugues com nomes originais/evidencias intactos.

## Evidencias e limites

Os testes de concorrencia usam Firestore simulado com versoes e rejeicoes de CAS, sem credenciais ou processamento pago. Testam quatro vias, lacunas entre etapas, espera STT, quinto video bloqueado, reservas/encerramentos concorrentes, capacidade, resultados incertos, duplicacao e preservacao do historico. Os testes existentes cobrem chamadas dos adapters, autenticacao e encadeamento. Nenhum teste local prova disponibilidade de200links, throughput real do Gemini, faturamento real ou reproducao Google com login. Ativacao real somente apos revisao/publicacao e preflight financeiro/capacidade.
