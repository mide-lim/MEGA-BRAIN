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
