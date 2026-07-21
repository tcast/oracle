#!/usr/bin/env python3
"""
Ensure Whisper catchall domains use Namecheap Basic DNS + mail records.

Must run from the Namecheap API ClientIp whitelist (tcast-ai / 73.144.90.243).

Env (required):
  NAMECHEAP_API_USER
  NAMECHEAP_API_KEY
  NAMECHEAP_CLIENT_IP   (default 73.144.90.243)

Optional:
  MAIL_HOSTNAME         (default mail.proteusmail.net)
  MAIL_SERVER_IP        (default 5.161.249.232)
  DKIM_KEYS_JSON        path to {domain: "v=DKIM1; ..."} map
                        (or pull from mail VPS /opt/mail/.../opendkim/keys/*/mail.txt)

Usage:
  python3 ensure-namecheap-mail-dns.py [--audit-only] [--set-default-ns] [--set-hosts]
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET

API = "https://api.namecheap.com/xml.response"
NS = "{http://api.namecheap.com/xml.response}"

# Keep in sync with domainMailPoolService + /opt/mail postfix-virtual.cf
DOMAINS = [
    "bashed.net",
    "casinoadvertiser.com",
    "college-tuition.net",
    "excusecreator.com",
    "faregiant.com",
    "guitarsessions.net",
    "fullfunnel.net",
    "ihotelsearch.com",
    "justfucked.com",
    "ketchupbuddy.com",
    "myrun.me",
    "n78mr.com",
    "new-school.net",
    "nutritional-food.com",
    "paradisepictures.net",
    "payday-direct.com",
    "potionkits.com",
    "proteusmail.net",
    "replicashop.net",
    "respondcx.com",
    "retain360.io",
    "shutookus.com",
    "somaliapirates.com",
    "starpirate.com",
    "steel-building.net",
    "tastycoeds.com",
    "topagency.net",
    "toymakers.net",
    "united-loans.com",
    "usgeek.com",
    "uspunk.com",
]

BASIC_NS = ["dns1.registrar-servers.com", "dns2.registrar-servers.com"]


def split_domain(domain: str) -> tuple[str, str]:
    parts = domain.split(".")
    if len(parts) < 2:
        raise ValueError(domain)
    return ".".join(parts[:-1]), parts[-1]


def api(command: str, extra: dict, retries: int = 6) -> ET.Element:
    user = os.environ["NAMECHEAP_API_USER"]
    key = os.environ["NAMECHEAP_API_KEY"]
    client_ip = os.environ.get("NAMECHEAP_CLIENT_IP", "73.144.90.243")
    params = {
        "ApiUser": user,
        "ApiKey": key,
        "UserName": user,
        "ClientIp": client_ip,
        "Command": command,
        **extra,
    }
    url = API + "?" + urllib.parse.urlencode(params)
    last_err = None
    for attempt in range(retries):
        with urllib.request.urlopen(url, timeout=90) as resp:
            root = ET.fromstring(resp.read())
        if root.attrib.get("Status") == "OK":
            return root
        errs = [e.text for e in root.findall(f".//{NS}Error")]
        msg = " ".join(x for x in errs if x) or ET.tostring(root)[:400].decode()
        last_err = msg
        if "Too many" in msg:
            time.sleep(10 * (attempt + 1))
            continue
        raise RuntimeError(f"{command}: {msg}")
    raise RuntimeError(f"{command}: {last_err}")


def parse_dkim_txt(path: str) -> str:
    raw = open(path).read()
    parts = re.findall(r'"([^"]+)"', raw)
    return "".join(parts)


def load_dkim_map(path: str | None) -> dict[str, str]:
    if not path:
        return {}
    data = json.load(open(path))
    if not isinstance(data, dict):
        raise ValueError("DKIM_KEYS_JSON must be an object")
    return {k.lower(): v for k, v in data.items()}


def get_info(domain: str) -> dict:
    root = api("namecheap.domains.getInfo", {"DomainName": domain})
    dns = root.find(f".//{NS}DnsDetails")
    return {
        "ProviderType": dns.attrib.get("ProviderType") if dns is not None else "?",
        "IsUsingOurDNS": dns.attrib.get("IsUsingOurDNS") if dns is not None else "?",
        "NS": [n.text for n in dns.findall(f"{NS}Nameserver") if n.text] if dns is not None else [],
    }


def get_hosts(domain: str) -> list[dict]:
    sld, tld = split_domain(domain)
    root = api("namecheap.domains.dns.getHosts", {"SLD": sld, "TLD": tld})
    out = []
    for h in root.findall(f".//{NS}host"):
        out.append(
            {
                "Type": h.attrib.get("Type"),
                "Name": h.attrib.get("Name"),
                "Address": h.attrib.get("Address"),
                "MXPref": h.attrib.get("MXPref") or "10",
                "TTL": h.attrib.get("TTL") or "1800",
            }
        )
    return out


def set_default_ns(domain: str) -> None:
    """Switch domain to Namecheap Basic DNS (default nameservers)."""
    sld, tld = split_domain(domain)
    api("namecheap.domains.dns.setDefault", {"SLD": sld, "TLD": tld})


def set_mail_hosts(
    domain: str,
    *,
    mail_hostname: str,
    mail_ip: str,
    dkim: str | None,
    preserve_other: bool = True,
) -> None:
    sld, tld = split_domain(domain)
    existing = get_hosts(domain) if preserve_other else []

    # Drop old mail-related records we manage; keep unrelated A/CNAME/TXT/etc.
    managed_names = {"@", "mail", "mail._domainkey", "_dmarc"}
    kept = []
    for h in existing:
        name = (h["Name"] or "@").lower()
        typ = (h["Type"] or "").upper()
        addr = (h["Address"] or "").lower()
        if typ == "MX":
            continue
        if name in managed_names and typ in ("TXT", "A", "AAAA") and (
            name != "@"
            or "v=spf1" in addr
            or "v=dmarc1" in addr
            or name in ("mail", "mail._domainkey", "_dmarc")
        ):
            # replace SPF on @ as well
            if name == "@" and typ == "TXT" and "v=spf1" in addr:
                continue
            if name in ("mail._domainkey", "_dmarc"):
                continue
            if name == "mail" and typ in ("A", "AAAA"):
                continue
        # also drop previous SPF we own
        if typ == "TXT" and name == "@" and "v=spf1" in addr:
            continue
        kept.append(h)

    desired = [
        {"Type": "MX", "Name": "@", "Address": mail_hostname, "MXPref": "10", "TTL": "1800"},
        {
            "Type": "TXT",
            "Name": "@",
            "Address": f"v=spf1 mx a:{mail_hostname} ip4:{mail_ip} ~all",
            "MXPref": "10",
            "TTL": "1800",
        },
        {
            "Type": "TXT",
            "Name": "_dmarc",
            "Address": "v=DMARC1; p=none; rua=mailto:pool@proteusmail.net",
            "MXPref": "10",
            "TTL": "1800",
        },
    ]
    # A for mail.<domain> only on proteusmail.net (hostname for all MX targets).
    if domain == "proteusmail.net":
        desired.append(
            {"Type": "A", "Name": "mail", "Address": mail_ip, "MXPref": "10", "TTL": "1800"}
        )
    if dkim:
        desired.append(
            {
                "Type": "TXT",
                "Name": "mail._domainkey",
                "Address": dkim,
                "MXPref": "10",
                "TTL": "1800",
            }
        )

    hosts = kept + desired
    extra = {"SLD": sld, "TLD": tld, "EmailType": "MX"}
    for i, h in enumerate(hosts, start=1):
        extra[f"HostName{i}"] = h["Name"]
        extra[f"RecordType{i}"] = h["Type"]
        extra[f"Address{i}"] = h["Address"]
        extra[f"MXPref{i}"] = h.get("MXPref") or "10"
        extra[f"TTL{i}"] = h.get("TTL") or "1800"
    api("namecheap.domains.dns.setHosts", extra)


def audit(domain: str) -> dict:
    info = get_info(domain)
    hosts = get_hosts(domain)
    mx = [h for h in hosts if h["Type"] == "MX"]
    return {**info, "domain": domain, "MX": mx, "host_count": len(hosts)}


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--audit-only", action="store_true")
    p.add_argument("--set-default-ns", action="store_true", help="Force Namecheap Basic DNS")
    p.add_argument("--set-hosts", action="store_true", help="Set MX/SPF/DKIM/DMARC hosts")
    p.add_argument("--sleep", type=float, default=1.5, help="Delay between API calls")
    args = p.parse_args()

    for req in ("NAMECHEAP_API_USER", "NAMECHEAP_API_KEY"):
        if not os.environ.get(req):
            print(f"Missing env {req}", file=sys.stderr)
            return 2

    mail_hostname = os.environ.get("MAIL_HOSTNAME", "mail.proteusmail.net")
    mail_ip = os.environ.get("MAIL_SERVER_IP", "5.161.249.232")
    dkim_map = load_dkim_map(os.environ.get("DKIM_KEYS_JSON"))

    results = []
    for domain in DOMAINS:
        row = {"domain": domain}
        try:
            before = audit(domain)
            row["before"] = before
            time.sleep(args.sleep)

            if args.set_default_ns:
                using = str(before.get("IsUsingOurDNS", "")).lower() == "true"
                ns_ok = all(
                    any(n.lower().rstrip(".") == b for n in before.get("NS") or [])
                    for b in BASIC_NS
                ) or (
                    using
                    and all("registrar-servers.com" in (n or "").lower() for n in before.get("NS") or [])
                )
                if not using or not ns_ok:
                    set_default_ns(domain)
                    row["set_default_ns"] = True
                    time.sleep(args.sleep)

            if args.set_hosts:
                set_mail_hosts(
                    domain,
                    mail_hostname=mail_hostname,
                    mail_ip=mail_ip,
                    dkim=dkim_map.get(domain),
                )
                row["set_hosts"] = True
                time.sleep(args.sleep)

            if not args.audit_only or args.set_default_ns or args.set_hosts:
                after = audit(domain)
                row["after"] = after
            else:
                row["after"] = before
            row["ok"] = True
        except Exception as e:
            row["ok"] = False
            row["error"] = str(e)
        results.append(row)
        status = "OK" if row.get("ok") else "FAIL"
        after = row.get("after") or row.get("before") or {}
        print(
            f"{status} {domain} Provider={after.get('ProviderType')} "
            f"OurDNS={after.get('IsUsingOurDNS')} MX={after.get('MX')}"
        )
        time.sleep(args.sleep)

    out = "/tmp/nc-mail-dns-ensure-result.json"
    with open(out, "w") as f:
        json.dump(results, f, indent=2)
    failed = [r for r in results if not r.get("ok")]
    print(f"wrote {out}; ok={len(results)-len(failed)} fail={len(failed)}")
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
