#!/usr/bin/env bash
set -euo pipefail

SUSPICIOUS_PATTERN="${SUSPICIOUS_PATTERN:-99d2fn0axx|/go/cx|/tmp/myfile|/tmp/\\.sys_agent|main_x86|ssh_scanner|system\\.mark|netstat\\.cfg|gateway\\.sh|bash\\.cfg|xmrig|kinsing|kdevtmpfsi}"
EXPECTED_API_BIND="${EXPECTED_API_BIND:-127.0.0.1:8787}"

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
  ssh_effective="$(sudo -n sshd -T 2>/dev/null || sshd -T 2>/dev/null || true)"
  printf '%s\n' "$ssh_effective" | grep -E '^(permitrootlogin|passwordauthentication|kbdinteractiveauthentication|pubkeyauthentication|allowusers|allowtcpforwarding|x11forwarding|allowagentforwarding|maxauthtries|maxsessions|maxstartups|logingracetime) ' || true
  printf '%s\n' "$ssh_effective" | grep -q '^passwordauthentication no$' || fail "SSH password authentication is not disabled"
  printf '%s\n' "$ssh_effective" | grep -q '^permitrootlogin no$' || fail "SSH root login is not disabled"
  printf '%s\n' "$ssh_effective" | grep -q '^allowtcpforwarding no$' || fail "SSH TCP forwarding is not disabled"
fi

section "firewall and fail2ban"
if command -v ufw >/dev/null 2>&1; then
  sudo -n ufw status verbose || true
fi
if systemctl is-active --quiet fail2ban; then
  pass "fail2ban is active"
  sudo -n fail2ban-client status sshd 2>/dev/null || true
else
  fail "fail2ban is not active"
fi

section "suspicious processes"
if ps auxww | grep -E "$SUSPICIOUS_PATTERN" | grep -v grep; then
  fail "suspicious process pattern matched"
else
  pass "no suspicious process pattern matched"
fi

section "suspicious files"
tmp_report="/tmp/honglvdeng-security-files.$$"
if sudo -n find /tmp /var/tmp /dev/shm /home/ubuntu -xdev -maxdepth 3 -type f \
  \( -name '.sys_agent' -o -name 'myfile' -o -name 'main_x86*' -o -name '*ssh_scanner*' \) \
  -printf '%TY-%Tm-%Td %TH:%TM %u %g %m %s %p\n' 2>/dev/null | tee "$tmp_report" | grep -q .; then
  fail "suspicious file pattern matched"
else
  pass "no suspicious file pattern matched"
fi
rm -f "$tmp_report"

section "persistence grep"
if sudo -n find /etc/systemd/system /lib/systemd/system /etc/init.d /etc/profile.d /etc/cron.d /var/spool/cron/crontabs \
  -maxdepth 3 -type f -print0 2>/dev/null \
  | sudo -n xargs -0 grep -InE "$SUSPICIOUS_PATTERN" 2>/dev/null \
  | grep -v '/etc/profile.d/go_conf.sh'; then
  fail "suspicious persistence pattern matched"
else
  pass "no suspicious persistence pattern matched"
fi

section "nginx"
if command -v nginx >/dev/null 2>&1; then
  sudo -n nginx -t
  if sudo -n nginx -T 2>/dev/null | grep -q 'limit_req_zone .*honglvdeng_api_submissions'; then
    pass "nginx API submission rate limit is configured"
  else
    fail "nginx API submission rate limit is missing"
  fi
fi

section "summary"
if (( failures > 0 )); then
  printf 'security audit found %s issue(s)\n' "$failures"
  exit 1
fi

printf 'security audit passed\n'
