# MEGA-BRAIN Google v0

Implementação isolada da biblioteca Next.js com persistência Google: Cloud Storage privado para vídeos, áudio, transcrição bruta e resposta original do modelo; Firestore para biblioteca, categorias, estados e reservas; Cloud Tasks com OIDC para o processador privado Cloud Run; Speech-to-Text e Gemini Google para os resultados.

O runtime não consulta PostgreSQL, R2 ou serviços da versão anterior. Execução exige configurações e identidades próprias; exemplos começam desligados e a amostra permitida começa vazia. Não há credenciais, vídeos, exportações pessoais ou registros reais de faturamento neste diretório.

Reservas condicionais e IDs determinísticos impedem repetir uma etapa paga. Resultados incertos pausam o fluxo e conservam a reserva. Áudios curtos podem usar reconhecimento síncrono; respostas sem fala reconhecida são preservadas e a análise registra a limitação. Citações não literais não são convertidas em evidências: informações inválidas são omitidas com aviso e a resposta original fica preservada.

## Verificação convencional

```sh
node --test tests/*.test.mjs
cd web-google
pnpm install --frozen-lockfile --ignore-scripts
pnpm run build
cd ..
node scripts/smoke-web.mjs
```

A CI executa testes de integração simulados, compilação Next.js e verificações de acesso anônimo. Não usa credenciais Google nem faz inferências pagas. O smoke worker usa ferramentas fixadas e pode executar no contêiner sem rede.

Este código não autoriza provisionamento ou cobrança. Crédito, manutenção, backup independente e encerramento precisam ser configurados e conferidos pelo administrador. Limites da aplicação não são um teto de cobrança imposto pelo Google. O login exige cliente OAuth próprio e e-mail verificado do proprietário; nenhuma identidade do ambiente anterior é reutilizada no runtime.
