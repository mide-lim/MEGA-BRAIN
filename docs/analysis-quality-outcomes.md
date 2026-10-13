# Respostas de análise que precisam de revisão

Uma resposta recebida e salva pode conter categorias inválidas, JSON inválido, estrutura incompleta ou término antecipado. Esses resultados ficam com `analysis_quality_status: review_required`, motivos limitados e referência ao objeto bruto imutável. O vídeo fica `needs_attention`; a análise publicada anterior é preservada e, para um vídeo novo, `analysis` permanece nula. Categorias inválidas não recebem um destino inventado.

A operação só liquida sua estimativa conservadora depois que o objeto bruto e o estado de revisão foram persistidos. O job conclui e não permite repetir inferência. A referência do candidato deve pertencer ao vídeo e à execução, com geração persistida. A ausência dessa referência, falha do provedor, escrita no armazenamento ou falha de persistência no banco mantém a reserva incerta e a pausa. A estimativa continua não sendo uma fatura do Google.

As regras existentes de evidência continuam descartando citações não sustentadas e horários fora da duração, preservando limitações e a resposta original. Validação estrutural não prova que uma categoria semanticamente plausível esteja correta: isso ainda exige avaliação de qualidade.

## Reprodução e recuperação

A resposta real já salva do primeiro vídeo foi reproduzida offline: a combinação de duas categorias gerais resulta em `invalid_categories`, sem nova chamada paga e sem publicação. Nenhum conteúdo privado do vídeo foi incorporado aos testes ou a este documento.

A correção não reabre nem liquida automaticamente jobs antigos incertos. Antes da recuperação administrativa, conferir o objeto e sua geração, vídeo/execução, término da resposta, versão do documento financeiro e custo conservador reservado; preservar o objeto, registrar o motivo da conciliação e atualizar o candidato e a contabilidade de forma condicional. Não apagar o job, marcar `retry_ready` nem reenviar a tarefa para recuperar bookkeeping. O lote continua pausado até essa recuperação e a publicação aprovada do código.

## Conferência dos primeiros três

Conferir destino, resumo, evidências, pendências e custo registrado de cada resultado. Revisão de qualidade não dispara outro vídeo automaticamente. Se dois dos três precisarem de revisão ou o mesmo defeito se repetir, suspender a expansão e corrigir a causa comum; qualquer falha operacional mantém a pausa imediata. Com uma pendência isolada, avaliar explicitamente os três antes de enviar os outros 27.

A taxonomia atual não tem destino específico para política/geopolítica/religião. `a-organizar` é o destino existente quando nenhuma opção serve, nunca uma justificativa para tecnologia. Não foi criada categoria nem regra específica para esse vídeo. Levantar a recorrência de assuntos sem cobertura no lote antes de propor ampliação da árvore.
