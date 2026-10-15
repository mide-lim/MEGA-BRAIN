# Aquisição assistida de uma etapa — MEG-106

O módulo interno `runAssistedUpload` compõe o `WorkerFlow.run` retornado por `workerRuntime(config, preset)` sem `withHandler`. Executa somente aquisição (`upload`, `poll:0`) da tarefa previamente aprovada no servidor. Não cria handler/rota, fila, worker, scheduler ou botão; não instancia a fila, não chama admissão/poll e não enfileira sucessores. A rota normal mantém seu encadeamento.

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

O `outcome` é uma observação da solicitação, **não** comprovante de encerramento de processo/provedor. O helper não grava `execution_stops`, não libera ocupações ou reservas e não transforma timeout/tempo decorrido em prova. WorkerFlow continua responsável por CAS, elegibilidade, livro financeiro, aquisição e comprovante interno após trabalho/limpeza aguardados.

## Limites operacionais

Não há entrada pública ou payload de fila para este helper. Não passar o handler normal ou tarefas provenientes do cliente como dependência. O runtime sem handler deve ser composto apenas pelo executor interno confiável; controles e credencial Google existentes permanecem obrigatórios. Uma allowlist ou um registro financeiro não substituem autorização do proprietário.

Para a MEG-104, os seis IDs permanecem definidos na MEG-105; os legados sem prova e os marcadores não elegíveis continuam retidos. O módulo não os torna recuperáveis. Não inclui análise/transcrição nem reconciliação de candidato.

A ativação exige separadamente código revisado/CI, imagem/configuração confirmadas, autorização, isolamento/concorrência1 e orçamento fresco da MEG-108/109. O helper não modifica concorrência ou impede sozinho outras entradas no serviço. A prova de uma tentativa nova não atesta retroativamente a anterior. Os prazos efetivos do adapter/serviço continuam valendo; não usar corrida de timeout como prova de término. Publicação e execução são liberações diferentes.

## Validação

Testes offline cobrem autorização inválida/expirada, escopo/quote, aquisição CAS e recibos perdidos, uso duplicado/concorrente, waiting/erro/timeout e ausência de sucessores. Integração sintética usa runtime, ledger, controle de aquisição e prova reais, com store e adapters locais: zero STT/Gemini, preservação do publicado/candidato, orçamento legado bloqueado e capacidade retida sem prova quando a extração não confirma encerramento. Nenhum teste processa Reels ou acessa Google.

[Retomada e comprovantes](smart-retry.md) · [Revisão por risco](REVIEW_POLICY.md)
