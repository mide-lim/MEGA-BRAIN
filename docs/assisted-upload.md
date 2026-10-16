# Aquisição assistida de uma etapa — MEG-106

O módulo interno `runAssistedUpload` compõe o `WorkerFlow.run` retornado por `workerRuntime(config, preset)` sem `withHandler`. Executa somente aquisição (`upload`, `poll:0`) da tarefa previamente aprovada no servidor. O helper não cria handler/rota, fila, worker, scheduler ou botão; não instancia a fila, não chama admissão/poll e não enfileira sucessores. A rota normal mantém seu encadeamento.

## Autorização interna

O operador futuro deve usar código confiável no servidor e uma allowlist da sessão, nunca dados do cliente como autorização. O chamador fornece `store`, `flow`, `requestId`, `allowedVideoIds` (até seis IDs distintos). As dependências devem ser do runtime privado já autenticado; esta função não fornece autenticação HTTP.

A autorização já existente, criada por caminho interno autorizado, deve estar em `jobs/assisted_upload_<requestId>`:

```json
{
  "schema_version": 1,
  "kind": "assisted_upload",
  "status": "authorized",
  "request_id": "identificador_unico_da_solicitacao",
  "authorization_ref": "MEG-104:liberacao_especifica",
  "authorized_at": "2026-10-15T12:00:00Z",
  "expires_at": "2026-10-15T13:00:00Z",
  "maximum_cents": 10,
  "task": {"videoId": "Reel_exemplo", "stage": "upload", "poll": 0}
}
```

Exemplo estrutural, não autorização, quote ou registro de produção. A validade máxima é uma hora. A quote deve coincidir com `flow.quotes.upload`. O task vem desse documento, passa pela validação existente e fica limitado ao ID da allowlist/etapa upload. Flags de recuperação existentes só são aceitas em combinação válida e continuam sujeitas à elegibilidade/autorização própria do WorkerFlow; este registro não as substitui. A MEG-106 não emite autorizações, inicializa controles, habilita etapas ou altera o legado.

A autorização é consumida com CAS antes da execução. Só o vencedor com recibo confirmado chama o flow uma vez. Conflito, resposta de escrita desconhecida ou recibo incompleto não chamam o flow nem repetem a escrita automaticamente. Se o resultado da operação ou sua persistência forem incertos, a autorização continua consumida; uma nova chamada não retoma a operação. Conferir as evidências antes de qualquer nova decisão; não resetar o documento ou emitir outra autorização para contornar incerteza.

O retorno da gravação final precisa confirmar uma nova versão não vazia, a autorização ainda consumida, o mesmo `consumed_at`, o `outcome` completo e o `observed_at` esperado. Resposta ausente, incompleta ou divergente retorna `uncertain / assisted_result_unconfirmed`, mesmo se a escrita tiver sido aplicada. Não há releitura, repetição da escrita ou nova chamada do flow para compensar essa incerteza; a autorização continua consumida.

O `outcome` é uma observação da solicitação, **não** comprovante de encerramento de processo/provedor. O helper não grava `execution_stops`, não libera ocupações ou reservas e não transforma timeout/tempo decorrido em prova. WorkerFlow continua responsável por CAS, elegibilidade, livro financeiro, aquisição e comprovante interno após trabalho/limpeza aguardados.

## Limites operacionais

Não há entrada pública nem payload de fila para este helper. A entrada privada da MEG-109 abaixo recebe somente o identificador de uma autorização existente. Não passar o handler normal ou tarefas provenientes do cliente como dependência. O runtime sem handler deve ser composto apenas pelo executor interno confiável; controles e credencial Google existentes permanecem obrigatórios. Uma allowlist ou um registro financeiro não substituem autorização do proprietário.

Para a MEG-104, os seis IDs permanecem definidos na MEG-105; os legados sem prova e os marcadores não elegíveis continuam retidos. O módulo não os torna recuperáveis. Não inclui análise/transcrição nem reconciliação de candidato.

A ativação exige separadamente código revisado/CI, imagem/configuração confirmadas, autorização, isolamento/concorrência1 e orçamento fresco da MEG-108/109. O helper não modifica concorrência ou impede sozinho outras entradas no serviço. A prova de uma tentativa nova não atesta retroativamente a anterior. Os prazos efetivos do adapter/serviço continuam valendo; não usar corrida de timeout como prova de término. Publicação e execução são liberações diferentes.

## Validação

Testes offline cobrem autorização inválida/expirada, escopo/quote, aquisição CAS e recibos perdidos, uso duplicado/concorrente, waiting/erro/timeout e ausência de sucessores. Integração sintética usa runtime, ledger, controle de aquisição e prova reais, com store e adapters locais: zero STT/Gemini, preservação do publicado/candidato, orçamento legado bloqueado e capacidade retida sem prova quando a extração não confirma encerramento. Nenhum teste processa Reels ou acessa Google.

[Retomada e comprovantes](smart-retry.md) · [Revisão por risco](REVIEW_POLICY.md)

