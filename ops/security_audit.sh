#!/usr/bin/env bash
set -euo pipefail

if (( EUID != 0 )); then
  exec sudo -n -- "$0" "$@"
fi

SUSPICIOUS_PATTERN="${SUSPICIOUS_PATTERN:-99d2fn0axx|/go/cx|/tmp/myfile|/tmp/\\.sys_agent|main_x86|ssh_scanner|system\\.mark|netstat\\.cfg|gateway\\.sh|bash\\.cfg|xmrig|kinsing|kdevtmpfsi}"
EXPECTED_API_BIND="${EXPECTED_API_BIND:-127.0.0.1:8787}"
SUSPICIOUS_PATTERN="${SUSPICIOUS_PATTERN}|/tmp/d([.0-9]|$)|/tmp/kw0rker|/var/tmp/\.tracker-|systemd-kworkerd|kw0rker|kworkelr|(^|[[:space:]])llda([[:space:]]|$)"
SUSPICIOUS_REMOTE_PATTERN="${SUSPICIOUS_REMOTE_PATTERN:-62\.84\.172\.106|34\.160\.111\.145|34\.117\.59\.81|93\.185\.165\.252|142\.248\.80\.25|194\.147\.101\.167|:25443|:10020|:65111}"
EXPECTED_LOGIN_USERS_REGEX="${EXPECTED_LOGIN_USERS_REGEX:-^(root|ubuntu|lighthouse)$}"
# Provision this root-owned file on a clean host with one expected SHA256 fingerprint per line.
AUTHORIZED_KEYS_BASELINE="${AUTHORIZED_KEYS_BASELINE:-/etc/honglvdeng-authorized-key-fingerprints}"
AUTHORIZED_KEYS_SHA256_BASELINE="${AUTHORIZED_KEYS_SHA256_BASELINE:-/etc/honglvdeng-authorized-keys.sha256}"
DB_PATH="${DB_PATH:-/opt/honglvdeng/data/experiment.db}"
BACKUP_DIR="${BACKUP_DIR:-/opt/honglvdeng/backups}"
EXPECTED_PRELOAD_SHA256="${EXPECTED_PRELOAD_SHA256:-9ba3574dc9c5438751b789941369956aceb58bb39feac0029295821e83720c7f}"

failures=0

section() {
  printf '\n== %s ==\n' "$1"
}

fail() {
  failures=$((failures + 1))
  printf '[FAIL] %s\n' "$1"
}

pass() {
  printf '[OK] %s\n' "$1"
}

section "identity"
hostname
date -Is
whoami

section "network listeners"
listeners="$(ss -tulpn 2>/dev/null || true)"
printf '%s\n' "$listeners"
if printf '%s\n' "$listeners" | grep -q "0.0.0.0:8787\\|\\[::\\]:8787"; then
  fail "API port 8787 is exposed publicly"
elif printf '%s\n' "$listeners" | grep -q "$EXPECTED_API_BIND"; then
  pass "API listens on $EXPECTED_API_BIND"
else
  fail "API listener $EXPECTED_API_BIND was not found"
fi

section "ssh effective settings"
if command -v sshd >/dev/null 2>&1; then
  ssh_effective="$(sshd -T 2>/dev/null || true)"
  printf '%s\n' "$ssh_effective" | grep -E '^(permitrootlogin|passwordauthentication|kbdinteractiveauthentication|pubkeyauthentication|allowusers|allowtcpforwarding|x11forwarding|allowagentforwarding|maxauthtries|maxsessions|maxstartups|logingracetime) ' || true
  printf '%s\n' "$ssh_effective" | grep -q '^passwordauthentication no$' || fail "SSH password authentication is not disabled"
  printf '%s\n' "$ssh_effective" | grep -q '^permitrootlogin no$' || fail "SSH root login is not disabled"
  printf '%s\n' "$ssh_effective" | grep -q '^allowtcpforwarding no$' || fail "SSH TCP forwarding is not disabled"
