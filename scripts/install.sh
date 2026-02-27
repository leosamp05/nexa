#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${ROOT_DIR}/.env"

if [[ -t 1 ]]; then
  BLUE="\033[1;34m"
  RESET="\033[0m"
else
  BLUE=""
  RESET=""
fi

print_banner() {
  printf "\n%s" "${BLUE}"
  cat <<'EOF'
                            _____                                    
  _____    _____       _____\    \ _____       _____   _____         
  |\    \   \    \     /    / |    |\    \     /    / /      |_       
  \\    \   |    |   /    /  /___/| \    |   |    / /         \      
    \\    \  |    |  |    |__ |___|/  \    \ /    / |     /\    \     
    \|    \ |    |  |       \         \    |    /  |    |  |    \    
      |     \|    |  |     __/ __      /    |    \  |     \/      \   
    /     /\      \ |\    \  /  \    /    /|\    \ |\      /\     \  
    /_____/ /______/|| \____\/    |  |____|/ \|____|| \_____\ \_____\ 
  |      | |     | || |    |____/|  |    |   |    || |     | |     | 
  |______|/|_____|/  \|____|   | |  |____|   |____| \|_____|\|_____| 
                            |___|/                                    
EOF
  printf "%s\n" "${RESET}"
}

print_title() {
  print_banner
  printf "Nexa installer guidato\n"
  printf "======================\n\n"
  printf "Profili:\n"
  printf "  - Development: setup locale rapido, log piu dettagliati.\n"
  printf "  - Production: default piu sicuri e adatti a VPS/ambiente pubblico.\n"
}

print_step() {
  printf "\n-> %s\n" "$1"
}

prompt_with_default() {
  local label="$1"
  local default_value="$2"
  local answer
  read -r -p "${label} [${default_value}]: " answer
  printf "%s" "${answer:-$default_value}"
}

prompt_yes_no() {
  local label="$1"
  local default_value="$2"
  local answer
  read -r -p "${label} [${default_value}]: " answer
  answer="${answer:-$default_value}"
  case "${answer,,}" in
    y|yes|s|si) printf "yes" ;;
    n|no) printf "no" ;;
    *)
      printf "Scelta non valida. Usa yes/no.\n" >&2
      return 1
      ;;
  esac
}

set_env_var() {
  local key="$1"
  local value="$2"
  local tmp_file
  tmp_file="$(mktemp)"

  if [[ -f "$ENV_FILE" ]]; then
    awk -v key="$key" -v value="$value" '
      BEGIN { updated = 0 }
      index($0, key "=") == 1 { print key "=" value; updated = 1; next }
      { print }
      END { if (!updated) print key "=" value }
    ' "$ENV_FILE" > "$tmp_file"
  else
    printf "%s=%s\n" "$key" "$value" > "$tmp_file"
  fi

  mv "$tmp_file" "$ENV_FILE"
}

set_env_if_missing() {
  local key="$1"
  local value="$2"

  if [[ ! -f "$ENV_FILE" ]] || ! grep -q "^${key}=" "$ENV_FILE"; then
    set_env_var "$key" "$value"
  fi
}

generate_secret() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex 32
    return
  fi

  if command -v node >/dev/null 2>&1; then
    node -e "const crypto = require('node:crypto'); console.log(crypto.randomBytes(32).toString('hex'));"
    return
  fi

  date +%s | shasum | awk '{ print $1 }'
}

detect_compose_cmd() {
  if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
    printf "docker compose"
    return
  fi

  if command -v docker-compose >/dev/null 2>&1; then
    printf "docker-compose"
    return
  fi

  printf ""
}

run_cmd() {
  printf "   $ %s\n" "$*"
  "$@"
}

