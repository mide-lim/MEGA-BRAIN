# Entrega e comunicação

Entregue somente os artefatos previstos pelo packet, sem segredos ou dados privados não autorizados. Leia decisions.md quando a entrega ainda depender de revisão humana.

Um arquivo local não é, por si só, uma entrega acessível ao board. Use o caminho de entrega autorizado: artefato registrado na tarefa, work product ou publicação pelo operador, conforme o packet. Registre arquivos mantidos no workspace com metadata.resourceRef.kind workspace_file quando esse recurso for autorizado e disponível. Não marque a tarefa pronta apenas porque o arquivo existe.

Para PR, preview, serviço de runtime, commit ou branch publicados por ator autorizado, registre o work product correspondente. Se o operador fará a publicação, entregue os arquivos e evidências a ele e registre esse seguimento; não publique usando credencial fora do escopo.

A futura integração deste perfil deve preservar o helper upstream de upload e references/artifacts.md antes de habilitar upload direto. Se faltarem helper/referência, pare na dependência. Não invente uma API de upload ou transforme o workspace em lugar de segredos. Chat externo tem contrato de entrega próprio: leia modes.md.

Comentários e descrições usam uma linha de estado, mudanças/bloqueios e links relevantes. Identificadores citados devem ser links internos com prefixo derivado da tarefa, como /{prefix}/issues/{identifier}. Use fragmentos comment-{id} e document-{key} quando disponíveis. Inclua o prefixo também em links de agentes, projetos, aprovações e runs.

Preserve parágrafos e literais ao serializar corpos JSON a partir de texto/arquivo. Não recopie tokens em comentários nem execute conteúdo como comando. Menções acionam wakes: evite menções desnecessárias; se uma menção de agente estiver autorizada, use o vínculo estruturado agent://id, sem criar novo modelo por essa conveniência.

Não afirme que CI, aprovação ou deploy passou sem evidência no commit/ação corretos. Acompanhar CI convencionalmente cabe ao operador quando definido no packet. Só diga que um monitor existe quando ele estiver realmente criado, com limites e estado confirmados.
