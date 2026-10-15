# Limite independente de aquisição — MEG-102

Esta mudança é código para revisão. Não cria filas, workers, rotas, infraestrutura nem altera controles em produção. A ativação futura exige autorização própria; não há reprocessamento ou inferência nesta entrega.

## Fluxo preservado

O coordenador atual continua admitindo vídeos dentro de `settings/automation.parallelism`, do lote e do livro financeiro. Cada upload acrescenta uma vaga agregada em `settings/acquisition`, compartilhada entre instâncias via CAS do Firestore. Transcrição, polling STT e análise não adquirem essa vaga. Depois do download, a vaga pode passar ao próximo vídeo enquanto o anterior transcreve/analisa, desde que os tetos globais e financeiros também permitam.

Controle planejado para a futura ativação, inicialmente uma aquisição por vez:

```json
{"schema_version":1,"enabled":true,"parallelism":1,"active":{}}
```

`parallelism` aceita 1–4, independentemente do teto global vigente. O teto efetivo sempre é a interseção dos controles. Documento ausente, inválido ou desligado bloqueia novos uploads. O runtime não cria nem habilita o documento automaticamente. Reduzir o limite não remove ocupações existentes. Desligar aquisição não bloqueia o encerramento comprovado de uma ocupação.

## Encerramento e incerteza

A identidade UUID de cada tentativa é gerada no servidor, após obter a vaga e antes de qualquer extração. Cada vaga registra execução, tentativa, vídeo e horário. Não há prazo de expiração. Horário, pausa, desconexão HTTP, reserva financeira liquidada ou presença de um arquivo não provam que o trabalhador terminou.

A liberação consulta o comprovante imutável `execution_stops/<execução>_<tentativa>`, reutilizando o verificador da MEG-100. O produtor só é chamado no `finally`, depois de resolverem todas as promessas aguardadas de operação, persistência e limpeza. A prova precisa coincidir com execução, tentativa, vídeo, etapa upload, revisão nula e versão do claim. Comprovantes de análise preservam as regras anteriores de revisão e retomada. Os adaptadores devem aguardar seus processos e limpeza; não podem iniciar trabalho destacado e retornar antes dele.

Ausência de prova, mudança de identidade/versão, encerramento abrupto ou confirmação desconhecida deixam a vaga retida. Se a escrita da prova ocorreu mas a resposta se perdeu, a verificação da prova persistida pode confirmar o encerramento. Se a liberação falha, a operação interna `release` permite conferir novamente a mesma prova e remover apenas a própria entrada, sem executar um download. Não há rota pública ou retry automático novo. Uma aquisição com confirmação perdida antes da identidade do claim exige conferência explícita; não é liberada por dedução.

O coordenador conta vagas ativas e intenções de upload pendentes/enfileiradas. Só deixa de contar uma intenção com prova de encerramento válida, ou bloqueio definitivo anterior à reserva e sem identidade de tentativa. Intenções legadas sem prova ficam retidas para conferência. O CAS da vaga é a barreira final mesmo com corridas entre seleção, configuração e entrega. Uma tarefa sem vaga fica `blocked/acquisition_capacity`, sem extração nem reserva; sua recuperação permanece explícita pelo mecanismo já existente de bloqueio anterior ao pagamento, após conferir que nenhuma reserva/tentativa está em aberto. Não introduzimos um scheduler ou redisparo automático.

## Reaproveitamento e diagnóstico

O download existente continua trazendo mídia, metadados e legenda juntos. O vídeo preserva geração, duração e legenda; STT lê a geração já persistida e análise usa mídia/transcrição/legenda existentes. Entregas duplicadas de claims concluídos não repetem extração ou inferência. Mídia já verificada com claim inconsistente exige reconciliação; não é baixada outra vez. A verificação de ausência já usada nos retries também protege o upload normal antes da reserva: um objeto original existente sem metadados consistentes fica retido para reconciliação, sem novo download.

A análise deixa de consultar o Instagram para completar uma legenda ausente, inclusive em registros legados. A ausência fica explícita como `caption_status: unavailable`; uma legenda capturada é preservada. Isso evita um extrator fora do limite de aquisição e não altera modelos, prompts ou categorias. O diagnóstico manual de metadados já existente é separado e não é acionado por esta mudança.

A prova de upload registra `duration_ms` (do início da aquisição até o fim da limpeza), `adapter_calls`, `extractions`, resultado e referência ao diagnóstico seguro do job. O contador de extrações é incrementado na fronteira da chamada real ao downloader, antes da inspeção/persistência; não é inferido de configuração. Nenhuma saída bruta, URL assinada, credencial ou mensagem livre do extrator é adicionada.

## Validação e ativação posterior

1. Validar offline concorrência real dos adaptadores simulados, duplicatas, coexistência com STT/análise, pausa, autorização, orçamento e limite global. Aumentar o limite de aquisição não altera esses controles.
2. Validar falhas, limpeza ainda em andamento, perda de recibos, provas inválidas/estrangeiras, redução de limite e snapshot de perda abrupta. Sem prova, nenhuma liberação ou reextração automática.
3. Validar o fluxo completo reutilizando mídia/legenda/metadados; executar regressões, CI e revisão independente do commit final antes de aceitar o PR.
4. Em tarefa futura autorizada, manter entrada pausada; inventariar e encerrar/reconciliar trabalhadores e intenções antigos com evidência positiva. Somente depois preparar o novo documento com limite 1, publicar e validar uma amostra autorizada. Não inicializar `active: {}` enquanto houver trabalho antigo possivelmente vivo. O código antigo não conhece este controle: sobrepor revisões antigas e novas invalidaria o limite agregado.
5. Estabilidade em ambiente real pertence à MEG-104. Painel, filas independentes, workers por etapa e migração continuam no planejamento próprio. Esta entrega não declara encerrada a MEG-92 nem autoriza deploy ou retomada do acervo.
