# Limites de runtime na publicação

A revisão de deploy do PR32 parou com Runtime limits changed porque a guarda antiga exigia uma instância em ambos os serviços. O worker já tinha quatro instâncias autorizadas para o lote de200; o web permanecia em uma. Nenhum serviço foi alterado nessa tentativa.

A guarda agora compara limites atuais com runtime_max_instances, mapa explícito contendo worker e web, inteiros de1 a4. Ausência desse mapa mantém o comportamento anterior: uma instância para ambos. O workflow revisado declara worker4/web1 em MEGABRAIN_RUNTIME_MAX_INSTANCES. Se a configuração protegida já fornecer um mapa conflitante, o deploy para; não substitui silenciosamente.

Isso não escala os serviços. Atualizações seguem restritas à imagem, com fila pausada, fingerprint conferido, identidade e segredos fixados, verificação de saúde e rollback existentes. Qualquer diferença dos limites esperados bloqueia a publicação.

Após revisão e merge desta correção, repetir review no commit final e no fingerprint atual. Só depois de review bem-sucedido disparar deploy uma vez. Conferir frontend completo, aplicar propostas de categorias com histórico preservado e preparar handoff da fila. Não retomar o acompanhamento Codex.
