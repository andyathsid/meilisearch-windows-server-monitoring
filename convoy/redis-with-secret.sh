#!/bin/sh
set -eu

exec redis-server \
  --appendonly yes \
  --appendfsync always \
  --maxmemory 256mb \
  --maxmemory-policy noeviction \
  --requirepass "$(cat /run/secrets/convoy_redis_password)"
