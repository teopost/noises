COMPOSE ?= docker compose
SERVICE ?= noises
PORT    ?= 8080
export NOISES_PORT := $(PORT)

.DEFAULT_GOAL := help
.PHONY: help build rebuild update-ytdlp up up-https https-ca start down stop restart logs ps shell status open clean purge

help: ## Mostra questo aiuto
	@grep -E '^[a-zA-Z_-]+:.*?## ' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-10s\033[0m %s\n", $$1, $$2}'

build: ## Costruisce l'immagine
	$(COMPOSE) build

rebuild: ## Ricostruisce l'immagine senza cache
	$(COMPOSE) build --no-cache

update-ytdlp: ## Aggiorna yt-dlp all'ultima versione e riavvia
	$(COMPOSE) build --build-arg YTDLP_CACHEBUST=$$(date +%s)
	$(COMPOSE) up -d

up: ## Avvia in background (costruisce se necessario)
	$(COMPOSE) up -d --build
	@echo "Noises in esecuzione su http://localhost:$(PORT)"

up-https: ## Avvia con HTTPS (necessario aprendo l'app da un altro computer, es. Raspberry Pi)
	$(COMPOSE) --profile https up -d --build
	@echo "Noises in esecuzione su https://$$(echo $${HTTPS_HOSTS:-$$(grep -s '^HTTPS_HOSTS=' .env | cut -d= -f2)} | cut -d, -f1 | tr -d ' ')"

https-ca: ## Esporta il certificato della CA locale (noises-ca.crt) da installare sui dispositivi
	$(COMPOSE) --profile https cp https:/data/caddy/pki/authorities/local/root.crt ./noises-ca.crt
	@echo "Creato noises-ca.crt: installalo come autorità attendibile per evitare l'avviso del browser"

start: up ## Alias di up

down: ## Ferma e rimuove i container (i dati restano)
	$(COMPOSE) --profile https down

stop: ## Ferma i container senza rimuoverli
	$(COMPOSE) stop

restart: ## Riavvia il servizio
	$(COMPOSE) restart $(SERVICE)

logs: ## Segue i log
	$(COMPOSE) logs -f --tail=200 $(SERVICE)

ps: ## Stato dei container
	$(COMPOSE) ps

status: ps ## Alias di ps

shell: ## Apre una shell nel container
	$(COMPOSE) exec $(SERVICE) bash

open: ## Apre l'applicazione nel browser
	@xdg-open http://localhost:$(PORT) 2>/dev/null || explorer.exe http://localhost:$(PORT) 2>/dev/null || echo "Apri http://localhost:$(PORT)"

clean: ## Rimuove container, immagine e volume dati (CANCELLA i brani!)
	$(COMPOSE) --profile https down -v --rmi local --remove-orphans

purge: clean ## clean + pulizia della build cache di Docker
	docker builder prune -f