configure_common_env_defaults() {
  set_env_if_missing "MAX_UPLOAD_BYTES" "524288000"
  set_env_if_missing "MAX_DURATION_SECONDS" "3600"
  set_env_if_missing "JOB_TIMEOUT_MS" "900000"
  set_env_if_missing "RATE_LIMIT_WINDOW_SEC" "60"
  set_env_if_missing "RATE_LIMIT_MAX" "25"
  set_env_if_missing "QUEUE_ATTEMPTS" "3"
  set_env_if_missing "QUEUE_RETRY_DELAY_MS" "5000"
  set_env_if_missing "WORKER_CONCURRENCY" "2"
  set_env_if_missing "ANTIVIRUS_ENABLED" "false"
  set_env_if_missing "CAPTCHA_ENABLED" "false"
  set_env_if_missing "CAPTCHA_VERIFY_URL" "https://challenges.cloudflare.com/turnstile/v0/siteverify"
  set_env_if_missing "CAPTCHA_SECRET" ""
  set_env_if_missing "CAPTCHA_SITE_KEY" ""
  set_env_if_missing "NEXT_PUBLIC_CAPTCHA_SITE_KEY" ""
  set_env_if_missing "ALLOWED_SOURCE_HOSTS" "youtube.com,youtu.be,soundcloud.com,vimeo.com,bandcamp.com"
  set_env_if_missing "BLOCKED_SOURCE_PATTERNS" "music.youtube.com"
  set_env_if_missing "AUTH_REQUIRED" "false"
  set_env_if_missing "LOG_LEVEL" "info"
  set_env_if_missing "SENTRY_DSN" ""

  if [[ -f "$ENV_FILE" ]] && grep -q "^SESSION_SECRET=$" "$ENV_FILE"; then
    set_env_var "SESSION_SECRET" "$(generate_secret)"
  fi
  set_env_if_missing "SESSION_SECRET" "$(generate_secret)"
}

print_title
printf "Scegli il profilo:\n"
printf "  1) Development\n"
printf "  2) Production\n"

PROFILE_MODE=""
while [[ -z "$PROFILE_MODE" ]]; do
  profile_choice="$(prompt_with_default "Profilo" "1")"
  case "$profile_choice" in
    1|dev|development)
      PROFILE_MODE="development"
      ;;
    2|prod|production)
      PROFILE_MODE="production"
      ;;
    *)
      printf "Scelta non valida. Inserisci 1 o 2.\n"
      ;;
  esac
done

printf "Scegli la modalita di installazione:\n"
printf "  1) Docker (consigliata)\n"
printf "  2) Normale (Node.js locale)\n"

INSTALL_MODE=""
while [[ -z "$INSTALL_MODE" ]]; do
  choice="$(prompt_with_default "Modalita" "1")"
  case "$choice" in
    1|docker|Docker)
      INSTALL_MODE="docker"
      ;;
    2|normale|normal|native)
      INSTALL_MODE="native"
      ;;
    *)
      printf "Scelta non valida. Inserisci 1 o 2.\n"
      ;;
  esac
done

APP_HOST="$(prompt_with_default "IP/host applicazione" "localhost")"

APP_PORT=""
while [[ -z "$APP_PORT" ]]; do
  raw_port="$(prompt_with_default "Porta applicazione" "3001")"
  if [[ "$raw_port" =~ ^[0-9]+$ ]] && (( raw_port >= 1 && raw_port <= 65535 )); then
    APP_PORT="$raw_port"
  else
    printf "Porta non valida. Inserisci un numero tra 1 e 65535.\n"
  fi
done

AUTH_REQUIRED_DEFAULT="no"
LOG_LEVEL_DEFAULT="debug"
if [[ "$PROFILE_MODE" == "production" ]]; then
  AUTH_REQUIRED_DEFAULT="yes"
  LOG_LEVEL_DEFAULT="info"
fi

while true; do
  AUTH_REQUIRED_ANSWER="$(prompt_yes_no "Richiedere autenticazione login" "$AUTH_REQUIRED_DEFAULT")" && break
done

print_step "Aggiorno file .env"
configure_common_env_defaults
set_env_var "APP_URL" "http://${APP_HOST}:${APP_PORT}"
set_env_var "APP_DOMAIN" "$APP_HOST"
set_env_var "APP_PORT" "$APP_PORT"
if [[ "$AUTH_REQUIRED_ANSWER" == "yes" ]]; then
  set_env_var "AUTH_REQUIRED" "true"
else
  set_env_var "AUTH_REQUIRED" "false"
fi
set_env_var "LOG_LEVEL" "$LOG_LEVEL_DEFAULT"

mkdir -p "${ROOT_DIR}/storage"

