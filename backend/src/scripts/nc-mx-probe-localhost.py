#!/usr/bin/env python3
"""Send inbound catchall probes from the mail VPS (localhost:25) with full headers."""
from __future__ import annotations

import subprocess
import time
import uuid
from email.message import EmailMessage
from email.utils import formatdate, make_msgid
import smtplib

token = uuid.uuid4().hex[:12]
domains = ["bashed.net", "faregiant.com", "retain360.io"]
recipients = [f"dnstest-{token}@{d}" for d in domains]
prefix = f"NC-MX-TEST {token}"
print(f"token={token}")

for rcpt in recipients:
    msg = EmailMessage()
    msg["From"] = "probe@proteusmail.net"
    msg["To"] = rcpt
    msg["Subject"] = f"{prefix} -> {rcpt}"
    msg["Date"] = formatdate(localtime=True)
    msg["Message-ID"] = make_msgid(domain="mail.proteusmail.net")
    msg.set_content(f"catchall MX delivery test for {rcpt}\ntoken={token}\n")
    with smtplib.SMTP("127.0.0.1", 25, timeout=30) as s:
        s.ehlo("probe.local")
        s.sendmail("probe@proteusmail.net", [rcpt], msg.as_string())
    print(f"SENT {rcpt}")

print("waiting 12s")
time.sleep(12)
subprocess.call(
    f'docker logs --tail 80 mailserver 2>&1 | grep -E "{token}|dnstest-{token}|Blocked BAD|status=sent \\(250 2\\.0\\.0" | tail -40',
    shell=True,
)
print(f"TOKEN={token}")
