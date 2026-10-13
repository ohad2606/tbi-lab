#!/bin/bash
# G2 live logging check, part 2: count a marker's values in the journal and syslog (never prints a
# log line). Usage: count-g2-markers.sh <marker> <since, e.g. 2026-10-13T12:10:00>
M=$1; SINCE=$2
J() { sudo journalctl --since "$SINCE" -o cat --no-pager; }
Y() { sudo cat /var/log/syslog | awk -v s="$SINCE" '$1 >= s'; }
for src in journal syslog; do
  f=J; [ $src = syslog ] && f=Y
  secret=$($f | grep -oE "$M-(SESSION|BEARER|CODE|STATE|CSRF)[0-9A-Za-z-]*" | wc -l)
  keep=$($f | grep -oE "KEEP(PAGE|JSON|UA)-$M" | sort | uniq -c | awk '{printf "%s=%s ", $2, $1}' | sed "s/-$M//g")
  echo "$src: secret-shaped marker values=$secret | kept: $keep"
done
echo "journal oauth2-proxy lines since: $(sudo journalctl -u oauth2-proxy --since "$SINCE" -o cat | wc -l); with marker: $(sudo journalctl -u oauth2-proxy --since "$SINCE" -o cat | grep -c "$M")"
echo "  operational error kept (state parse): $(sudo journalctl -u oauth2-proxy --since "$SINCE" -o cat | grep -c 'Error while parsing OAuth2 state')"
echo "  request dumps stored: $(sudo journalctl -u oauth2-proxy --since "$SINCE" -o cat | grep -c '&{GET')  callback queries stored: $(sudo journalctl --since "$SINCE" -o cat | grep -c '/oauth2/callback?[^ "]*\(code\|state\)=')"
echo "caddy callback audit lines: $(sudo journalctl -u caddy --since "$SINCE" -o cat | grep "KEEPUA-$M" | grep -c '"uri":"/oauth2/callback')  statuses: $(sudo journalctl -u caddy --since "$SINCE" -o cat | grep "KEEPUA-$M" | grep -oE '"status":[0-9]+' | sort | uniq -c | tr -s ' ' | tr '\n' ' ')"
echo "caddy lines with Cookie/Authorization header keys: $(sudo journalctl -u caddy --since "$SINCE" -o cat | grep "KEEPUA-$M" | grep -cE '"(Cookie|Authorization)":')"