if [[ "$INSTALL_MODE" == "docker" ]]; then
  USE_CADDY="no"
  while true; do
    USE_CADDY="$(prompt_yes_no "Abilitare anche reverse proxy Caddy (80/443)" "no")" && break
  done

  compose_cmd="$(detect_compose_cmd)"
  if [[ -z "$compose_cmd" ]]; then
    printf "\nDocker Compose non trovato. Installa Docker Desktop o docker-compose e riprova.\n"
    exit 1
  fi

  docker_bind_ip="0.0.0.0"
  if [[ "$APP_HOST" == "localhost" || "$APP_HOST" == "127.0.0.1" ]]; then
    docker_bind_ip="127.0.0.1"
  fi

  set_env_var "APP_BIND_IP" "$docker_bind_ip"
  set_env_var "DATABASE_URL" "postgresql://postgres:postgres@postgres:5432/convertitore?schema=public"
  set_env_var "REDIS_URL" "redis://redis:6379"
  set_env_var "DATA_DIR" "/app/storage"

  services=(postgres redis web worker)
  if [[ "$USE_CADDY" == "yes" ]]; then
    services+=(caddy)
  fi

  if [[ "$AUTH_REQUIRED_ANSWER" == "yes" ]]; then
    set_env_var "AUTH_REQUIRED" "true"
    admin_email="$(prompt_with_default "Email admin iniziale (seed opzionale)" "admin@example.com")"
    read -r -s -p "Password admin iniziale (lascia vuoto per saltare): " admin_password
    printf "\n"
    if [[ -n "$admin_password" ]]; then
      set_env_var "ADMIN_EMAIL" "$admin_email"
      set_env_var "ADMIN_PASSWORD" "$admin_password"
    fi
  else
    set_env_var "AUTH_REQUIRED" "false"
  fi

  print_step "Avvio servizi Docker (${services[*]})"
  if [[ "$compose_cmd" == "docker compose" ]]; then
    run_cmd docker compose up -d --build "${services[@]}"
  else
    run_cmd docker-compose up -d --build "${services[@]}"
  fi

  print_step "Installazione completata"
  printf "Apri: http://%s:%s\n" "$APP_HOST" "$APP_PORT"
  if [[ "$USE_CADDY" == "yes" ]]; then
    printf "Caddy attivo su: http://%s e https://%s\n" "$APP_HOST" "$APP_HOST"
  fi
  printf "Log web:   docker compose logs -f web\n"
  printf "Log worker: docker compose logs -f worker\n"
  exit 0
fi

set_env_var "APP_BIND_IP" "$APP_HOST"
set_env_var "DATABASE_URL" "postgresql://postgres:postgres@localhost:5432/convertitore?schema=public"
set_env_var "REDIS_URL" "redis://localhost:6379"
set_env_var "DATA_DIR" "${ROOT_DIR}/storage"
if [[ "$AUTH_REQUIRED_ANSWER" == "yes" ]]; then
  set_env_var "AUTH_REQUIRED" "true"
  admin_email="$(prompt_with_default "Email admin iniziale (seed opzionale)" "admin@example.com")"
  read -r -s -p "Password admin iniziale (lascia vuoto per saltare): " admin_password
  printf "\n"
  if [[ -n "$admin_password" ]]; then
    set_env_var "ADMIN_EMAIL" "$admin_email"
    set_env_var "ADMIN_PASSWORD" "$admin_password"
  fi
else
  set_env_var "AUTH_REQUIRED" "false"
fi

if ! command -v npm >/dev/null 2>&1; then
  printf "\nNode.js/npm non trovato. Installa Node.js (LTS) e riprova.\n"
  exit 1
fi

if command -v nc >/dev/null 2>&1; then
  if ! nc -z localhost 5432 >/dev/null 2>&1; then
    printf "\nAttenzione: PostgreSQL non risponde su localhost:5432.\n"
  fi
  if ! nc -z localhost 6379 >/dev/null 2>&1; then
    printf "Attenzione: Redis non risponde su localhost:6379.\n"
  fi
fi

print_step "Installo dipendenze e preparo database"
run_cmd npm install
run_cmd npm run prisma:generate
run_cmd npm run prisma:migrate
run_cmd npm run seed

print_step "Installazione completata"
printf "Avvia web:    npm run dev -w @convertitore/web -- --hostname %s --port %s\n" "$APP_HOST" "$APP_PORT"
printf "Avvia worker: npm run dev -w @convertitore/worker\n"
printf "Apri: http://%s:%s\n" "$APP_HOST" "$APP_PORT"
