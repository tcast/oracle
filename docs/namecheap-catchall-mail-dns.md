# Namecheap catchall mail DNS (Whisper)

Catch-all mail for Whisper lands in `pool@proteusmail.net` on Hetzner
`mail.proteusmail.net` (`5.161.249.232`).

## Domains (31)

Same set as `/opt/mail` `postfix-virtual.cf` and
`backend/src/services/domainMailPoolService.js` (plus brand-sensitive skips
still hosted for catchall):

bashed.net, casinoadvertiser.com, college-tuition.net, excusecreator.com,
faregiant.com, guitarsessions.net, fullfunnel.net, ihotelsearch.com,
justfucked.com, ketchupbuddy.com, myrun.me, n78mr.com, new-school.net,
nutritional-food.com, paradisepictures.net, payday-direct.com, potionkits.com,
proteusmail.net, replicashop.net, respondcx.com, retain360.io, shutookus.com,
somaliapirates.com, starpirate.com, steel-building.net, tastycoeds.com,
topagency.net, toymakers.net, united-loans.com, usgeek.com, uspunk.com

## Required DNS (per domain)

| Record | Value |
|--------|--------|
| Nameservers | Namecheap Basic DNS (`dns1/dns2.registrar-servers.com`) |
| MX `@` | `mail.proteusmail.net` priority 10 |
| TXT `@` | `v=spf1 mx a:mail.proteusmail.net ip4:5.161.249.232 ~all` |
| TXT `mail._domainkey` | DKIM pubkey from mail VPS (`mail` selector) |
| TXT `_dmarc` | `v=DMARC1; p=none; rua=mailto:pool@proteusmail.net` |
| A `mail` (proteusmail.net only) | `5.161.249.232` |

## Namecheap API

- Must run from whitelisted ClientIp **`73.144.90.243`** (`tcast-ai`), not a laptop
  with a different egress IP.
- Credentials via env only (never commit):
  - `NAMECHEAP_API_USER`
  - `NAMECHEAP_API_KEY`
  - `NAMECHEAP_CLIENT_IP=73.144.90.243`

```bash
# On tcast-ai:
export NAMECHEAP_API_USER=tcast
export NAMECHEAP_API_KEY=...   # from secrets
export NAMECHEAP_CLIENT_IP=73.144.90.243
export MAIL_HOSTNAME=mail.proteusmail.net
export MAIL_SERVER_IP=5.161.249.232
# optional: JSON map of domain -> DKIM TXT value
export DKIM_KEYS_JSON=/tmp/dkim-keys.json

python3 backend/src/scripts/ensure-namecheap-mail-dns.py --audit-only
python3 backend/src/scripts/ensure-namecheap-mail-dns.py --set-default-ns --set-hosts
```

Namecheap API `ProviderType=FREE` + `IsUsingOurDNS=true` with
`*.registrar-servers.com` NS == **Basic DNS** in the Namecheap UI.

## Verify

```bash
dig +short DOMAIN NS
dig +short DOMAIN MX    # expect: 10 mail.proteusmail.net.
dig +short DOMAIN TXT | grep spf
dig +short mail._domainkey.DOMAIN TXT
dig +short _dmarc.DOMAIN TXT
```

Delivery probe (from mail VPS; Comcast blocks outbound :25 from tcast-ai):

```bash
# on 5.161.249.232
python3 /tmp/nc-mx-probe-localhost.py
# on tcast-ai
python3 /tmp/nc-imap-list.py --token TOKEN
```

## Notes

- Reddit/Yahoo/etc. deliver to these catchalls once MX is correct; Amavis on the
  mail VPS rejects messages missing required headers (e.g. `Date`).
- Do not commit API keys or `MAIL_POOL_PASS`.
