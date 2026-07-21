#!/usr/bin/env python3
"""List recent pool IMAP headers; optional --token filter."""
from __future__ import annotations

import argparse
import email
import imaplib
import ssl
from pathlib import Path

p = argparse.ArgumentParser()
p.add_argument("--token", default="")
p.add_argument("--limit", type=int, default=20)
args = p.parse_args()

env = {}
for line in Path("/home/tcast/Sites/whisper/backend/.env").read_text().splitlines():
    line = line.strip()
    if not line or line.startswith("#") or "=" not in line:
        continue
    k, v = line.split("=", 1)
    env[k.strip()] = v.strip().strip('"').strip("'")

ctx = ssl.create_default_context()
ctx.check_hostname = False
ctx.verify_mode = ssl.CERT_NONE
host = env.get("MAIL_IMAP_IP") or env["MAIL_IMAP_HOST"]
M = imaplib.IMAP4_SSL(host, int(env.get("MAIL_IMAP_PORT") or 993), ssl_context=ctx)
M.login(env["MAIL_POOL_USER"], env["MAIL_POOL_PASS"])
M.select("INBOX")
typ, data = M.search(None, "ALL")
ids = data[0].split() if data and data[0] else []
print(f"inbox_count={len(ids)}")
hits = 0
for i in ids[-args.limit :]:
    typ, msgdata = M.fetch(i, "(RFC822.HEADER)")
    em = email.message_from_bytes(msgdata[0][1])
    subj = em.get("Subject", "")
    to = em.get("To", "")
    frm = em.get("From", "")
    blob = f"{subj} {to} {frm}"
    if args.token and args.token not in blob:
        continue
    hits += 1
    print("---")
    print(f"Subject: {subj}")
    print(f"To: {to}")
    print(f"From: {frm}")
    print(f"Date: {em.get('Date')}")
print(f"shown={hits}")
M.logout()
