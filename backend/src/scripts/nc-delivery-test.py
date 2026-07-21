#!/usr/bin/env python3
"""Probe catchall delivery via inbound SMTP (port 25 / MX path) + pool IMAP."""
from __future__ import annotations

import email
import json
import ssl
import time
import uuid
import imaplib
import smtplib
from email.message import EmailMessage
from pathlib import Path

env = {}
for line in Path("/home/tcast/Sites/whisper/backend/.env").read_text().splitlines():
    line = line.strip()
    if not line or line.startswith("#") or "=" not in line:
        continue
    k, v = line.split("=", 1)
    env[k.strip()] = v.strip().strip('"').strip("'")

pool_user = env["MAIL_POOL_USER"]
pool_pass = env["MAIL_POOL_PASS"]
imap_host = env.get("MAIL_IMAP_IP") or env.get("MAIL_IMAP_HOST")
imap_port = int(env.get("MAIL_IMAP_PORT") or 993)
mx_host = env.get("MAIL_IMAP_HOST") or "mail.proteusmail.net"

token = uuid.uuid4().hex[:12]
domains = ["bashed.net", "faregiant.com", "retain360.io"]
recipients = [f"dnstest-{token}@{d}" for d in domains]
subject_prefix = f"NC-MX-TEST {token}"

ctx = ssl.create_default_context()
ctx.check_hostname = False
ctx.verify_mode = ssl.CERT_NONE

print(f"token={token}")
print(f"inbound SMTP {mx_host}:25 (MX path)")

for rcpt in recipients:
    msg = EmailMessage()
    msg["From"] = f"external-probe@{token}.invalid"
    msg["To"] = rcpt
    msg["Subject"] = f"{subject_prefix} -> {rcpt}"
    msg["Message-ID"] = f"<{token}.{uuid.uuid4().hex}@probe.local>"
    msg.set_content(f"catchall MX delivery test for {rcpt}\ntoken={token}\n")
    # Unauthenticated inbound on 25 — exercises MX destination acceptance
    with smtplib.SMTP(mx_host, 25, timeout=60) as s:
        s.ehlo()
        s.send_message(msg)
    print(f"SENT {rcpt}")

print("waiting 15s...")
time.sleep(15)

M = imaplib.IMAP4_SSL(imap_host, imap_port, ssl_context=ctx)
M.login(pool_user, pool_pass)
M.select("INBOX")
typ, data = M.search(None, "ALL")
ids = data[0].split() if data and data[0] else []
found = set()
for i in ids[-50:]:
    typ, msgdata = M.fetch(i, "(RFC822.HEADER)")
    raw = msgdata[0][1]
    em = email.message_from_bytes(raw)
    blob = " ".join(
        [
            em.get("Subject", ""),
            em.get("To", ""),
            em.get("Delivered-To", ""),
            em.get("X-Original-To", ""),
        ]
    )
    if token in blob or subject_prefix in blob:
        print(f"HIT id={i.decode()} Subject={em.get('Subject')} To={em.get('To')}")
        for r in recipients:
            if r.lower() in blob.lower() or r.split("@")[0] in blob.lower():
                found.add(r)

print("RESULTS:")
for r in recipients:
    print(f"  {r}: {'DELIVERED' if r in found else 'MISSING'}")
print(f"delivered={len(found)}/{len(recipients)}")
Path("/tmp/nc-delivery-test.json").write_text(
    json.dumps(
        {"token": token, "recipients": recipients, "found": list(found), "delivered": len(found)},
        indent=2,
    )
)
M.logout()