## Entrada privada do worker — MEG-109

`POST /tasks/assisted-upload` no serviço worker existente aceita somente
`{"requestId":"identificador_unico_da_solicitacao"}`. A identidade OIDC é a
mesma do worker privado (assinatura, audience exata e conta v0-queue), validada
antes de qualquer acesso ao store. Não aceita tarefa, IDs de vídeos, etapa,
quote, flags de recuperação ou allowlist do cliente. A entrada não emite a
autorização `jobs/assisted_upload_<requestId>`: ela continua administrativa,
explícita, válida por no máximo uma hora e consumida pelo helper existente.

`assisted_upload_enabled` é **false por padrão**. Para compor o modo assistido,
a configuração do servidor deve trazer `dispatch_enabled:false`,
`admission_enabled:false` e `pilot_video_ids` com um a seis IDs distintos.
Com esse modo ativo, as rotas normais run/admit/diagnose ficam bloqueadas após
autenticação; não são compostos queue/admission/probe. Sem o modo assistido,
as rotas normais preservam seu comportamento e a entrada assistida fica fechada.

Antes de consumir a aprovação, a entrada exige automação enabled/parallelism1,
STT/análise desabilitados e aquisição schema1/enabled/parallelism1. O runtime
assistido também fixa o teto CAS de aquisição em1, mesmo se o documento for
alterado para2 entre a conferência e a aquisição. Isso não encerra ocupações
anteriores nem protege contra revisões antigas externas ao controle: isolamento,
conciliação das revisões e fila continuam requisitos da ativação. O lote262 e
seu parallelism4 não são modificados.

A imagem inclui o helper e a entrada real. O contrato do workflow passa a exigir
worker1/web1; o deploy continua alterando somente imagens e rejeita produção
que ainda não tenha os limites revisados e o fingerprint correspondente. Este
PR não configura a nuvem, não publica imagem e não executa a amostra.

A resposta autenticada contém apenas o outcome limitado do helper, com
Cache-Control:no-store. Bloqueio/incerteza não disparam repetição, polling ou
sucessor. Um resultado observado não substitui ExecutionStops. Aprovação
consumida/recibo desconhecido não é resetada; repetir a requisição não repete o flow.

A MEG-108 mantém volume0/R$0 para aquisição, STT e Gemini na amostra atual.
Não habilitar a rota, criar uma aprovação positiva ou fabricar quote0 para
contornar esse escopo. A implantação/configuração e uma eventual operação por
ID exigem suas liberações próprias, preservando o orçamento já autorizado.


## Escopo unitário fora do lote (MEG-109)

A opção de servidor `assisted_single_upload_enabled: true` é desligada por
padrão e exige modo assistido, allowlist de exatamente um ID e quote upload
positiva até100centavos. Ela não é uma flag de task/HTTP. O endpoint continua
recebendo somente requestId e não emite aprovações. Nenhuma configuração
operacional ou aprovação é criada por esta alteração.

Após consumo CAS confirmado, a aprovação privada produz a capacidade opaca e
imutável da invocação. Flow, ledger, gate e admissão de Storage recebem
dependências novas por invocação, sem contexto mutável compartilhado. Somente
um upload novo é permitido; recuperação, histórico prévio, outras etapas e
objetos fora de originals/instagram/<ID>/video.mp4 são recusados.

O lançamento guarda assisted_scope_ref no mesmo livro global, sem batch_id;
conta em spent_cents/reserved_cents e conserva frescor, reserva preventiva,
compromissos persistentes, limite de operações, capacidade e duplicidade.
O lote262/parallelism4 e suas vias não são alterados. Sua validação continua
no caminho normal; não há remoção temporária de batch ou ledger alternativo.
O prazo da aprovação é verificado na admissão; conclusão da tentativa já
admitida pode ultrapassá-lo, sem renovar permissão ou permitir replay.

A trava de aquisição e ExecutionStops permanecem os existentes. Timeout ou
perda de recibo não reiniciam autorização nem liberam vaga por tempo. O novo
escopo não comprova nem encerra executores legados: cobertura operacional
positiva de isolamento/encerramento continua obrigatória antes de ativar,
sem conciliar nem liberar suas reservas. Nenhum Reel foi selecionado aqui.

O orçamento proposto permanece atéR$1 por operação dentro do envelopeR$20,
sujeito à quote/margem reais e autorização futura; STT/Gemini/sucessores0.
Testes são sintéticos/offline; não constituem aquisição real nem aprovação
de merge/deploy ou ativação.


## Executor de download com encerramento comprovado

O downloader usa um supervisor Linux local, empacotado na mesma imagem com o Python já existente. Antes de iniciar o comando, o supervisor verifica e assume a função de subreaper: descendentes órfãos, inclusive após setsid/double-fork, continuam sob sua responsabilidade. Um recibo normal só é produzido depois de aguardar o término da árvore inteira. O retorno numérico do processo principal, o fechamento de streams, um grupo vazio ou o tempo decorrido não substituem essa confirmação. Falta de suporte bloqueia a execução antes do extrator.

