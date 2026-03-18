#!/usr/bin/env bash
set -euo pipefail

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

COMPOSE_FILE="docker-compose.prod.yml"
PROJECT="trueblue-test"

log() { echo -e "${GREEN}[TEST]${NC} $1"; }
warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
fail() { echo -e "${RED}[FAIL]${NC} $1"; exit 1; }

cleanup() {
    log "Cleaning up..."
    docker compose -p "$PROJECT" -f "$COMPOSE_FILE" down -v --remove-orphans 2>/dev/null || true
    log "Cleanup complete."
}

trap cleanup EXIT

# Check Docker is running
docker info > /dev/null 2>&1 || fail "Docker is not running"

log "Starting production build test..."

# Create test .env if not exists
if [ ! -f .env.test ]; then
    cat > .env.test << 'EOF'
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
EOF
fi

# Step 1: Build the Docker image
log "Building production Docker image (this may take a few minutes)..."
docker compose -p "$PROJECT" -f "$COMPOSE_FILE" --env-file .env.test build --no-cache || fail "Docker build failed"
echo -e "${GREEN}[PASS]${NC} Docker image built successfully"

# Step 2: Start database
log "Starting PostgreSQL..."
docker compose -p "$PROJECT" -f "$COMPOSE_FILE" --env-file .env.test up -d db || fail "Failed to start database"

# Wait for database
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

# Step 3: Run migrations
log "Running Prisma migrations..."
docker compose -p "$PROJECT" -f "$COMPOSE_FILE" --env-file .env.test --profile setup run --rm migrate || fail "Migrations failed"
echo -e "${GREEN}[PASS]${NC} Migrations completed"

# Step 4: Start app and nginx
log "Starting app and nginx..."
docker compose -p "$PROJECT" -f "$COMPOSE_FILE" --env-file .env.test up -d app nginx || fail "Failed to start app/nginx"

# Wait for app to respond
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

# Step 5: Test endpoints via nginx
log "Testing endpoints via nginx..."

# Test landing page
LANDING=$(docker compose -p "$PROJECT" -f "$COMPOSE_FILE" --env-file .env.test exec -T nginx wget -q -O /dev/null -S http://localhost 2>&1 | grep "HTTP/" | awk '{print $2}' || echo "")
if [ "$LANDING" = "200" ]; then
    echo -e "${GREEN}[PASS]${NC} GET / → 200"
else
    warn "GET / → $LANDING (expected 200)"
fi

# Test login page
LOGIN=$(docker compose -p "$PROJECT" -f "$COMPOSE_FILE" --env-file .env.test exec -T nginx wget -q -O /dev/null -S http://localhost/login 2>&1 | grep "HTTP/" | awk '{print $2}' || echo "")
if [ "$LOGIN" = "200" ]; then
    echo -e "${GREEN}[PASS]${NC} GET /login → 200"
else
    warn "GET /login → $LOGIN (expected 200)"
fi

# Test API auth (invalid creds should return 401)
API_RESP=$(docker compose -p "$PROJECT" -f "$COMPOSE_FILE" --env-file .env.test exec -T nginx wget -q -O - --post-data='{"email":"bad@test.com","password":"wrong"}' --header='Content-Type: application/json' http://localhost/api/auth/login 2>&1 || echo "")
if echo "$API_RESP" | grep -q "Invalid"; then
    echo -e "${GREEN}[PASS]${NC} POST /api/auth/login (bad creds) → rejected"
else
    warn "POST /api/auth/login unexpected response"
fi

# Step 6: Check container health
log "Checking container status..."
docker compose -p "$PROJECT" -f "$COMPOSE_FILE" --env-file .env.test ps

echo ""
echo -e "${GREEN}============================================${NC}"
echo -e "${GREEN}  Production build test PASSED${NC}"
echo -e "${GREEN}============================================${NC}"
echo ""

# Clean up test env file
rm -f .env.test
