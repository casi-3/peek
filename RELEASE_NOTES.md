## What's new in v0.6.0

**HTTPS and reverse proxies**
- Peek now connects to Frigate over HTTPS as a first-class option, including a reverse proxy on port 443 that terminates TLS in front of an otherwise open Frigate. A new "Connect over HTTPS" checkbox in setup makes it independent of login.
- Certificates are verified against your system trust store by default, so a Let's Encrypt deployment works with no extra steps and renews on its own.
- For a Frigate with a self-signed certificate, tick "Allow self-signed certificate" to accept it.

Thanks to @EchterAgo for this.
