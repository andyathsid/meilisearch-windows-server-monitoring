#!/bin/sh
set -eu

export REDIS_ADDR=redis://convoy-redis:6379
export REDIS_PASSWORD="$(cat /run/secrets/convoy_redis_password)"

exec /redis_exporter
