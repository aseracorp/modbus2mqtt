#!/bin/sh
# Runs as root before the app service starts. Ensures required directories
# exist with the correct ownership, performs the legacy /data/local ->
# <config-root>/modbus2mqtt migration, and selects the configuration directory.
#
# Storage layout (Docker / LXC):
#   MODBUS2MQTT_DATA_CONFIG=1  ->  config at /data/config/modbus2mqtt
#                                  (everything persistent under /data)
#   default                    ->  config at /config/modbus2mqtt
#                                  (upstream layout, /config must be a volume)
# In both modes /data/public holds the git-cloned public specifications, so
# /data is always the persistent share. When MODBUS2MQTT_DATA_CONFIG=1 every
# user setting (MQTT config, busses, devices, local specs, secrets) survives
# container recreation because /data is mounted.

if [ "$MODBUS2MQTT_DATA_CONFIG" = "1" ]; then
    CONFIG_ROOT="/data/config"
else
    CONFIG_ROOT="/config"
fi
mkdir -p "$CONFIG_ROOT"
mkdir -p "$CONFIG_ROOT/modbus2mqtt"
mkdir -p /data/public

# Migration from old config location /data/local to <CONFIG_ROOT>/modbus2mqtt
# Only runs once: if the active config file is already present, the migration
# is already done (an empty busses/ directory is a valid state, so it must not
# trigger a re-copy on every boot).
if [ ! -f "$CONFIG_ROOT/modbus2mqtt/modbus2mqtt.yaml" ] && [ -d /data/local ]; then
    echo "Migrating /data/local to $CONFIG_ROOT/modbus2mqtt"
    cp -R /data/local/. "$CONFIG_ROOT/modbus2mqtt/"
    chown -R modbus2mqtt:dialout "$CONFIG_ROOT/modbus2mqtt"
fi
chown -R modbus2mqtt:dialout "$CONFIG_ROOT/modbus2mqtt"
chown -R modbus2mqtt:dialout /data/public
touch /ssl/secrets.txt
chown -R modbus2mqtt:dialout /ssl/secrets.txt
export HOME=/root
git config --global --add safe.directory /data/public