fi

section "firewall and fail2ban"
if command -v ufw >/dev/null 2>&1; then
  ufw_status="$(ufw status verbose 2>/dev/null || true)"
  printf '%s\n' "$ufw_status"
  printf '%s\n' "$ufw_status" | grep -q '^Status: active$' \
    || fail "UFW is not active"
  printf '%s\n' "$ufw_status" | grep -q '^Default: deny (incoming), deny (outgoing)' \
    || fail "UFW is not default-deny for both incoming and outgoing traffic"
  grep -q '^IPV6=yes$' /etc/default/ufw \
    || fail "UFW IPv6 enforcement is disabled"
else
  fail "UFW is not installed"
fi
if systemctl is-active --quiet fail2ban; then
  pass "fail2ban is active"
  fail2ban-client status sshd 2>/dev/null || true
else
  fail "fail2ban is not active"
fi

section "suspicious processes"
if ps auxww | grep -E "$SUSPICIOUS_PATTERN" | grep -v grep; then
  fail "suspicious process pattern matched"
else
  pass "no suspicious process pattern matched"
fi

section "deleted or temporary executables"
temp_execs="$(
  sh -c '
    for exe in /proc/[0-9]*/exe; do
      target=$(readlink "$exe" 2>/dev/null) || continue
      case "$target" in
        /tmp/*|/var/tmp/*|/dev/shm/*)
          printf "%s -> %s\n" "$exe" "$target"
          ;;
      esac
    done
  ' 2>/dev/null || true
)"
if [[ -n "$temp_execs" ]]; then
  printf '%s\n' "$temp_execs"
  fail "process is executing from a temporary directory"
else
  pass "no process executable is rooted in a temporary directory"
fi

deleted_execs="$(
  sh -c '
    for exe in /proc/[0-9]*/exe; do
      target=$(readlink "$exe" 2>/dev/null) || continue
      case "$target" in
        *" (deleted)") printf "%s -> %s\n" "$exe" "$target" ;;
      esac
    done
  ' 2>/dev/null || true
)"
if [[ -n "$deleted_execs" ]]; then
  printf '%s\n' "$deleted_execs"
  fail "deleted executable is still running"
else
  pass "no deleted executable is still running"
fi

section "expanded suspicious files"
expanded_file_report="$(
  find /tmp /var/tmp /dev/shm /go /home/ubuntu /usr/lib/systemd \
    -xdev -maxdepth 3 -type f \
    \( -name 'd' -o -name 'd.[0-9]*' -o -name '.sys_agent' -o -name 'myfile' \
       -o -name 'kw0rker' -o -name 'kworkelr' -o -name 'systemd-kworkerd' \
       -o -name 'cx' -o -name 'ali.txt' -o -name 'main_x86*' -o -name '*ssh_scanner*' \) \
    -printf '%TY-%Tm-%Td %TH:%TM %u %g %m %s %p\n' 2>/dev/null || true
)"
if [[ -n "$expanded_file_report" ]]; then
  printf '%s\n' "$expanded_file_report"
  fail "expanded suspicious file pattern matched"
else
  pass "no expanded suspicious file pattern matched"
fi

exact_ioc_report="$(
  for suspicious_file in \
    /usr/bin/adb /usr/bin/adb0 /usr/bin/aa0 /usr/bin/aaa \
    /home/ubuntu/zjl6 /go/cx /go/ali.txt \
    /boot/system.pub /etc/profile.d/bash.cfg /usr/lib/system.mark \
    /usr/lib/libgdi.so.0.8.2 \
    /usr/lib/systemd/systemd-kworkerd \
    /tmp/.sys_agent /tmp/d /tmp/d.1 /tmp/d.1.1 /tmp/d.2 /tmp/d.2.1 \
    /tmp/myfile /tmp/kw0rker /tmp/.ssh_scanner_installed /tmp/ssh_scanner.lock \
    /usr/sbin/netstat.cfg /home/ubuntu/authorized_keys; do
    if test -e "$suspicious_file"; then
      printf '%s\n' "$suspicious_file"
    fi
  done
)"
if [[ -n "$exact_ioc_report" ]]; then
  printf '%s\n' "$exact_ioc_report"
  fail "an exact incident IOC path exists"
