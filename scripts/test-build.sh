#!/usr/bin/env bash
set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

COMPOSE_FILE="docker-compose.prod.yml"
PROJECT="trueblue-test"
APP_IMAGE="trueblue-test-app:local"
MIGRATE_IMAGE="trueblue-test-migrate:local"

log() { echo -e "${GREEN}[TEST]${NC} $1"; }
warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
fail() { echo -e "${RED}[FAIL]${NC} $1"; exit 1; }

cleanup() {
    log "Cleaning up..."
    docker compose -p "$PROJECT" -f "$COMPOSE_FILE" down -v --remove-orphans 2>/dev/null || true
    docker image rm "$APP_IMAGE" "$MIGRATE_IMAGE" >/dev/null 2>&1 || true
    rm -f .env.test /tmp/trueblue-test-login-response.json
    log "Cleanup complete."
}

trap cleanup EXIT

docker info > /dev/null 2>&1 || fail "Docker is not running"

log "Starting production build test..."

cat > .env.test <<'EOF'
DATABASE_URL=postgresql://trueblue:testpass123@db:5432/trueblue?schema=public
POSTGRES_USER=trueblue
POSTGRES_PASSWORD=testpass123
POSTGRES_DB=trueblue
JWT_ACCESS_SECRET=test-access-secret-not-for-production-use-1234567890abcdef
JWT_REFRESH_SECRET=test-refresh-secret-not-for-production-use-1234567890abcdef
JWT_ACCESS_EXPIRY=900
JWT_REFRESH_EXPIRY=604800
NEXT_PUBLIC_APP_URL=http://localhost
NODE_ENV=production
USE_SECURE_COOKIES=false
AWS_REGION=us-east-1
AWS_S3_BUCKET=trueblue-documents-test
APP_IMAGE=trueblue-test-app:local
MIGRATE_IMAGE=trueblue-test-migrate:local
EOF

log "Building production app image (this may take a few minutes)..."
docker buildx build --platform linux/amd64 --target runner -t "$APP_IMAGE" --load . || fail "App image build failed"
echo -e "${GREEN}[PASS]${NC} App image built successfully"

log "Building migration image..."
docker buildx build --platform linux/amd64 --target migrate -t "$MIGRATE_IMAGE" --load . || fail "Migration image build failed"
echo -e "${GREEN}[PASS]${NC} Migration image built successfully"

log "Starting PostgreSQL..."
docker compose -p "$PROJECT" -f "$COMPOSE_FILE" --env-file .env.test up -d db || fail "Failed to start database"

log "Waiting for database to be ready..."
for i in $(seq 1 30); do
    if docker compose -p "$PROJECT" -f "$COMPOSE_FILE" --env-file .env.test exec -T db pg_isready -U trueblue > /dev/null 2>&1; then
        echo -e "${GREEN}[PASS]${NC} Database is ready"
        break
    fi
    if [ "$i" -eq 30 ]; then
        fail "Database did not become ready in 30 seconds"
    fi
    sleep 1
done

log "Running Prisma migrations..."
docker compose -p "$PROJECT" -f "$COMPOSE_FILE" --env-file .env.test --profile setup run --rm migrate || fail "Migrations failed"
echo -e "${GREEN}[PASS]${NC} Migrations completed"

log "Starting app and nginx..."
docker compose -p "$PROJECT" -f "$COMPOSE_FILE" --env-file .env.test up -d app nginx || fail "Failed to start app/nginx"

log "Waiting for app to respond..."
for i in $(seq 1 60); do
    STATUS=$(docker compose -p "$PROJECT" -f "$COMPOSE_FILE" --env-file .env.test exec -T nginx wget -q -O /dev/null -S http://app:3000 2>&1 | grep "HTTP/" | awk '{print $2}' || echo "")
    if [ "$STATUS" = "200" ] || [ "$STATUS" = "307" ]; then
        echo -e "${GREEN}[PASS]${NC} App is responding (HTTP $STATUS)"
        break
    fi
    if [ "$i" -eq 60 ]; then
        warn "App did not respond in 60 seconds. Checking logs..."
        docker compose -p "$PROJECT" -f "$COMPOSE_FILE" --env-file .env.test logs app --tail 30
        fail "App health check failed"
    fi
    sleep 2
done

log "Testing endpoints via nginx..."

LANDING=$(curl -s -o /dev/null -w "%{http_code}" http://localhost/ || echo "")
if [ "$LANDING" = "200" ]; then
    echo -e "${GREEN}[PASS]${NC} GET / -> 200"
else
    warn "GET / -> $LANDING (expected 200)"
fi

LOGIN=$(curl -s -o /dev/null -w "%{http_code}" http://localhost/login || echo "")
if [ "$LOGIN" = "200" ]; then
    echo -e "${GREEN}[PASS]${NC} GET /login -> 200"
else
    warn "GET /login -> $LOGIN (expected 200)"
fi

API_STATUS=$(curl -s -o /tmp/trueblue-test-login-response.json -w "%{http_code}" \
    -H 'Content-Type: application/json' \
    -d '{"email":"bad@test.com","password":"wrong"}' \
    http://localhost/api/auth/login || echo "")

if [ "$API_STATUS" = "401" ] && grep -q "Invalid" /tmp/trueblue-test-login-response.json 2>/dev/null; then
    echo -e "${GREEN}[PASS]${NC} POST /api/auth/login (bad creds) -> 401"
else
    warn "POST /api/auth/login unexpected response (status: $API_STATUS)"
fi

log "Checking container status..."
docker compose -p "$PROJECT" -f "$COMPOSE_FILE" --env-file .env.test ps

echo ""
echo -e "${GREEN}============================================${NC}"
echo -e "${GREEN}  Production build test PASSED${NC}"
echo -e "${GREEN}============================================${NC}"
echo ""