O adaptador Node valida o protocolo, o identificador da invocação e os limites do recibo. Apenas resultados/erros reconhecidos em memória pelo executor podem confirmar encerramento; campos JSON de uma tarefa, do stderr ou de um erro arbitrário não servem como prova. O media-tools aguarda também os comandos de diagnóstico de versão e a limpeza temporária antes de comunicar o encerramento ao adaptador de upload.

Um erro normal com árvore encerrada mantém o resultado e a reserva financeira como uncertain; o WorkerFlow existente pode registrar ExecutionStops e encerrar somente a ocupação de aquisição daquela nova tentativa. Timeout, abort, saída excedida, supervisor interrompido ou recibo inválido/perdido mantêm a ocupação retida. Não há retry, nova extração, STT/Gemini ou sucessor por causa desse recibo.

A imagem e seu smoke usam processos e mídia sintéticos sem rede para conferir a supervisão. A validação local não comprova suporte no sandbox Cloud Run: uma futura publicação autorizada deve executar smoke sintético com as entradas fechadas antes de uma aquisição real.

Esta implementação não reconcilia a tentativa anterior da MEG-109, não interpreta RETIRED como prova interna retroativa, não altera claims existentes e não libera reservas antigas ou o R$1 já retido. A ponte administrativa para evidência externa da revisão antiga fica fora deste PR do executor. Publicação, conciliação operacional e nova aquisição continuam dependendo de autorizações próprias.


## Conciliação administrativa unitária da revisão aposentada (MEG-109)

`ops/reconcile-retired-acquisition.py` é uma ferramenta de operador restrita ao
job/tentativa de C02Z8eipgu2 e à revisão 00047-dpj/UID já registrados. Seu padrão
é um plano somente de leitura. Ela consulta a revisão pelo Google, exige
RETIRED/Active negativo, revisão atual 00048-wnv e tráfego sem rota antiga,
fila/scheduler pausados, entradas fechadas e concorrência 1. Correlaciona a
requisição original única com a aprovação consumida e o ciclo do claim; não
interpreta HTTP200, tempo ou ausência de mídia como prova de encerramento.

A decisão administrativa usa a infraestrutura aposentada como evidência externa
de capacidade; não cria ExecutionStops, não marca o extrator como encerrado nem
converte resultado incerto em sucesso. O claim segue uncertain/unconfirmed e
os R$19,50 continuam retidos. Não altera worker, identidade/IAM, retry, política
financeira, allowlist, armazenamento, análises ou os seis legados anteriores.

Para preparar o plano, forneça um token temporário pela entrada padrão, através
de pipe (nunca em argumentos, arquivo ou terminal interativo), por exemplo:

```sh
gcloud auth print-access-token | python3 ops/reconcile-retired-acquisition.py --token-stdin --plan /caminho-protegido/unit-plan.json
```

O plano novo contém versões/hashes e exatamente dois alvos propostos. Nada é
gravado no Google. Aplicação futura requer revisão, autorização explícita
`MEG-109:...`, o mesmo plano/fingerprint (`--plan-sha256`), `--apply` e um
caminho exclusivo `--receipt`. Esta implementação/PR não autoriza sua aplicação.

Uma transação lê os documentos protegidos, exige as mesmas versões e confirma
novamente a referência externa antes do commit. Cria a auditoria em jobs com
precondição de inexistência e remove apenas a ocupação fixa de acquisition.active.
Não altera financeiro, claim, vídeo, aprovação ou ExecutionStops. A auditoria
guarda reconciled_at, sem inventar ended_at/ended:true. Concorrência externa de
deploy/reativação é proibida nessa janela; drift de etag/prova bloqueia avanço,
inclusive na conferência posterior. As APIs Cloud Run e Firestore não participam
da mesma transação.

Recibo perdido/incompleto não dispara replay ou restauração de snapshots. Ao
reinvocar com o mesmo plano, autorização e caminho de recibo, o utilitário apenas
confirma um resultado já auditado e idêntico; intenção existente sem resultado
confirmado bloqueia nova transação. Auditoria divergente, slot ausente sem
auditoria ou qualquer documento protegido alterado exigem conferência manual.
A verificação posterior mantém gates fechados; nunca recria automaticamente a
ocupação antiga nem devolve dinheiro.

Após conciliação autorizada, o modo assistido atual poderá testar outro ID limpo,
com aprovação nova e orçamento validado. Repetir o mesmo Reel continua bloqueado
pelo claim/histórico existentes. Cadastro, configuração, orçamento, aquisição
real e eventual liberação financeira permanecem fora deste utilitário.

Os testes de ops são offline: fake da API/transação para dry-run, conflitos,
identidades/provas inválidas, commit atômico, perda de recibo, idempotência e
preservação dos registros. Não chamam Google ou provedores.