else
  pass "exact incident IOC paths are absent"
fi

section "suspicious files"
tmp_report="/tmp/honglvdeng-security-files.$$"
if find /tmp /var/tmp /dev/shm /home/ubuntu -xdev -maxdepth 3 -type f \
  \( -name '.sys_agent' -o -name 'myfile' -o -name 'main_x86*' -o -name '*ssh_scanner*' \) \
  -printf '%TY-%Tm-%Td %TH:%TM %u %g %m %s %p\n' 2>/dev/null | tee "$tmp_report" | grep -q .; then
  fail "suspicious file pattern matched"
else
  pass "no suspicious file pattern matched"
fi
rm -f "$tmp_report"

section "persistence grep"
if find /etc/systemd/system /lib/systemd/system /etc/init.d /etc/profile.d /etc/cron.d /var/spool/cron/crontabs \
  -maxdepth 3 -type f -print0 2>/dev/null \
  | xargs -0 grep -InE "$SUSPICIOUS_PATTERN" 2>/dev/null \
  ; then
  fail "suspicious persistence pattern matched"
else
  pass "no suspicious persistence pattern matched"
fi

if grep -En '/usr/sbin/netstat\.cfg|/go/cx|systemd-kworkerd|/tmp/\.sys_agent' \
  /etc/rc.local 2>/dev/null; then
  fail "/etc/rc.local contains incident persistence"
else
  pass "/etc/rc.local has no known incident persistence"
fi

for malicious_unit in \
  euk0y9fxni.service piy2qc94vp.service y1sam0rvtu.service \
  systemd-kworkerd.service systemd-kworkerd.timer; do
  unit_state="$(systemctl is-enabled "$malicious_unit" 2>&1 || true)"
  case "$unit_state" in
    not-found|masked|masked-runtime) ;;
    *) fail "$malicious_unit has unsafe enablement state: $unit_state" ;;
  esac
  if systemctl is-active --quiet "$malicious_unit"; then
    fail "$malicious_unit is active"
  fi
done

section "root cron integrity"
root_cron="$(crontab -u root -l 2>/dev/null || true)"
printf '%s\n' "$root_cron"
if printf '%s\n' "$root_cron" | grep -E "$SUSPICIOUS_PATTERN"; then
  fail "root crontab contains a suspicious command"
else
  pass "root crontab has no known suspicious command"
fi

cron_enabled="$(systemctl is-enabled cron.service 2>&1 || true)"
cron_active="$(systemctl is-active cron.service 2>&1 || true)"
if [[ "$cron_enabled" == "disabled" && "$cron_active" == "inactive" ]]; then
  pass "cron service remains disabled and inactive"
else
  fail "cron service state changed: enabled=$cron_enabled active=$cron_active"
fi

duplicate_cron="$(
  printf '%s\n' "$root_cron" \
    | sed '/^[[:space:]]*#/d; /^[[:space:]]*$/d' \
    | sort \
    | uniq -d \
    || true
)"
if [[ -n "$duplicate_cron" ]]; then
  printf '%s\n' "$duplicate_cron"
  fail "root crontab contains duplicate entries"
else
  pass "root crontab has no duplicate entries"
fi

section "systemd unit permissions"
world_writable_units="$(
  find /etc/systemd/system /lib/systemd/system -xdev -type f -perm -0002 \
    -printf '%m %u %g %p\n' 2>/dev/null || true
)"
if [[ -n "$world_writable_units" ]]; then
  printf '%s\n' "$world_writable_units"
  fail "world-writable systemd unit file found"
