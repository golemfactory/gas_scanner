#!/bin/bash

API_ADDRESS=${1:-api}
sed -i "s/API_ADDRESS/$API_ADDRESS/" /etc/nginx/conf.d/default.conf

nginx -g 'daemon off;'
