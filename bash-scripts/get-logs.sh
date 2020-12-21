#!/bin/bash
#test-mode cat log-example-$1.txt
#test-mode exit

CONTAINER=nearup$1
#export NEAR_ENV=guildnet
docker exec $CONTAINER /root/.nearup/nearup logs -n 40