else
  pass "systemd unit files are not world-writable"
fi

section "accounts"
uid_zero_accounts="$(awk -F: '$3 == 0 {print $1}' /etc/passwd)"
if [[ "$uid_zero_accounts" != "root" ]]; then
  printf '%s\n' "$uid_zero_accounts"
  fail "unexpected UID 0 account found"
else
  pass "root is the only UID 0 account"
fi

unexpected_login_accounts="$(
  awk -F: '$7 !~ /(nologin|false|sync|shutdown|halt)$/ {print $1}' /etc/passwd \
    | grep -Ev "$EXPECTED_LOGIN_USERS_REGEX" \
    || true
)"
if [[ -n "$unexpected_login_accounts" ]]; then
  printf '%s\n' "$unexpected_login_accounts"
  fail "unexpected interactive login account found"
else
  pass "interactive login accounts match the expected set"
fi

for locked_account in root ubuntu lighthouse; do
  account_state="$(passwd -S "$locked_account" 2>/dev/null | awk '{print $2}')"
  if [[ "$account_state" == "L" ]]; then
    pass "$locked_account password is locked"
  else
    fail "$locked_account password is not locked"
  fi
done

if id -nG ubuntu | tr ' ' '\n' | grep -qx lxd; then
  fail "ubuntu unexpectedly regained membership in the root-equivalent lxd group"
else
  pass "ubuntu is not a member of the lxd group"
fi

if getent passwd admin >/dev/null; then
  fail "incident-created admin account exists"
else
  pass "incident-created admin account is absent"
fi

api_shell="$(getent passwd honglvdeng-api | awk -F: '{print $7}')"
if [[ "$api_shell" == "/usr/sbin/nologin" ]]; then
  pass "dedicated API account has a non-login shell"
else
  fail "dedicated API account has unexpected shell: ${api_shell:-missing}"
fi

section "cloud agent code permissions"
cloud_writable_code="$(
  find /usr/local/qcloud /usr/local/sa -xdev -type f -perm /0022 \
    \( -perm /0111 -o -name '*.sh' -o -name '*.py' \) \
    -printf '%m %u:%g %p\n' 2>/dev/null || true
)"
if [[ -n "$cloud_writable_code" ]]; then
  printf '%s\n' "$cloud_writable_code"
  fail "Tencent agent executable code is group- or world-writable"
else
  pass "Tencent agent executable code is not group- or world-writable"
fi

section "authorized key fingerprints"
actual_key_fingerprints="$(
  while IFS= read -r key_file; do
    ssh-keygen -lf "$key_file" 2>/dev/null | awk '{print $2}' || true
  done < <(
    find /root/.ssh /home -xdev \
      \( -name authorized_keys -o -name authorized_keys2 \) -type f -print 2>/dev/null
  )
)"
actual_key_fingerprints="$(printf '%s\n' "$actual_key_fingerprints" | sed '/^$/d' | sort -u)"
printf '%s\n' "$actual_key_fingerprints"
if test -f "$AUTHORIZED_KEYS_BASELINE"; then
  expected_key_fingerprints="$(
    sed 's/[[:space:]]*#.*$//; /^[[:space:]]*$/d' "$AUTHORIZED_KEYS_BASELINE" \
      | sort -u
  )"
  if [[ "$actual_key_fingerprints" == "$expected_key_fingerprints" ]]; then
    pass "authorized key fingerprints match the baseline"
  else
    fail "authorized key fingerprints differ from $AUTHORIZED_KEYS_BASELINE"
  fi
else
  fail "authorized key fingerprint baseline is missing: $AUTHORIZED_KEYS_BASELINE"
fi

