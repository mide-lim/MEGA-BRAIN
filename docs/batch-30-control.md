# Controle do lote adicional de 30 vídeos

O lote aumenta o piloto de 20 para 50 fontes. Seu teto é R$150, com R$126 para as reservas estimadas de processamento e R$24 protegidos para variações e despesas auxiliares. Os valores são limites preventivos em centavos, não tarifas verificadas nem cobrança faturada. Reservas não constituem um limite de faturamento imposto ao provedor: custos reais precisam de conferência.

## Orçamento e histórico

`settings/financial.batch` contém uma identidade, exatamente 30 IDs novos, estado pausado/ativo, `budget_cents: 15000` e `overhead_cents: 2400`. A margem faz parte do teto. O processamento usa, no máximo, o teto menos essa proteção. Uma eventual redistribuição da margem exige atualização administrativa explícita baseada em custos conferidos; o worker nunca a reduz automaticamente e o teto permanece R$150.

Cada nova reserva recebe `batch_id`. O saldo do lote é calculado pelos custos concluídos e reservas abertas desse lote, sem reiniciar o gasto histórico. As reservas antigas com resultado incerto continuam deduzidas do saldo global. O saldo disponível para qualquer etapa é o menor entre os limites global, do piloto (se houver) e do lote.

As alterações da reserva e dos totais continuam na mesma atualização condicional do documento financeiro. Só uma etapa do lote pode ficar reservada/iniciada de cada vez. O início e a entrada do adaptador revalidam saldo, pausa e validade dos créditos. Um resultado incerto no lote impede outro vídeo, mesmo que alguém apenas retire a pausa global. A identidade permanente da execução e o histórico impedem repetir uma etapa ou trocar sua revisão para contornar o bloqueio.

## Limites desta extensão

Sem lote configurado, o livro continua limitado a 100 operações e a capacidade a 200 objetos. Com lote válido, os limites passam a 200 operações e 400 objetos. O cenário atual ocupa 97 operações; 30 vídeos exigem até 90 novas etapas. Cinco objetos por novo vídeo (mídia, áudio, transcrição, análise e legenda) ocupam até 150 posições adicionais sobre as 117 atuais. O backup administrativo aceita até 400 objetos.

Nenhum histórico é removido. O documento financeiro também tem limite preventivo de tamanho. Esta é uma extensão limitada para 50 fontes, não suporte a 3 mil; outro lote não pode substituir esta configuração enquanto seus registros existirem. Antes de crescimento maior, os registros precisam de armazenamento que não dependa desses mapas limitados.

A configuração do worker usa `batch_id` e `pilot_video_ids` com os 30 IDs. Listas acima de 20 só são aceitas com identidade de lote. O worker confere a identidade contra o registro financeiro. Novos objetos fora da lista são recusados. A existência de objetos antigos e suas verificações de integridade permanecem compatíveis.

## Preparação offline

Execute `node google-v0/scripts/prepare-batch.mjs entrada.json plano.json`. A entrada privada contém `batch_id`, `financial`, `capacity`, `existing_video_ids` (20) e `candidates` (30 objetos com `id` e `url`). São snapshots decodificados, sem credenciais.

O comando valida o livro, URLs/IDs, ausência de vídeos antigos e espaço de registros; escreve um arquivo novo com permissões restritas. Não consulta serviços, não modifica o banco, não importa links e não inicia processamento. A saída contém apenas mudanças propostas e fica `ready_for_execution: false`. Nunca sobrescreve uma preparação anterior.

## Ativação e verificação

Antes de aplicar:

1. Revisar o commit final e os testes, publicar o controle e conferir os serviços.
2. Confirmar disponibilidade, duração e custos vigentes dos candidatos; substituir qualquer candidato antes de registrar o lote.
3. Registrar observação real e atual dos créditos e custos persistentes. Não renovar a data de uma observação antiga. Os três resultados financeiros incertos do piloto anterior permanecem protegidos.
4. Planejar a reprodução e despesas auxiliares dentro dos R$24 protegidos. A política de reprodução anterior não é ampliada por esta mudança.
5. Com fila e processamento pausados, obter snapshots atuais e aplicar as alterações propostas condicionadas às versões dos documentos. Registrar o lote pausado antes de elevar a capacidade e ajustar a configuração do worker. Conferir os totais e históricos após cada alteração.
6. Importar somente os 30 IDs novos e ativar o lote após conferir todos os pré-requisitos. Processar um por vez; parar em incerteza, saldo insuficiente ou limite de capacidade. Não limpar registros para retentar.
7. Revisar os 30 destinos e reportar reservas, custos registrados, falhas e pendências antes de propor 100 fontes.

A pausa pode ser restabelecida sem apagar o lote ou o histórico. Reservas iniciadas/incertas não são liberadas automaticamente. O controle financeiro de novas etapas não substitui a conferência de custos persistentes e de faturamento da conta.
