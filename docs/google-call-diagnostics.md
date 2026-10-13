# Diagnóstico de chamadas Google — MEG-75

`googleOperations` aceita `config.analysis_timeout_ms`, inteiro de 1000 a
840000 ms. O padrão continua 120000 ms. `GoogleREST.generateAnalysis` aceita
`timeoutMs` com os mesmos limites. Configuração inválida é rejeitada antes de
identidade, submissão ou efeitos do adaptador de análise.

A janela informada contém três respostas HTTP 200 e um registro 499, sem
medidas de duração. Ela não permite escolher um percentil nem justificar um
novo padrão. Mantemos 120 s por conservação; o operador pode ajustar o valor
após observar `elapsed_ms`. Não há evidência para atribuir atraso a bloqueio
robótico. Os testes usam atrasos de milissegundos e mocks, não medem produção.

O máximo de 840 s deixa 50 s até o limite informado de Cloud Run (890 s) e
60 s até Cloud Tasks (900 s). No adaptador, um único prazo cobre preparação,
submissões e espera entre os retries HTTP 429 já autorizados. Cada submissão
recebe o tempo restante. O prazo não cancela preparação nem persistência;
essas etapas também consomem o orçamento do worker. Não é garantia de que o
fluxo completo termine antes do limite externo. O timeout REST cobre fetch e
leitura do corpo; a obtenção de identidade é medida, mas não é cancelada por
esse sinal. Nenhum deadline foi removido e nenhuma chamada paga foi feita.

## Contrato de integração com MEG-76

Erros REST levam `error.google_diagnostic`, com campos fechados:

- `operation_step`: `submit_analysis`, `submit_stt` ou null.
- `elapsed_ms`: duração inteira, monotônica, incluindo leitura do corpo.
- `error_name`: nome conhecido (incluindo TimeoutError e AbortError), ou null.
- `error_code`: inteiro seguro (incluindo 23) ou código de sistema validado.
- `http_status`: status recebido, inclusive 200 se falhar a leitura, ou null.
- `request_id`: apenas UUID validado de `x-request-id`, ou null.
- `model`, `attempt`, `timeout_ms`: contexto validado e prazo da chamada.

`error.operation_step` e `error.elapsed_ms` identificam a etapa do adaptador.
O diagnóstico não inclui mensagem de exceção, URL, headers, token, vídeo,
prompt ou corpo. O diagnóstico de erro HTTP existente continua separado.
Formatos de request-id não reconhecidos são descartados; ausência de ID não
prova ausência de processamento. Resposta em modo raw mede até os headers,
pois o consumidor é responsável pela leitura posterior.

Em sucesso, os diagnósticos são preservados em `call_diagnostics` no artefato
imutável de análise existente, ao lado da resposta que já era preservada.
Falhas são entregues ao chamador no erro. A MEG-76 precisa copiar somente o
objeto sanitizado para o diagnóstico persistido de WorkerFlow; na base deste
packet, WorkerFlow ainda não copia esse campo. Esta frente não altera
WorkerFlow, ledger, schema de tentativas nem recuperação financeira.

Somente o mecanismo existente de HTTP 429 confirmado permite nova submissão.
Timeout, cancelamento, falha de leitura, persistência ou registro não provocam
replay de inferência. A confirmação de recebimento HTTP não confirma sucesso
da leitura nem reconciliação financeira. O operador integra MEG-75/MEG-76,
publica o PR e acompanha CI; revisão humana independente permanece obrigatória.