if test -f "$AUTHORIZED_KEYS_SHA256_BASELINE"; then
  actual_keys_sha256="$(sha256sum /home/ubuntu/.ssh/authorized_keys | awk '{print $1}')"
  expected_keys_sha256="$(awk 'NF {print $1; exit}' "$AUTHORIZED_KEYS_SHA256_BASELINE")"
  if [[ "$actual_keys_sha256" == "$expected_keys_sha256" ]]; then
    pass "full authorized_keys content matches the SHA256 baseline"
  else
    fail "full authorized_keys content differs from the SHA256 baseline"
  fi
else
  fail "authorized_keys SHA256 baseline is missing: $AUTHORIZED_KEYS_SHA256_BASELINE"
fi

section "cloud execution audit preload"
if [[ "$(cat /etc/ld.so.preload 2>/dev/null || true)" == '/$LIB/libonion.so' ]] \
  && [[ "$(sha256sum /usr/lib/x86_64-linux-gnu/libonion.so 2>/dev/null | awk '{print $1}')" == "$EXPECTED_PRELOAD_SHA256" ]]; then
  pass "Tencent execution-audit preload matches the incident baseline"
else
  fail "system-wide dynamic linker preload differs from the reviewed Tencent baseline"
fi

section "suspicious outbound connections"
established_connections="$(ss -H -ntup state established 2>/dev/null || true)"
printf '%s\n' "$established_connections"
if printf '%s\n' "$established_connections" \
  | grep -E "$SUSPICIOUS_REMOTE_PATTERN|users:\(\(\"(cx|kw0rker|kworkelr)\""; then
  fail "known suspicious outbound connection matched"
else
  pass "no known suspicious outbound connection matched"
fi

if iptables-save | grep -Eq 'HLD_ACME_(IR_20260715|RENEW)' \
  || ip6tables-save | grep -Eq 'HLD_ACME_(IR_20260715|RENEW)'; then
  fail "an ACME maintenance firewall window remained open"
else
  pass "no ACME maintenance firewall window remained open"
fi

section "nginx"
if command -v nginx >/dev/null 2>&1; then
  nginx -t
  if nginx -T 2>/dev/null | grep -q 'limit_req_zone .*honglvdeng_api_submissions'; then
    pass "nginx API submission rate limit is configured"
  else
    fail "nginx API submission rate limit is missing"
  fi
  nginx_dump="$(nginx -T 2>/dev/null || true)"
  if [[ "$(printf '%s\n' "$nginx_dump" | grep -c 'proxy_pass http://127\.0\.0\.1:8787')" -eq 2 ]] \
    && ! printf '%s\n' "$nginx_dump" | grep -q 'proxy_pass http://127\.0\.0\.1:8788'; then
    pass "nginx routes the two live API locations to systemd port 8787"
  else
    fail "nginx API upstream differs from the reviewed systemd port 8787 baseline"
  fi
  if [[ "$(printf '%s\n' "$nginx_dump" | grep -c 'proxy_set_header X-Forwarded-For \$remote_addr')" -eq 2 ]] \
    && ! printf '%s\n' "$nginx_dump" | grep -q '\$proxy_add_x_forwarded_for'; then
    pass "nginx overwrites client-supplied X-Forwarded-For"
  else
    fail "nginx trusted proxy header baseline changed"
  fi
fi

section "collection continuity"
if systemctl is-active --quiet honglvdeng-api@8787.service \
  && systemctl is-enabled --quiet honglvdeng-api@8787.service; then
  api_user="$(systemctl show honglvdeng-api@8787.service -p User --value)"
  if [[ "$api_user" == "honglvdeng-api" ]]; then
    pass "systemd API is active, enabled, and runs as the dedicated user"
  else
    fail "systemd API runs as unexpected user: $api_user"
  fi
else
  fail "systemd API is not both active and enabled"
fi

if pgrep -af 'PM2 .*God Daemon|npm run start:api' 2>/dev/null; then
  fail "legacy PM2 API process returned"
else
  pass "legacy PM2 API process is absent"
fi

health_body="$(curl -fsS --max-time 5 http://127.0.0.1:8787/api/health 2>/dev/null || true)"
if [[ "$health_body" == *'"ok":true'* ]]; then
  pass "loopback API health check passed"
