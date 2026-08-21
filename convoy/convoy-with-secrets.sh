#!/bin/sh
set -eu

export CONVOY_DB_PASSWORD="$(cat /run/secrets/convoy_postgres_password)"
export CONVOY_REDIS_PASSWORD="$(cat /run/secrets/convoy_redis_password)"
export CONVOY_JWT_SECRET="$(cat /run/secrets/convoy_jwt_secret)"
export CONVOY_JWT_REFRESH_SECRET="$(cat /run/secrets/convoy_jwt_refresh_secret)"

exec /cmd "$@"
