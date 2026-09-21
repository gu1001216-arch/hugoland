# Hugoland na nuvem

Painel web com coletor 24h do Adventures Beyond Wonderland. Grava todas as rodadas num PostgreSQL
e calcula, para cada combinação, quantas rodadas seguidas estão sem sair (zera quando sai qualquer
resultado da combinação). Acesso por link, com senha, em qualquer aparelho.

## Publicar no Railway

1. **GitHub**: crie um repositório novo (de preferência *Private*), por exemplo `hugoland-nuvem`,
   e envie todos os arquivos desta pasta (Add file > Upload files).
2. **Railway**: New Project > Deploy from GitHub repo > escolha o repositório.
3. No mesmo projeto: **+ Create > Database > PostgreSQL**.
4. Clique no serviço do app > **Variables** e cadastre:
   - `DATABASE_URL` = `${{Postgres.DATABASE_URL}}`
   - `APP_PASSWORD` = a senha de acesso ao painel
5. Serviço do app > **Settings > Networking > Generate Domain**. Esse é o link de acesso.
6. Abra o link, entre com a senha e confira em **Configurar** se aparece "Coletando normalmente".

## Variáveis opcionais

| Variável | Padrão | Para quê |
|---|---|---|
| `POLL_FAST_SECONDS` | 2 | consulta quando o giro está para terminar |
| `POLL_SLOW_SECONDS` | 6 | consulta logo depois de um giro |
| `UPSTREAM_URL` | API do CasinoScores (ABW) | trocar a fonte |
| `COLLECTOR` | on | `off` desliga o coletor (só painel) |
| `SECRET_KEY` | derivada da senha | chave das sessões de login |

## Trazer o histórico do tablet

No app do tablet: Histórico > Exportar JSON. No painel web: Histórico > Importar JSON.
Rodadas repetidas são ignoradas.

## Tempo real

- Cada rodada é gravada com o horário em que o giro terminou (vem da fonte), não com o horário da consulta.
- O coletor consulta a cada 2 s quando o giro está para terminar: a rodada é gravada até ~2 s depois de a fonte publicar.
- O painel recebe aviso do servidor na hora em que grava (sem esperar atualização).
- Em Configurar aparece o "Atraso até gravar", medido do fim do giro até a gravação.

## Observações
- Durante uma atualização no Railway, a versão nova assume a coleta assim que a antiga desliga.

- O coletor recupera sozinho as rodadas perdidas em quedas de até ~6 horas (limite da fonte).
- Se a fonte bloquear o servidor, o painel mostra "Fonte fora" e a mensagem aparece em Configurar.
- Trocar a senha (`APP_PASSWORD`) desconecta todos os aparelhos.