else
  fail "loopback API health check failed"
fi

for allowed_origin in \
  https://ucdn.credamo.com \
  https://credamo-imgfile.oss-cn-beijing.aliyuncs.com; do
  options_code="$(curl -sS --max-time 5 -o /dev/null -w '%{http_code}' \
    -X OPTIONS -H "Origin: $allowed_origin" \
    -H 'Access-Control-Request-Method: POST' \
    -H 'Access-Control-Request-Headers: content-type' \
    http://127.0.0.1:8787/api/submissions 2>/dev/null || true)"
  if [[ "$options_code" == "204" ]]; then
    pass "CORS preflight passed for $allowed_origin"
  else
    fail "CORS preflight failed for $allowed_origin: HTTP ${options_code:-error}"
  fi
done

db_check="$(runuser -u honglvdeng-api -- sqlite3 -readonly "$DB_PATH" 'PRAGMA quick_check;' 2>/dev/null || true)"
if [[ "$db_check" == "ok" ]]; then
  pass "SQLite quick_check passed"
else
  fail "SQLite quick_check failed: $db_check"
fi

latest_backup="$(find "$BACKUP_DIR" -maxdepth 1 -type f -name 'experiment_*.db' \
  -printf '%T@ %p\n' 2>/dev/null | sort -nr | head -1 | cut -d ' ' -f 2-)"
if [[ -n "$latest_backup" ]]; then
  backup_age=$(( $(date +%s) - $(stat -c %Y "$latest_backup") ))
  backup_check="$(sqlite3 "file:${latest_backup}?mode=ro&immutable=1" 'PRAGMA quick_check;' 2>/dev/null || true)"
  if sha256sum -c "$latest_backup.sha256" >/dev/null 2>&1; then
    backup_hash=ok
  else
    backup_hash=failed
  fi
  if (( backup_age <= 600 )) && [[ "$backup_check" == "ok" && "$backup_hash" == "ok" ]]; then
    pass "latest SQLite backup is fresh and verified (${backup_age}s old)"
  else
    fail "latest SQLite backup validation failed: age=${backup_age}s quick_check=${backup_check:-empty} hash=$backup_hash path=$latest_backup"
  fi
else
  fail "no automated SQLite backup was found"
fi

root_used_percent="$(df -P /opt/honglvdeng/data | awk 'NR==2 {gsub(/%/, "", $5); print $5}')"
if [[ "$root_used_percent" =~ ^[0-9]+$ ]] && (( root_used_percent < 85 )); then
  pass "filesystem usage is below 85% (${root_used_percent}%)"
else
  fail "filesystem usage is too high: ${root_used_percent:-unknown}%"
fi

section "TLS continuity"
live_certificate=/etc/letsencrypt/live/experiments.top/fullchain.pem
if openssl x509 -checkend 2592000 -noout -in "$live_certificate" >/dev/null 2>&1; then
  pass "TLS certificate remains valid for more than 30 days"
else
  fail "TLS certificate is missing or expires within 30 days"
fi

certificate_text="$(openssl x509 -in "$live_certificate" -noout -ext subjectAltName 2>/dev/null || true)"
for tls_name in experiments.top www.experiments.top m.experiments.top; do
  if printf '%s\n' "$certificate_text" | grep -q "DNS:$tls_name"; then
    pass "TLS SAN covers $tls_name"
  else
    fail "TLS SAN does not cover $tls_name"
  fi
done

if systemctl is-enabled --quiet certbot.timer && systemctl is-active --quiet certbot.timer; then
  pass "controlled Certbot renewal timer is enabled and active"
else
  fail "Certbot renewal timer is not enabled and active"
fi

section "summary"
if (( failures > 0 )); then
  printf 'security audit found %s issue(s)\n' "$failures"
  exit 1
fi

printf 'security audit passed\n'
