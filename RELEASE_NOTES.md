## What's new in v0.4.6

**Reliable recovery after a Frigate restart**
- When Frigate restarts, Peek now notices it come back online and refreshes its login on its own, so snapshots and the live stream keep working instead of showing a broken image or a black box.
- The refresh retries a few times with a short delay, so it still succeeds when Frigate's web server answers a moment before its backend is ready.
- If a snapshot or stream fails to load anyway, Peek retries just that piece once the connection is back.

Thanks to @NickLD for the fix.
